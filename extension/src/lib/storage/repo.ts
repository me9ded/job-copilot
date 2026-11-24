import { browser } from 'wxt/browser';
import type { z } from 'zod';
import { createJobRecord, findDuplicate, mergeExtraction, type DuplicateReason } from '../jobs';
import type { JobAnalysis } from '../matching/analysis';
import {
  ApplicationRecord,
  AutofillLogEntry,
  CoverLetter,
  InterviewPrep,
  JobRecord,
  Profile,
  ResumeVersion,
  Settings,
  StoredFile,
  type ApplicationStatus,
  type ExtractedJob,
  type JobOrigin,
  type MatchResult,
} from '../types';
import { nowIso, uid } from '../util';
import { migrateSnapshot } from './migrations';
import { CACHE_KEYS, KEYS, PREFIX, SCHEMA_VERSION } from './schema';

const local = () => browser.storage.local;

/* ----------------------------------------------------------------------------
 * In-context write serialisation. Each extension context (service worker,
 * side panel, popup) serialises its own read-modify-write cycles per key.
 * Records that are written from several contexts use one key per record.
 * ------------------------------------------------------------------------- */
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

async function readKey<S extends z.ZodType>(key: string, schema: S, fallback: () => z.infer<S>): Promise<z.infer<S>> {
  const raw = (await local().get(key))[key];
  if (raw === undefined) return fallback();
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(`[job-copilot] stored "${key}" failed validation; using defaults where needed`, parsed.error.issues.slice(0, 3));
  return fallback();
}

/* ----------------------------------------------------------------------------
 * Profile & settings
 * ------------------------------------------------------------------------- */

export const defaultProfile = (): Profile => Profile.parse({ basics: {} });
export const defaultSettings = (): Settings => Settings.parse({});

export function getProfile(): Promise<Profile> {
  return readKey(KEYS.profile, Profile, defaultProfile);
}

/** Saves the canonical profile and bumps its version (invalidates cached matches). */
export function saveProfile(next: Profile): Promise<Profile> {
  return withLock(KEYS.profile, async () => {
    const current = await getProfile();
    const saved = Profile.parse({ ...next, version: current.version + 1, updatedAt: nowIso() });
    await local().set({ [KEYS.profile]: saved });
    return saved;
  });
}

export function getSettings(): Promise<Settings> {
  return readKey(KEYS.settings, Settings, defaultSettings);
}

export function updateSettings(fn: (s: Settings) => Settings): Promise<Settings> {
  return withLock(KEYS.settings, async () => {
    const next = Settings.parse(fn(await getSettings()));
    await local().set({ [KEYS.settings]: next });
    return next;
  });
}

/* ----------------------------------------------------------------------------
 * Jobs
 * ------------------------------------------------------------------------- */

async function listPrefixed<S extends z.ZodType>(prefix: string, schema: S): Promise<Array<z.infer<S>>> {
  const all = await local().get(null);
  const out: Array<z.infer<S>> = [];
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith(prefix)) continue;
    const parsed = schema.safeParse(v);
    if (parsed.success) out.push(parsed.data);
    else console.warn(`[job-copilot] skipping invalid record ${k}`);
  }
  return out;
}

export const listJobs = () => listPrefixed(PREFIX.job, JobRecord);

export async function getJob(id: string): Promise<JobRecord | null> {
  const raw = (await local().get(PREFIX.job + id))[PREFIX.job + id];
  const parsed = JobRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function putJob(job: JobRecord): Promise<JobRecord> {
  const valid = JobRecord.parse(job);
  await local().set({ [PREFIX.job + valid.id]: valid });
  return valid;
}

export async function patchJob(id: string, fn: (j: JobRecord) => JobRecord): Promise<JobRecord | null> {
  return withLock(PREFIX.job + id, async () => {
    const job = await getJob(id);
    if (!job) return null;
    return putJob({ ...fn(job), updatedAt: nowIso() });
  });
}

export async function deleteJob(id: string): Promise<void> {
  const apps = (await listApplications()).filter((a) => a.jobId === id);
  const letters = await getCoverLetters();
  const prep = await getAllPrep();
  delete letters[id];
  delete prep[id];
  await local().remove([PREFIX.job + id, ...apps.map((a) => PREFIX.app + a.id)]);
  await local().set({ [KEYS.coverLetters]: letters, [KEYS.interviewPrep]: prep });
}

export interface UpsertResult {
  job: JobRecord;
  created: boolean;
  duplicate?: DuplicateReason;
}

/** Inserts a job or merges it into an existing duplicate. Serialised to avoid double inserts. */
export function upsertJob(
  extracted: ExtractedJob,
  origin: JobOrigin,
  extra: Partial<JobRecord> = {},
  existing?: JobRecord[],
): Promise<UpsertResult> {
  return withLock('jobs:upsert', async () => {
    const pool = existing ?? (await listJobs());
    const dup = findDuplicate({ ...extracted, sourceId: extra.sourceId, sourceJobId: extra.sourceJobId }, pool);
    if (dup) {
      const merged = mergeExtraction(dup.job, extracted, {
        ...extra,
        // Never downgrade user decisions when re-seeing a job.
        saved: dup.job.saved || !!extra.saved,
        savedAt: dup.job.savedAt ?? extra.savedAt,
        dismissed: extra.dismissed ?? dup.job.dismissed,
        origin: dup.job.origin,
      });
      await putJob(merged);
      return { job: merged, created: false, duplicate: dup.reason };
    }
    const job = createJobRecord(extracted, origin, extra);
    await putJob(job);
    pool.push(job);
    return { job, created: true };
  });
}

export async function setJobSaved(id: string, saved: boolean): Promise<JobRecord | null> {
  const job = await patchJob(id, (j) => ({ ...j, saved, savedAt: saved ? (j.savedAt ?? nowIso()) : undefined, dismissed: saved ? false : j.dismissed }));
  if (job && saved) await ensureApplication(job.id, 'saved');
  return job;
}

export function setJobDismissed(id: string, dismissed: boolean): Promise<JobRecord | null> {
  return patchJob(id, (j) => ({ ...j, dismissed, saved: dismissed ? false : j.saved }));
}

/* ----------------------------------------------------------------------------
 * Applications
 * ------------------------------------------------------------------------- */

export const listApplications = () => listPrefixed(PREFIX.app, ApplicationRecord);

export async function getApplication(id: string): Promise<ApplicationRecord | null> {
  const raw = (await local().get(PREFIX.app + id))[PREFIX.app + id];
  const parsed = ApplicationRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function putApplication(app: ApplicationRecord): Promise<ApplicationRecord> {
  const valid = ApplicationRecord.parse({ ...app, updatedAt: nowIso() });
  await local().set({ [PREFIX.app + valid.id]: valid });
  return valid;
}

/** Returns the application for a job, creating one with `status` if none exists. */
export function ensureApplication(jobId: string, status: ApplicationStatus): Promise<ApplicationRecord> {
  return withLock(`app-for:${jobId}`, async () => {
    const existing = (await listApplications()).find((a) => a.jobId === jobId);
    if (existing) return existing;
    const now = nowIso();
    return putApplication({
      id: uid('app'),
      jobId,
      status,
      statusHistory: [{ status, at: now }],
      submissionConfirmed: false,
      notes: '',
      contacts: [],
      createdAt: now,
      updatedAt: now,
    });
  });
}

/**
 * Changes status. Moving to "applied" requires `confirmedSubmission`, which the
 * UI only passes after the user explicitly confirms they submitted.
 */
export function setApplicationStatus(
  id: string,
  status: ApplicationStatus,
  opts: { confirmedSubmission?: boolean; appliedAt?: string } = {},
): Promise<ApplicationRecord> {
  return withLock(PREFIX.app + id, async () => {
    const app = await getApplication(id);
    if (!app) throw new Error('Application not found');
    if (status === 'applied' && !opts.confirmedSubmission && !app.submissionConfirmed)
      throw new Error('Confirm that you submitted this application before marking it as applied.');
    const now = nowIso();
    const next: ApplicationRecord = {
      ...app,
      status,
      statusHistory: app.status === status ? app.statusHistory : [...app.statusHistory, { status, at: now }],
    };
    if (status === 'applied' && opts.confirmedSubmission) {
      next.submissionConfirmed = true;
      next.appliedAt = opts.appliedAt ?? app.appliedAt ?? now;
    }
    return putApplication(next);
  });
}

export function patchApplication(id: string, fn: (a: ApplicationRecord) => ApplicationRecord): Promise<ApplicationRecord> {
  return withLock(PREFIX.app + id, async () => {
    const app = await getApplication(id);
    if (!app) throw new Error('Application not found');
    const next = fn(app);
    // Status changes must go through setApplicationStatus so submission is confirmed.
    if (next.status !== app.status) throw new Error('Use setApplicationStatus to change status');
    if (next.submissionConfirmed !== app.submissionConfirmed) throw new Error('Submission confirmation cannot be patched');
    return putApplication(next);
  });
}

export async function deleteApplication(id: string): Promise<void> {
  await local().remove(PREFIX.app + id);
}

/* ----------------------------------------------------------------------------
 * Résumé versions, cover letters, interview prep
 * ------------------------------------------------------------------------- */

export async function listResumes(): Promise<ResumeVersion[]> {
  const raw = (await local().get(KEYS.resumes))[KEYS.resumes];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const p = ResumeVersion.safeParse(r);
    return p.success ? [p.data] : [];
  });
}

export function putResume(version: ResumeVersion): Promise<ResumeVersion> {
  return withLock(KEYS.resumes, async () => {
    const list = await listResumes();
    const existing = list.find((r) => r.id === version.id);
    // The uploaded original is immutable once stored.
    if (existing?.kind === 'original') throw new Error('The original résumé is read-only. Save a copy instead.');
    const valid = ResumeVersion.parse({ ...version, updatedAt: nowIso() });
    const next = existing ? list.map((r) => (r.id === valid.id ? valid : r)) : [...list, valid];
    await local().set({ [KEYS.resumes]: next });
    return valid;
  });
}

/** Stores an uploaded original. Multiple originals may exist (one per upload). */
export function addOriginalResume(version: ResumeVersion): Promise<ResumeVersion> {
  return withLock(KEYS.resumes, async () => {
    const list = await listResumes();
    const valid = ResumeVersion.parse({ ...version, kind: 'original' });
    await local().set({ [KEYS.resumes]: [...list, valid] });
    return valid;
  });
}

export function deleteResume(id: string): Promise<void> {
  return withLock(KEYS.resumes, async () => {
    const list = await listResumes();
    await local().set({ [KEYS.resumes]: list.filter((r) => r.id !== id) });
    await local().remove(PREFIX.file + id);
  });
}

const LOG_MAX = 50;

/** Recent autofill runs, newest first. */
export async function getAutofillLog(): Promise<AutofillLogEntry[]> {
  const raw = (await local().get(KEYS.autofillLog))[KEYS.autofillLog];
  return Array.isArray(raw) ? raw.flatMap((r) => { const p = AutofillLogEntry.safeParse(r); return p.success ? [p.data] : []; }) : [];
}

export function logAutofill(entry: AutofillLogEntry): Promise<void> {
  return withLock(KEYS.autofillLog, async () => {
    const list = [entry, ...(await getAutofillLog())].slice(0, LOG_MAX);
    await local().set({ [KEYS.autofillLog]: list });
  });
}

export async function putResumeFile(resumeId: string, file: StoredFile): Promise<void> {
  await local().set({ [PREFIX.file + resumeId]: StoredFile.parse(file) });
}

export async function getResumeFile(resumeId: string): Promise<StoredFile | null> {
  const p = StoredFile.safeParse((await local().get(PREFIX.file + resumeId))[PREFIX.file + resumeId]);
  return p.success ? p.data : null;
}

async function getRecordMap<S extends z.ZodType>(key: string, schema: S): Promise<Record<string, z.infer<S>>> {
  const raw = (await local().get(key))[key];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, z.infer<S>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = schema.safeParse(v);
    if (p.success) out[k] = p.data;
  }
  return out;
}

export const getCoverLetters = () => getRecordMap(KEYS.coverLetters, CoverLetter);
export function putCoverLetter(letter: CoverLetter): Promise<CoverLetter> {
  return withLock(KEYS.coverLetters, async () => {
    const all = await getCoverLetters();
    const valid = CoverLetter.parse({ ...letter, updatedAt: nowIso() });
    all[valid.jobId] = valid;
    await local().set({ [KEYS.coverLetters]: all });
    return valid;
  });
}

export const getAllPrep = () => getRecordMap(KEYS.interviewPrep, InterviewPrep);
export function putPrep(prep: InterviewPrep): Promise<InterviewPrep> {
  return withLock(KEYS.interviewPrep, async () => {
    const all = await getAllPrep();
    const valid = InterviewPrep.parse({ ...prep, updatedAt: nowIso() });
    all[valid.jobId] = valid;
    await local().set({ [KEYS.interviewPrep]: all });
    return valid;
  });
}

/* ----------------------------------------------------------------------------
 * Bounded caches
 * ------------------------------------------------------------------------- */

const MAX_MATCH_CACHE = 1500;

export async function getMatchCache(): Promise<Record<string, MatchResult>> {
  return ((await local().get(KEYS.matchCache))[KEYS.matchCache] ?? {}) as Record<string, MatchResult>;
}

export async function getCachedMatch(key: string): Promise<MatchResult | null> {
  return (await getMatchCache())[key] ?? null;
}

export function putCachedMatches(results: MatchResult[]): Promise<void> {
  if (!results.length) return Promise.resolve();
  return withLock(KEYS.matchCache, async () => {
    const cache = ((await local().get(KEYS.matchCache))[KEYS.matchCache] ?? {}) as Record<string, MatchResult>;
    for (const r of results) cache[r.cacheKey] = r;
    const entries = Object.entries(cache);
    const pruned =
      entries.length > MAX_MATCH_CACHE
        ? Object.fromEntries(entries.sort(([, a], [, b]) => b.computedAt.localeCompare(a.computedAt)).slice(0, MAX_MATCH_CACHE))
        : cache;
    await local().set({ [KEYS.matchCache]: pruned });
  });
}

export async function getAnalysisCache(): Promise<Record<string, JobAnalysis>> {
  return ((await local().get(KEYS.analysisCache))[KEYS.analysisCache] ?? {}) as Record<string, JobAnalysis>;
}

export function putAnalyses(entries: Record<string, JobAnalysis>): Promise<void> {
  if (!Object.keys(entries).length) return Promise.resolve();
  return withLock(KEYS.analysisCache, async () => {
    const cache = { ...(await getAnalysisCache()), ...entries };
    const keys = Object.keys(cache);
    if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete cache[k];
    await local().set({ [KEYS.analysisCache]: cache });
  });
}

export async function clearCaches(): Promise<void> {
  await local().remove([...CACHE_KEYS]);
}

/* ----------------------------------------------------------------------------
 * Export / import / delete
 * ------------------------------------------------------------------------- */

export interface BackupFile {
  format: 'job-copilot-backup';
  schemaVersion: number;
  exportedAt: string;
  data: Record<string, unknown>;
}

export async function exportAll(): Promise<BackupFile> {
  const all = await local().get(null);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) if (!(CACHE_KEYS as readonly string[]).includes(k)) data[k] = v;
  // Never include secrets in a backup that may be shared or synced.
  const settings = data[KEYS.settings] as Settings | undefined;
  if (settings?.ai?.backend) data[KEYS.settings] = { ...settings, ai: { ...settings.ai, backend: { ...settings.ai.backend, token: '' } } };
  return { format: 'job-copilot-backup', schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), data };
}

export interface ImportReport {
  imported: number;
  rejected: string[];
}

const RECORD_SCHEMAS: Array<[string | RegExp, z.ZodType]> = [
  [KEYS.profile, Profile],
  [KEYS.settings, Settings],
  [/^job:/, JobRecord],
  [/^app:/, ApplicationRecord],
  [/^file:/, StoredFile],
];

/** Restores a backup after validating every record. Invalid records are reported, not written. */
export async function importBackup(file: unknown, mode: 'merge' | 'replace'): Promise<ImportReport> {
  if (!file || typeof file !== 'object' || (file as BackupFile).format !== 'job-copilot-backup')
    throw new Error('This file is not a Job Copilot backup.');
  const backup = file as BackupFile;
  if (backup.schemaVersion > SCHEMA_VERSION) throw new Error('This backup was made by a newer version of the extension.');
  if (!backup.data || typeof backup.data !== 'object') throw new Error('Backup has no data.');
  const data = migrateSnapshot(backup.data, Number(backup.schemaVersion) || 0);

  const writes: Record<string, unknown> = {};
  const rejected: string[] = [];
  const allowedStatic = new Set<string>([KEYS.profile, KEYS.settings, KEYS.resumes, KEYS.coverLetters, KEYS.interviewPrep, KEYS.aiUsage, KEYS.meta]);
  for (const [key, value] of Object.entries(data)) {
    if (!allowedStatic.has(key) && !Object.values(PREFIX).some((p) => key.startsWith(p))) {
      rejected.push(`${key}: unknown key`);
      continue;
    }
    const schema = RECORD_SCHEMAS.find(([m]) => (typeof m === 'string' ? m === key : m.test(key)))?.[1];
    if (schema) {
      const p = schema.safeParse(value);
      if (!p.success) {
        rejected.push(`${key}: ${p.error.issues[0]?.message ?? 'invalid'}`);
        continue;
      }
      writes[key] = p.data;
    } else if (key === KEYS.resumes) {
      const list = Array.isArray(value) ? value.filter((r) => ResumeVersion.safeParse(r).success) : [];
      writes[key] = list;
    } else if (key !== KEYS.meta) writes[key] = value;
  }
  // Backups never carry the backend token; keep the one already configured.
  const incoming = writes[KEYS.settings] as Settings | undefined;
  if (incoming && !incoming.ai.backend.token) {
    const current = await getSettings();
    incoming.ai.backend.token = current.ai.backend.token;
  }
  if (mode === 'replace') {
    await deleteAllData();
    writes[KEYS.meta] = { schemaVersion: SCHEMA_VERSION, installedAt: nowIso(), lastMigratedAt: nowIso() };
  }
  await local().set(writes);
  return { imported: Object.keys(writes).length, rejected };
}

export async function deleteAllData(): Promise<void> {
  await local().clear();
  await browser.storage.session.clear();
}

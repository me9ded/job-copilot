import type { ExtractedJob, JobOrigin, JobRecord } from './types';
import { canonicalizeUrl, daysBetween, hash, normalizeForCompare, nowIso, parseDate, uid } from './util';

/** Content fingerprint: changes whenever the posting text materially changes. */
export function jobFingerprint(job: Pick<ExtractedJob, 'title' | 'company' | 'location' | 'descriptionText'>): string {
  return hash(
    [job.title, job.company, job.location ?? '', job.descriptionText.slice(0, 20_000)].map(normalizeForCompare).join('|'),
  );
}

/** Identity key: same company + title + location is treated as the same opening. */
export function jobDedupeKey(job: Pick<ExtractedJob, 'title' | 'company' | 'location'>): string {
  const title = normalizeForCompare(job.title).replace(/\b(remote|hybrid|onsite|on site)\b/g, '').trim();
  return hash([normalizeForCompare(job.company), title, normalizeForCompare(job.location ?? '')].join('|'));
}

function shingles(text: string, size = 4): Set<string> {
  const words = normalizeForCompare(text).split(' ').filter(Boolean).slice(0, 1500);
  const out = new Set<string>();
  for (let i = 0; i + size <= words.length; i++) out.add(words.slice(i, i + size).join(' '));
  return out;
}

export function jaccard(a: string, b: string): number {
  const A = shingles(a);
  const B = shingles(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export type DuplicateReason = 'url' | 'source' | 'identity' | 'content';

/**
 * Finds an existing record that represents the same job:
 * 1. same canonical / alias URL, 2. same discovery source id, 3. same
 * company+title+location, 4. same company with near-identical description
 * (e.g. the same role re-posted under a different location string).
 */
export function findDuplicate(
  candidate: Pick<JobRecord, 'url' | 'title' | 'company' | 'location' | 'descriptionText'> & { sourceId?: string; sourceJobId?: string },
  existing: JobRecord[],
): { job: JobRecord; reason: DuplicateReason } | null {
  const url = canonicalizeUrl(candidate.url);
  for (const j of existing) if (j.url === url || j.aliasUrls.includes(url)) return { job: j, reason: 'url' };
  if (candidate.sourceId && candidate.sourceJobId)
    for (const j of existing)
      if (j.sourceId === candidate.sourceId && j.sourceJobId === candidate.sourceJobId) return { job: j, reason: 'source' };
  const key = jobDedupeKey(candidate);
  for (const j of existing) if (j.dedupeKey === key) return { job: j, reason: 'identity' };
  const company = normalizeForCompare(candidate.company);
  const title = normalizeForCompare(candidate.title);
  if (company && candidate.descriptionText.length > 300) {
    for (const j of existing) {
      if (normalizeForCompare(j.company) !== company) continue;
      if (normalizeForCompare(j.title) !== title && jaccard(j.title, candidate.title) < 0.5) continue;
      if (jaccard(j.descriptionText, candidate.descriptionText) >= 0.85) return { job: j, reason: 'content' };
    }
  }
  return null;
}

const EDITABLE_FIELDS = [
  'title',
  'company',
  'location',
  'workArrangement',
  'employmentType',
  'salary',
  'descriptionText',
  'responsibilities',
  'requiredQualifications',
  'preferredQualifications',
  'datePosted',
  'applyUrl',
] as const;
export type EditableJobField = (typeof EDITABLE_FIELDS)[number];

export function createJobRecord(job: ExtractedJob, origin: JobOrigin, extra: Partial<JobRecord> = {}): JobRecord {
  const now = nowIso();
  return {
    ...job,
    id: uid('job'),
    fingerprint: jobFingerprint(job),
    dedupeKey: jobDedupeKey(job),
    origin,
    saved: false,
    dismissed: false,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    expired: false,
    userEditedFields: [],
    notes: '',
    aliasUrls: [],
    ...extra,
  };
}

/**
 * Merges a fresh extraction into an existing record. Fields the user edited are
 * preserved; everything else is refreshed and `lastVerifiedAt` is bumped.
 */
export function mergeExtraction(existing: JobRecord, fresh: ExtractedJob, extra: Partial<JobRecord> = {}): JobRecord {
  const merged: JobRecord = { ...existing };
  for (const field of EDITABLE_FIELDS) {
    if (existing.userEditedFields.includes(field)) continue;
    const value = fresh[field];
    if (value !== undefined && !(Array.isArray(value) && value.length === 0 && Array.isArray(existing[field]) && (existing[field] as unknown[]).length))
      (merged as Record<string, unknown>)[field] = value;
  }
  merged.descriptionHtml = existing.userEditedFields.includes('descriptionText') ? existing.descriptionHtml : (fresh.descriptionHtml ?? existing.descriptionHtml);
  merged.validThrough = fresh.validThrough ?? existing.validThrough;
  merged.completeness = Math.max(existing.completeness, fresh.completeness);
  merged.missingFields = fresh.missingFields.filter((f) => existing.missingFields.includes(f));
  merged.warnings = fresh.warnings;
  const freshUrl = canonicalizeUrl(fresh.url);
  if (freshUrl !== existing.url && !existing.aliasUrls.includes(freshUrl)) merged.aliasUrls = [...existing.aliasUrls, freshUrl].slice(-10);
  merged.fingerprint = jobFingerprint(merged);
  merged.updatedAt = nowIso();
  merged.lastVerifiedAt = nowIso();
  merged.expired = false;
  merged.expiredReason = undefined;
  return { ...merged, ...extra };
}

/** Applies user corrections and remembers which fields were edited. */
export function applyUserEdits(job: JobRecord, edits: Partial<Pick<JobRecord, EditableJobField | 'notes'>>): JobRecord {
  const edited = new Set(job.userEditedFields);
  for (const key of Object.keys(edits)) if ((EDITABLE_FIELDS as readonly string[]).includes(key)) edited.add(key);
  const next: JobRecord = { ...job, ...edits, userEditedFields: [...edited], updatedAt: nowIso() };
  next.fingerprint = jobFingerprint(next);
  next.dedupeKey = jobDedupeKey(next);
  return next;
}

export type Freshness = { state: 'fresh' | 'stale' | 'expired'; reason?: string };

export function jobFreshness(job: JobRecord, staleAfterDays: number, now = new Date()): Freshness {
  if (job.expired) return { state: 'expired', reason: job.expiredReason ?? 'Marked as expired' };
  const until = parseDate(job.validThrough);
  if (until && until < now) return { state: 'expired', reason: `Listing closed on ${until.toLocaleDateString()}` };
  const verified = parseDate(job.lastVerifiedAt ?? job.createdAt);
  if (verified && daysBetween(verified, now) > staleAfterDays)
    return { state: 'stale', reason: `Not verified for ${daysBetween(verified, now)} days` };
  const posted = parseDate(job.datePosted);
  if (posted && daysBetween(posted, now) > 60) return { state: 'stale', reason: `Posted ${daysBetween(posted, now)} days ago` };
  return { state: 'fresh' };
}

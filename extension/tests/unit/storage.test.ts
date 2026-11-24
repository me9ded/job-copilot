import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runMigrations, MIGRATIONS } from '../../src/lib/storage/migrations';
import {
  deleteAllData,
  ensureApplication,
  exportAll,
  getProfile,
  getSettings,
  importBackup,
  listApplications,
  listJobs,
  patchApplication,
  putResume,
  addOriginalResume,
  saveProfile,
  setApplicationStatus,
  setJobSaved,
  updateSettings,
  upsertJob,
} from '../../src/lib/storage/repo';
import { SCHEMA_VERSION } from '../../src/lib/storage/schema';
import { makeJob, makeProfile } from '../helpers';

describe('persistence', () => {
  it('persists and versions the profile', async () => {
    expect((await getProfile()).version).toBe(0);
    const saved = await saveProfile(makeProfile());
    expect(saved.version).toBe(1);
    const again = await saveProfile({ ...saved, skills: [...saved.skills, 'Rust'] });
    expect(again.version).toBe(2);
    expect((await getProfile()).skills).toContain('Rust');
  });

  it('fills defaults for settings and survives invalid stored data', async () => {
    await fakeBrowser.storage.local.set({ settings: { weights: { requiredSkills: 'lots' } } });
    const s = await getSettings();
    expect(s.weights.requiredSkills).toBe(4.5);
    await updateSettings((x) => ({ ...x, staleAfterDays: 5 }));
    expect((await getSettings()).staleAfterDays).toBe(5);
  });

  it('upserts jobs with duplicate detection and keeps user decisions', async () => {
    const first = await upsertJob(makeJob(), 'page');
    expect(first.created).toBe(true);
    await setJobSaved(first.job.id, true);
    const second = await upsertJob(makeJob({ url: 'https://example.com/jobs/1?utm_source=x' }), 'discovery');
    expect(second.created).toBe(false);
    expect(second.duplicate).toBe('url');
    const jobs = await listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.saved).toBe(true);
    expect(jobs[0]?.origin).toBe('page');
    // Saving creates an application in the "saved" stage.
    expect((await listApplications()).map((a) => a.status)).toEqual(['saved']);
  });

  it('serialises concurrent upserts of the same job', async () => {
    await Promise.all([upsertJob(makeJob(), 'page'), upsertJob(makeJob(), 'page'), upsertJob(makeJob(), 'page')]);
    expect(await listJobs()).toHaveLength(1);
  });

  it('skips corrupted records instead of failing the whole list', async () => {
    await upsertJob(makeJob(), 'page');
    await fakeBrowser.storage.local.set({ 'job:broken': { title: 42 } });
    expect(await listJobs()).toHaveLength(1);
  });
});

describe('applications', () => {
  it('refuses to mark an application as applied without explicit confirmation', async () => {
    const { job } = await upsertJob(makeJob(), 'page');
    const app = await ensureApplication(job.id, 'ready');
    await expect(setApplicationStatus(app.id, 'applied')).rejects.toThrow(/Confirm/);
    const applied = await setApplicationStatus(app.id, 'applied', { confirmedSubmission: true, appliedAt: '2026-10-20T00:00:00.000Z' });
    expect(applied.submissionConfirmed).toBe(true);
    expect(applied.appliedAt).toBe('2026-10-20T00:00:00.000Z');
    expect(applied.statusHistory.map((h) => h.status)).toEqual(['ready', 'applied']);
    await expect(patchApplication(app.id, (a) => ({ ...a, status: 'offer' }))).rejects.toThrow();
    await expect(patchApplication(app.id, (a) => ({ ...a, submissionConfirmed: false }))).rejects.toThrow();
  });

  it('creates at most one application per job', async () => {
    const { job } = await upsertJob(makeJob(), 'page');
    await Promise.all([ensureApplication(job.id, 'saved'), ensureApplication(job.id, 'saved')]);
    expect(await listApplications()).toHaveLength(1);
  });
});

describe('résumé versions', () => {
  it('keeps the uploaded original read-only', async () => {
    const now = new Date().toISOString();
    const original = await addOriginalResume({ id: 'r1', name: 'Original', kind: 'original', content: makeProfile(), rawText: 'raw', createdAt: now, updatedAt: now });
    await expect(putResume({ ...original, name: 'changed' })).rejects.toThrow(/read-only/);
    await putResume({ ...original, id: 'r2', kind: 'tailored', name: 'For Acme' });
  });
});

describe('migrations', () => {
  it('initialises the schema version on first run and is a no-op afterwards', async () => {
    const r1 = await runMigrations(fakeBrowser.storage.local);
    expect(r1).toMatchObject({ from: 0, to: SCHEMA_VERSION });
    expect(((await fakeBrowser.storage.local.get('meta')).meta as { schemaVersion: number }).schemaVersion).toBe(SCHEMA_VERSION);
    const r2 = await runMigrations(fakeBrowser.storage.local);
    expect(r2.applied).toEqual([]);
  });

  it('splits a legacy jobs map into per-record keys', async () => {
    await fakeBrowser.storage.local.set({ meta: { schemaVersion: 1, installedAt: 'x' }, jobs: { j1: { id: 'j1' } } });
    const r = await runMigrations(fakeBrowser.storage.local);
    expect(r.applied).toHaveLength(1);
    const all = await fakeBrowser.storage.local.get(null);
    expect(all.jobs).toBeUndefined();
    expect(all['job:j1']).toEqual({ id: 'j1' });
  });

  it('never downgrades data written by a newer build', async () => {
    await fakeBrowser.storage.local.set({ meta: { schemaVersion: 99, installedAt: 'x' }, profile: { future: true } });
    const r = await runMigrations(fakeBrowser.storage.local);
    expect(r.skipped).toMatch(/newer/);
    expect((await fakeBrowser.storage.local.get('profile')).profile).toEqual({ future: true });
  });

  it('applies custom migrations in order', async () => {
    const order: number[] = [];
    await runMigrations(
      fakeBrowser.storage.local,
      [
        { to: 2, description: 'b', up: (d) => (order.push(2), { ...d, b: 1 }) },
        { to: 1, description: 'a', up: (d) => (order.push(1), { ...d, a: 1 }) },
      ],
      2,
    );
    expect(order).toEqual([1, 2]);
    expect(MIGRATIONS.map((m) => m.to)).toEqual([1, 2]);
  });
});

describe('export / import / delete', () => {
  it('round-trips a backup, strips secrets and validates records', async () => {
    await saveProfile(makeProfile());
    await upsertJob(makeJob(), 'page');
    await updateSettings((s) => ({ ...s, ai: { ...s.ai, backend: { ...s.ai.backend, token: 'secret-token' } } }));
    const backup = await exportAll();
    expect(JSON.stringify(backup)).not.toContain('secret-token');
    expect(backup.data.matchCache).toBeUndefined();

    await deleteAllData();
    expect(await listJobs()).toHaveLength(0);

    const tampered = { ...backup, data: { ...backup.data, 'job:evil': { title: 1 }, evilKey: 'x' } };
    const report = await importBackup(tampered, 'replace');
    expect(report.rejected).toEqual(expect.arrayContaining([expect.stringMatching(/^job:evil/), expect.stringMatching(/^evilKey/)]));
    expect(await listJobs()).toHaveLength(1);
    expect((await getProfile()).basics.name).toBe('Sam Rivera');
  });

  it('rejects files that are not backups', async () => {
    await expect(importBackup({ hello: 'world' }, 'merge')).rejects.toThrow(/not a Job Copilot backup/);
    await expect(importBackup({ format: 'job-copilot-backup', schemaVersion: 999, data: {} }, 'merge')).rejects.toThrow(/newer version/);
  });
});

import { browser } from 'wxt/browser';
import type { DiscoveryRunSummary } from '../messages';
import { listJobs, patchJob, updateSettings, upsertJob, getSettings } from '../storage/repo';
import type { DiscoverySource, JobRecord } from '../types';
import { errorMessage, nowIso } from '../util';
import { fetchSource, SOURCE_ADAPTERS } from './sources';

const MAX_PER_SOURCE = 300;

export async function hasSourcePermission(source: Pick<DiscoverySource, 'kind'>): Promise<boolean> {
  return browser.permissions.contains({ origins: [SOURCE_ADAPTERS[source.kind].apiOrigin] });
}

/**
 * Refreshes discovery sources. Safe to interrupt: every job is written as it is
 * processed and per-source status is stored, so a service-worker restart simply
 * resumes on the next run.
 */
export async function runDiscovery(opts: { sourceId?: string; fetchImpl?: typeof fetch } = {}): Promise<DiscoveryRunSummary & { newJobs: JobRecord[] }> {
  const settings = await getSettings();
  const sources = settings.discovery.sources.filter((s) => (opts.sourceId ? s.id === opts.sourceId : s.enabled));
  const summary: DiscoveryRunSummary & { newJobs: JobRecord[] } = {
    sources: sources.length,
    fetched: 0,
    created: 0,
    updated: 0,
    expired: 0,
    errors: [],
    newJobs: [],
  };
  const pool = await listJobs();

  for (const source of sources) {
    const status: Partial<DiscoverySource> = { lastRunAt: nowIso() };
    try {
      if (!(await hasSourcePermission(source)))
        throw new Error(`Access to ${SOURCE_ADAPTERS[source.kind].label}'s API has not been granted. Open Settings → Job discovery.`);
      const found = (await fetchSource(source, opts.fetchImpl)).slice(0, MAX_PER_SOURCE);
      summary.fetched += found.length;
      const seen = new Set<string>();
      for (const d of found) {
        seen.add(d.sourceJobId);
        const res = await upsertJob(d.job, 'discovery', { sourceId: source.id, sourceJobId: d.sourceJobId }, pool);
        if (res.created) {
          summary.created++;
          summary.newJobs.push(res.job);
        } else summary.updated++;
      }
      // Jobs from this source that disappeared from the board are marked expired (never deleted).
      for (const job of pool) {
        if (job.sourceId === source.id && job.sourceJobId && !seen.has(job.sourceJobId) && !job.expired) {
          await patchJob(job.id, (j) => ({ ...j, expired: true, expiredReason: `No longer listed on the ${SOURCE_ADAPTERS[source.kind].label} board` }));
          job.expired = true;
          summary.expired++;
        }
      }
      status.lastCount = found.length;
      status.lastError = undefined;
    } catch (err) {
      status.lastError = errorMessage(err);
      summary.errors.push(`${source.label || source.token}: ${status.lastError}`);
    }
    await updateSettings((s) => ({
      ...s,
      discovery: { ...s.discovery, sources: s.discovery.sources.map((x) => (x.id === source.id ? { ...x, ...status } : x)) },
    }));
  }
  await updateSettings((s) => ({ ...s, discovery: { ...s.discovery, lastRunAt: nowIso() } }));
  return summary;
}

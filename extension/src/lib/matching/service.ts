import { jobFingerprint } from '../jobs';
import { getAnalysisCache, getCachedMatch, getMatchCache, getProfile, getSettings, putAnalyses, putCachedMatches } from '../storage/repo';
import type { ExtractedJob, MatchResult, Profile, Settings } from '../types';
import { analyzeJob, ANALYSIS_VERSION, type JobAnalysis } from './analysis';
import { computeMatch, matchCacheKey } from './engine';

export function profileIsEmpty(p: Profile): boolean {
  return !p.skills.length && !p.experience.length && !p.projects.length;
}

export function profileCompletion(p: Profile): { percent: number; missing: string[] } {
  const checks: Array<[string, boolean]> = [
    ['Name', !!p.basics.name],
    ['Contact email', !!p.basics.email],
    ['Headline', !!p.basics.headline],
    ['Summary', p.basics.summary.length > 40],
    ['At least 5 skills', p.skills.length >= 5],
    ['Work experience', p.experience.length > 0],
    ['Experience dates', p.experience.length > 0 && p.experience.every((e) => !!e.start)],
    ['Achievement bullets', p.experience.some((e) => e.bullets.length >= 2)],
    ['Education', p.education.length > 0],
    ['Target roles', p.preferences.roleTitles.length > 0],
    ['Location or work preference', p.preferences.locations.length > 0 || p.preferences.workArrangements.length > 0],
    ['Seniority preference', p.preferences.seniority.length > 0],
  ];
  const done = checks.filter(([, ok]) => ok).length;
  return { percent: Math.round((done / checks.length) * 100), missing: checks.filter(([, ok]) => !ok).map(([n]) => n) };
}

type Matchable = ExtractedJob & { fingerprint?: string };

/**
 * Scores one job against the profile, reusing cached job analyses and match
 * results. Recomputes only when the job content, profile version, weights or
 * taxonomy change.
 */
export async function matchJob(job: Matchable, ctx?: { profile?: Profile; settings?: Settings }): Promise<MatchResult | null> {
  const [profile, settings] = await Promise.all([ctx?.profile ?? getProfile(), ctx?.settings ?? getSettings()]);
  if (profileIsEmpty(profile)) return null;
  const fingerprint = job.fingerprint ?? jobFingerprint(job);
  const key = matchCacheKey(fingerprint, profile.version, settings.weights, settings.dealBreakerCap);
  const cached = await getCachedMatch(key);
  if (cached) return cached;
  const analyses = await getAnalysisCache();
  let analysis = analyses[fingerprint];
  if (!analysis || analysis.version !== ANALYSIS_VERSION) {
    analysis = analyzeJob(job);
    await putAnalyses({ [fingerprint]: analysis });
  }
  const result = computeMatch({ job: { ...job, fingerprint }, profile, weights: settings.weights, dealBreakerCap: settings.dealBreakerCap, analysis });
  await putCachedMatches([result]);
  return result;
}

/** Batch variant used for lists (saved jobs, discovery). One storage round-trip per cache. */
export async function matchJobs(
  jobs: Array<Matchable & { id: string }>,
  ctx?: { profile?: Profile; settings?: Settings },
): Promise<Map<string, MatchResult>> {
  const out = new Map<string, MatchResult>();
  const [profile, settings] = await Promise.all([ctx?.profile ?? getProfile(), ctx?.settings ?? getSettings()]);
  if (profileIsEmpty(profile) || !jobs.length) return out;
  const [analyses, matchCache] = await Promise.all([getAnalysisCache(), getMatchCache()]);
  const newAnalyses: Record<string, JobAnalysis> = {};
  const newResults: MatchResult[] = [];
  for (const job of jobs) {
    const fingerprint = job.fingerprint ?? jobFingerprint(job);
    const key = matchCacheKey(fingerprint, profile.version, settings.weights, settings.dealBreakerCap);
    const cached = matchCache[key];
    if (cached) {
      out.set(job.id, cached);
      continue;
    }
    let analysis = analyses[fingerprint];
    if (!analysis || analysis.version !== ANALYSIS_VERSION) {
      analysis = analyzeJob(job);
      newAnalyses[fingerprint] = analysis;
    }
    const result = computeMatch({ job: { ...job, fingerprint }, profile, weights: settings.weights, dealBreakerCap: settings.dealBreakerCap, analysis });
    newResults.push(result);
    out.set(job.id, result);
  }
  await putAnalyses(newAnalyses);
  await putCachedMatches(newResults);
  return out;
}

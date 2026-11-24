import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { getDetection, type TabDetection } from '../lib/detection';
import { matchJob, matchJobs } from '../lib/matching/service';
import { getAllPrep, getCoverLetters, getProfile, getSettings, listApplications, listJobs, listResumes } from '../lib/storage/repo';
import { KEYS, PREFIX, SESSION_KEYS } from '../lib/storage/schema';
import type { ApplicationRecord, CoverLetter, ExtractedJob, InterviewPrep, JobRecord, MatchResult, Profile, ResumeVersion, Settings } from '../lib/types';
import { errorMessage } from '../lib/util';
import { getUsage, type AiUsage } from '../lib/ai/client';

type Area = 'local' | 'session';

/** Loads a value and reloads it whenever a relevant storage key changes in any context. */
export function useStored<T>(load: () => Promise<T>, relevant: (key: string, area: Area) => boolean): T | undefined {
  const [value, setValue] = useState<T>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const relevantRef = useRef(relevant);
  relevantRef.current = relevant;
  useEffect(() => {
    let alive = true;
    const run = () =>
      loadRef.current().then(
        (v) => alive && setValue(v),
        (e) => console.error('[job-copilot] load failed', e),
      );
    void run();
    const onChange = (changes: Record<string, unknown>, area: string) => {
      if ((area === 'local' || area === 'session') && Object.keys(changes).some((k) => relevantRef.current(k, area))) void run();
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, []);
  return value;
}

export const useProfile = () => useStored<Profile>(getProfile, (k, a) => a === 'local' && k === KEYS.profile);
export const useSettings = () => useStored<Settings>(getSettings, (k, a) => a === 'local' && k === KEYS.settings);
export const useJobs = () => useStored<JobRecord[]>(listJobs, (k, a) => a === 'local' && k.startsWith(PREFIX.job));
export const useApplications = () => useStored<ApplicationRecord[]>(listApplications, (k, a) => a === 'local' && k.startsWith(PREFIX.app));
export const useResumes = () => useStored<ResumeVersion[]>(listResumes, (k, a) => a === 'local' && k === KEYS.resumes);
export const useCoverLetters = () => useStored<Record<string, CoverLetter>>(getCoverLetters, (k, a) => a === 'local' && k === KEYS.coverLetters);
export const usePrep = () => useStored<Record<string, InterviewPrep>>(getAllPrep, (k, a) => a === 'local' && k === KEYS.interviewPrep);

export function useSessionValue<T>(key: string): T | undefined | null {
  const v = useStored<T | null>(
    async () => ((await browser.storage.session.get(key))[key] as T | undefined) ?? null,
    (k, a) => a === 'session' && k === key,
  );
  return v;
}

/** Tracks the active tab of the current window (no "tabs" permission needed: only the id is used). */
export function useActiveTabId(): number | null | undefined {
  const [tabId, setTabId] = useState<number | null>();
  useEffect(() => {
    const refresh = async () => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      setTabId(tab?.id ?? null);
    };
    void refresh();
    const onActivated = () => void refresh();
    const onFocus = () => void refresh();
    browser.tabs.onActivated.addListener(onActivated);
    browser.windows?.onFocusChanged.addListener(onFocus);
    return () => {
      browser.tabs.onActivated.removeListener(onActivated);
      browser.windows?.onFocusChanged.removeListener(onFocus);
    };
  }, []);
  return tabId;
}

export function useTabDetection(tabId: number | null | undefined): TabDetection | null | undefined {
  const [d, setD] = useState<TabDetection | null>();
  useEffect(() => {
    if (tabId === undefined) return;
    if (tabId === null) {
      setD(null);
      return;
    }
    let alive = true;
    const key = SESSION_KEYS.tab(tabId);
    const run = () => getDetection(tabId).then((v) => alive && setD(v));
    void run();
    const onChange = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && key in changes) void run();
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, [tabId]);
  return d;
}

/** Match for a single job; recomputed when the job content, profile or weights change. */
export function useMatch(job: (ExtractedJob & { fingerprint?: string }) | null | undefined, profile?: Profile, settings?: Settings) {
  const [result, setResult] = useState<MatchResult | null>();
  const fp = job ? (job.fingerprint ?? `${job.title}|${job.company}|${job.descriptionText.length}|${job.requiredQualifications.length}`) : '';
  useEffect(() => {
    if (!job || !profile || !settings) {
      setResult(job === null ? null : undefined);
      return;
    }
    let alive = true;
    void matchJob(job, { profile, settings }).then((r) => alive && setResult(r));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fp, profile?.version, settings && JSON.stringify(settings.weights), settings?.dealBreakerCap]);
  return result;
}

export function useMatches(jobs: JobRecord[] | undefined, profile?: Profile, settings?: Settings): Map<string, MatchResult> {
  const [map, setMap] = useState(new Map<string, MatchResult>());
  const sig = jobs?.map((j) => j.fingerprint).join(',') ?? '';
  useEffect(() => {
    if (!jobs || !profile || !settings) return;
    let alive = true;
    void matchJobs(jobs, { profile, settings }).then((m) => alive && setMap(m));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, profile?.version, settings && JSON.stringify(settings.weights), settings?.dealBreakerCap]);
  return map;
}

/** Runs an async action with busy/error state. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fnRef.current(...args);
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { run, busy, error, setError };
}

export const useAiUsage = () => useStored<AiUsage>(getUsage, (k, a) => a === 'local' && k === KEYS.aiUsage);

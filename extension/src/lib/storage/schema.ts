/**
 * Storage layout (chrome.storage.local unless noted):
 *
 *   meta             { schemaVersion, installedAt, lastMigratedAt }
 *   profile          Profile (canonical, versioned)
 *   settings         Settings
 *   resumes          ResumeVersion[]
 *   coverLetters     Record<jobId, CoverLetter>
 *   interviewPrep    Record<jobId, InterviewPrep>
 *   aiUsage          AiUsage counters
 *   aiCache          Record<key, CachedAiResult>
 *   matchCache       Record<cacheKey, MatchResult>
 *   analysisCache    Record<fingerprint, JobAnalysis>
 *   job:<id>         JobRecord             (one key per job → no lost updates)
 *   app:<id>         ApplicationRecord     (one key per application)
 *   file:<resumeId>  StoredFile            (the uploaded original résumé file)
 *   autofillLog      AutofillLogEntry[]    (last 50 runs: when, site, job title, counts; never form values)
 *
 * chrome.storage.session (cleared when the browser closes):
 *   tab:<tabId>      TabDetection for the page currently open in that tab
 *   ui:request       { view, jobId? } a view requested by the popup/context menu
 *   pending:manual   { text, url } text sent from the context menu
 *   autofill:<tabId> the last autofill report for that tab (shared by popup and side panel)
 *   jobContext:<tabId> the job analysed in that tab, kept across navigation so the application form is tailored to it
 */
export const SCHEMA_VERSION = 2;

export const KEYS = {
  meta: 'meta',
  profile: 'profile',
  settings: 'settings',
  resumes: 'resumes',
  coverLetters: 'coverLetters',
  interviewPrep: 'interviewPrep',
  aiUsage: 'aiUsage',
  aiCache: 'aiCache',
  matchCache: 'matchCache',
  analysisCache: 'analysisCache',
  autofillLog: 'autofillLog',
} as const;

export const PREFIX = { job: 'job:', app: 'app:', file: 'file:' } as const;

export const SESSION_KEYS = {
  tab: (tabId: number) => `tab:${tabId}`,
  uiRequest: 'ui:request',
  pendingManual: 'pending:manual',
  /** "Autofill this tab" from the right-click menu or keyboard shortcut, picked up by the side panel. */
  autofillRequest: 'request:autofill',
  /** Autofill failed on this tab for lack of access; the next toolbar-icon click on it (which grants access) retries. */
  autofillNeedsAccess: 'request:autofill-access',
  autofill: (tabId: number) => `autofill:${tabId}`,
  jobContext: (tabId: number) => `jobContext:${tabId}`,
} as const;

/** Keys that hold derived data and are excluded from exports. */
export const CACHE_KEYS = [KEYS.aiCache, KEYS.matchCache, KEYS.analysisCache] as const;

export interface Meta {
  schemaVersion: number;
  installedAt: string;
  lastMigratedAt?: string;
}

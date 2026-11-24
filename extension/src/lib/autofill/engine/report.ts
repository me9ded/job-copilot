import type { AutofillKey, StandardQuestion } from '../../types';
import type { ProfileKey, QuestionCategory } from './classify';
import type { QuestionKind } from './discover';

/**
 * The fill report: what was filled and verified, what was kept, what failed
 * and why, what still needs the applicant. Fields added since the first
 * version are optional, so reports stored by older builds still render.
 */

export type FilledKey = AutofillKey | ProfileKey | StandardQuestion | 'resume' | 'coverLetter' | 'saved' | 'consent' | 'history' | 'skill' | 'language';

/** explicit: written in the profile or a saved answer. inferred: derived from it (a name split, a province from the city). */
export type Basis = 'explicit' | 'inferred';

export interface FilledField {
  label: string;
  key: FilledKey;
  id?: string;
  basis?: Basis;
}

export interface Unanswered {
  label: string;
  required: boolean;
  /** What kind of control it is, so the side panel can offer the right input. */
  kind?: QuestionKind;
  /** The choices shown on the page (selects, radios, button groups, opened pickers). */
  options?: string[];
  maxLength?: number;
  /** Addresses this question on the page, even when another has the same label. */
  id?: string;
  frameId?: number;
  category?: QuestionCategory;
  section?: string;
  /** Why it wasn't answered: nothing saved, several choices fit, or it is the applicant's to answer (signatures). */
  reason?: 'no_answer' | 'ambiguous' | 'signature' | 'skill' | 'language';
}

export interface FailedField {
  label: string;
  reason: string;
  id?: string;
  frameId?: number;
  kind?: QuestionKind;
  options?: string[];
  required: boolean;
}

export interface SkippedField {
  label: string;
  reason: string;
}

export type ResumeStatus =
  | { status: 'attached'; file: string; label?: string }
  | { status: 'already'; file: string; label?: string }
  | { status: 'rejected'; reason: string; label?: string }
  | { status: 'not_accepted'; reason: string; label?: string }
  | { status: 'not_found' }
  | { status: 'off' }
  | { status: 'no_file' };

export interface FrameNote {
  host: string;
  url: string;
}

/**
 * Why filling stopped:
 * - submit_ready: everything reachable is filled and checked; the final submit button is next (the user presses it)
 * - needs_answers: required questions have no saved answer
 * - errors: the form rejected the step, or fields are invalid (messages in `errors`)
 * - captcha / login: the user has to do this part
 * - navigating: a button opened another page; press Autofill again there
 * - needs_access: the form moved to a page or frame Job Copilot may not open yet
 * - done: filled, no next or submit button found
 * - no_form: nothing fillable on the page
 */
export type StopReason = 'submit_ready' | 'needs_answers' | 'errors' | 'captcha' | 'login' | 'navigating' | 'needs_access' | 'max_steps' | 'done' | 'no_form';

export interface FillReport {
  url: string;
  /** Verified fields only. */
  filled: FilledField[];
  /** Fields that already had a value (kept unless overwrite is on). */
  kept: string[];
  /** Profile fields recognised but empty in the profile. */
  noValue: string[];
  /** Questions with no saved answer, for the user to answer. */
  unanswered: Unanswered[];
  steps: number;
  stop: StopReason;
  submitLabel?: string;
  errors: string[];
  resumeInputFound: boolean;
  /** Set by the extension: the saved job this application is for. */
  jobId?: string;
  /** Fields Job Copilot tried and couldn't fill (no matching choice, or the page refused the value). */
  failed?: FailedField[];
  /** Fields that took the value but changed or cleared it afterwards. */
  unverified?: FailedField[];
  /** Fields deliberately left alone (identity numbers, passwords). */
  skipped?: SkippedField[];
  resume?: ResumeStatus;
  frames?: { inaccessible: FrameNote[] };
  /** A Next button is waiting (stepping through was off). */
  moreSteps?: boolean;
  /** The form continues on a site Job Copilot needs permission for. */
  needsAccess?: { host: string; origin: string; url?: string };
  /** The application opened in another tab. */
  newTab?: { tabId: number; accessible: boolean };
  /** The tab the run ended in. */
  tabId?: number;
}

export function emptyReport(url: string): FillReport {
  return { url, filled: [], kept: [], noValue: [], unanswered: [], steps: 0, stop: 'done', errors: [], resumeInputFound: false, failed: [], unverified: [], skipped: [] };
}

const ORDER: StopReason[] = ['no_form', 'done', 'max_steps', 'submit_ready', 'needs_answers', 'errors', 'login', 'captcha', 'navigating', 'needs_access'];
export const moreImportant = (a: StopReason, b: StopReason) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

const RESUME_RANK: Record<ResumeStatus['status'], number> = { attached: 6, already: 5, rejected: 4, not_accepted: 3, off: 2, no_file: 1, not_found: 0 };

function uniqueBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const qKey = (x: { id?: string; label: string; frameId?: number }) => `${x.frameId ?? ''}|${x.id ?? x.label}`;

/** Adds `b` (a later step, or another frame) into `a`. The stop reason and URL come from `b` when `bLeads`. */
export function mergeInto(a: FillReport, b: FillReport, bLeads = false): FillReport {
  const out: FillReport = {
    ...a,
    filled: uniqueBy([...a.filled, ...b.filled], (f) => `${f.id ?? f.label}|${f.key}`),
    kept: [...new Set([...a.kept, ...b.kept])],
    noValue: [...new Set([...a.noValue, ...b.noValue])],
    unanswered: uniqueBy([...a.unanswered, ...b.unanswered], qKey),
    errors: [...new Set([...a.errors, ...b.errors])],
    failed: uniqueBy([...(a.failed ?? []), ...(b.failed ?? [])], qKey),
    unverified: uniqueBy([...(a.unverified ?? []), ...(b.unverified ?? [])], qKey),
    skipped: uniqueBy([...(a.skipped ?? []), ...(b.skipped ?? [])], (s) => s.label),
    resumeInputFound: a.resumeInputFound || b.resumeInputFound,
    steps: Math.max(a.steps, b.steps),
    stop: bLeads ? b.stop : moreImportant(a.stop, b.stop),
    url: bLeads ? b.url : a.url,
    submitLabel: bLeads ? (b.submitLabel ?? a.submitLabel) : (a.submitLabel ?? b.submitLabel),
    moreSteps: bLeads ? b.moreSteps : a.moreSteps || b.moreSteps,
    frames: { inaccessible: uniqueBy([...(a.frames?.inaccessible ?? []), ...(b.frames?.inaccessible ?? [])], (f) => f.url) },
    needsAccess: b.needsAccess ?? a.needsAccess,
    newTab: b.newTab ?? a.newTab,
    tabId: b.tabId ?? a.tabId,
  };
  const ra = a.resume;
  const rb = b.resume;
  out.resume = !ra ? rb : !rb ? ra : RESUME_RANK[rb.status] >= RESUME_RANK[ra.status] ? rb : ra;
  // Answered on a later pass or step: no longer outstanding.
  const done = new Set(out.filled.map((f) => f.id ?? f.label));
  out.unanswered = out.unanswered.filter((u) => !done.has(u.id ?? u.label));
  out.failed = out.failed!.filter((u) => !done.has(u.id ?? u.label));
  return out;
}

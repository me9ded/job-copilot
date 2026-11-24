import { parseLocation } from '../geo';
import type { AutofillKey, StandardQuestion } from '../types';
import { classifyField, classifyQuestion, categoryOf, COUNTRY_CODE_RE, type ProfileKey } from './engine/classify';
import { applyAnswerDetailed, attachFile, type ApplyResult, type FillFile } from './engine/controls';
import { detectScope, scopedQuestions, type FormScope } from './engine/detect';
import { findQuestions, questionOptions, weightedDescriptors, type Question } from './engine/discover';
import { deepAll, isVisible } from './engine/dom';
import { press } from './engine/interact';
import { countryValues, degreeValues, joinFit, locationValues, nationalNumber, phoneCodeValues, stateValues } from './engine/match';
import { claimed, highlightTarget, mark, ours, written } from './engine/mark';
import { settle, waitForDom } from './engine/observe';
import { emptyReport, type Basis, type FilledField, type FilledKey, type FillReport, type Unanswered } from './engine/report';
import { buttonText, errorsOnPage, findNext, findOpenForm, findSubmit, hasCaptcha, mayOpenForm, needsLogin, readiness, stepSignature } from './engine/steps';
import { normalize, sameQuestion } from './engine/text';
import { hasValue, holds, type Expect } from './engine/verify';
import { fillHistory } from './history';
import { runSteps, type AdvanceOutcome, type StepDriver, type StepFacts, type StepResult } from './progress';

/**
 * Application-form autofill. Runs inside the page (isolated world), only after
 * the user presses Autofill. It types profile values, picks options in
 * selects / radios / checkboxes / pickers and attaches files the way the user
 * would, and reads every field back: only values the page kept count as
 * filled.
 *
 * It answers screening questions only with answers the user saved, never
 * guesses, and stops at the final submit button, CAPTCHAs and logins. It
 * never submits.
 */

export * from './engine/report';
export type { QuestionKind, Question } from './engine/discover';
export type { FillFile } from './engine/controls';
export type { QuestionCategory } from './engine/classify';
export { normalize, textOf } from './engine/text';
export { deepAll } from './engine/dom';
export { descriptors, findQuestions, questionOptions } from './engine/discover';
export { optionScore, nationalNumber, toIsoDate } from './engine/match';
export { applyAnswer } from './engine/controls';
export { hasValue, pickedText } from './engine/verify';
export { press } from './engine/interact';
export { settle, waitFor, waitForDom } from './engine/observe';
export { visibleButtons, findSubmit } from './engine/steps';
export { claimed, highlight, highlightTarget, ours } from './engine/mark';

export type FillData = Record<AutofillKey, string>;

export interface AnswerBank {
  standard: Partial<Record<StandardQuestion, string>>;
  saved: Array<{ question: string; answer: string }>;
  /** A saved cover letter for this job, if any. */
  coverLetter?: string;
  coverLetterFile?: FillFile;
  tickConsent: boolean;
}

/** Work history and education, for forms with repeatable "Add experience" sections. */
export interface HistoryEntry {
  title: string;
  company: string;
  location: string;
  /** YYYY-MM or YYYY */
  start: string;
  /** YYYY-MM, YYYY or "present" */
  end: string;
  description: string;
}
export interface EducationEntry {
  school: string;
  degree: string;
  field: string;
  start: string;
  end: string;
}
export interface FillHistory {
  experience: HistoryEntry[];
  education: EducationEntry[];
}

/** Lists from the profile for "Skills" / "Languages" fields and "Do you have experience with X?" questions. */
export interface FillLists {
  skills: string[];
  languages: string[];
  certifications: string[];
}

export interface FillRequest {
  data: FillData;
  history?: FillHistory;
  resume?: FillFile;
  /** 'off' when the user chose not to attach a résumé. */
  resumeMode?: 'file' | 'off';
  overwrite: boolean;
  answers: AnswerBank;
  /** Press Next / Continue between steps. */
  advance: boolean;
  maxSteps?: number;
  lists?: FillLists;
  /** Values derived from others (a first name split from the full name, a province from the location). */
  inferred?: AutofillKey[];
}

/* ----------------------------------------------------------------------------
 * Answers
 * ------------------------------------------------------------------------- */

type Resolved =
  | { values: string[]; key: FilledKey; basis: Basis; place?: boolean }
  | { file: FillFile; key: 'resume' | 'coverLetter' }
  | { never: true }
  | { missing: 'profile' | 'question'; reason?: Unanswered['reason'] };

function savedAnswerFor(label: string, req: FillRequest): string | null {
  let best: { answer: string; score: number } | null = null;
  const nl = normalize(label);
  for (const s of req.answers.saved) {
    const ns = normalize(s.question);
    const score = ns === nl ? 1 : sameQuestion(ns, nl);
    if (score > 0 && (!best || score > best.score)) best = { answer: s.answer, score };
  }
  return best?.answer ?? null;
}

function hasCountryCodeControl(doc: Document): boolean {
  return deepAll<HTMLElement>(doc, 'input:not([type=hidden]), select, [role=combobox], button[aria-haspopup=listbox]').some(
    (el) => weightedDescriptors(el).some((d) => d.w >= 0.5 && COUNTRY_CODE_RE.test(d.text)) && isVisible(el),
  );
}

const listKey = (s: string) => normalize(s.replace(/\(.*?\)/g, '')).replace(/\s+/g, '');

/** Candidate values for a profile field, best first (a phone as saved, then national, then digits only). */
function profileValues(key: ProfileKey, req: FillRequest, q: Question): string[] {
  const d = req.data;
  const max = (q.el as HTMLInputElement).maxLength > 0 ? (q.el as HTMLInputElement).maxLength : Infinity;
  const place = parseLocation(d.location ?? '');
  switch (key) {
    case 'phone': {
      const v = d.phone?.trim();
      if (!v) return [];
      const national = nationalNumber(v);
      // With a separate country-code picker (Workday, many careers sites), "+1 613…" in the number box fails validation.
      const list = hasCountryCodeControl(q.el.ownerDocument) ? [national, national.replace(/\D/g, '')] : [v, national, v.replace(/[^\d+]/g, '')];
      return [...new Set(list.filter(Boolean))];
    }
    case 'phoneCode':
      return phoneCodeValues(d.country || place.country || place.countryCode, d.phone ?? '', q.kind !== 'text');
    case 'location':
      return d.location ? locationValues(d.location, d.state, d.country) : [];
    case 'state':
      return d.state ? stateValues(d.state) : [];
    case 'country':
      return d.country ? countryValues(d.country) : [];
    case 'degree':
      return d.degree ? degreeValues(d.degree) : [];
    case 'linkedin':
    case 'github':
    case 'website':
      return d[key] ? [...new Set([d[key], d[key].replace(/^https?:\/\//, '')])] : [];
    case 'skills':
    case 'languages':
    case 'certifications': {
      const v = joinFit(req.lists?.[key] ?? [], max);
      return v ? [v] : [];
    }
    default:
      return d[key] ? [d[key]] : [];
  }
}

export function resolve(q: Question, req: FillRequest): Resolved {
  const c = classifyQuestion(q);
  if (c.type === 'never') return { never: true };
  if (c.type === 'file') {
    if (c.doc === 'cover') return req.answers.coverLetterFile ? { file: req.answers.coverLetterFile, key: 'coverLetter' } : { missing: 'question' };
    if (c.doc === 'resume') return req.resume ? { file: req.resume, key: 'resume' } : { missing: 'question' };
    return { missing: 'question' };
  }
  // Signing is the applicant's act, even with a saved answer.
  if (c.type === 'signature') return { missing: 'question', reason: 'signature' };
  const saved = savedAnswerFor(q.label, req);
  if (saved !== null) return { values: [saved], key: 'saved', basis: 'explicit' };
  switch (c.type) {
    case 'consent':
      return req.answers.tickConsent ? { values: ['yes'], key: 'consent', basis: 'explicit' } : { missing: 'question' };
    case 'coverText':
      return req.answers.coverLetter ? { values: [req.answers.coverLetter], key: 'coverLetter', basis: 'explicit' } : { missing: 'question' };
    case 'standard': {
      const v = req.answers.standard[c.key]?.trim();
      return v ? { values: [v], key: c.key, basis: 'explicit' } : { missing: 'question' };
    }
    case 'skill': {
      // Yes only for a skill written on the résumé; anything else is the applicant's call.
      const has = (req.lists?.skills ?? []).some((s) => listKey(s) === listKey(c.skill));
      return has ? { values: ['Yes'], key: 'skill', basis: 'explicit' } : { missing: 'question', reason: 'skill' };
    }
    case 'language': {
      const has = (req.lists?.languages ?? []).some((s) => listKey(s).startsWith(listKey(c.language)));
      return has ? { values: ['Yes'], key: 'language', basis: 'explicit' } : { missing: 'question', reason: 'language' };
    }
    case 'profile': {
      const values = profileValues(c.key, req, q);
      if (!values.length) return { missing: 'profile' };
      const inferred = c.key === 'phoneCode' || (req.inferred ?? []).includes(c.key as AutofillKey);
      return { values, key: c.key, basis: inferred ? 'inferred' : 'explicit', place: c.key === 'location' || c.key === 'city' };
    }
    default:
      return { missing: 'question' };
  }
}

/** Kept for callers that only need the profile key of a text field. */
export function classify(el: HTMLInputElement | HTMLTextAreaElement): AutofillKey | StandardQuestion | 'never' | null {
  return classifyField(el, weightedDescriptors(el));
}

/* ----------------------------------------------------------------------------
 * One step: fill everything visible, then check it
 * ------------------------------------------------------------------------- */

/** Values that may go into more than one field (an email confirmation, the same saved answer). */
const REPEATABLE = new Set<FilledKey>(['email', 'saved', 'consent']);

function unansweredOf(q: Question, frameId: number | undefined, reason: Unanswered['reason'], options?: string[]): Unanswered {
  const max = (q.el as HTMLInputElement).maxLength;
  return { id: q.id, frameId, label: q.label, required: q.required, kind: q.kind, options: options ?? questionOptions(q), maxLength: max > 0 ? max : undefined, category: categoryOf(q), section: q.section || undefined, reason };
}

async function tryValues(q: Question, values: string[], place?: boolean): Promise<ApplyResult> {
  let last: ApplyResult | null = null;
  for (const v of values) {
    const out = await applyAnswerDetailed(q, v, { place });
    if (out.ok || out.reason === 'ambiguous') return out;
    last = out;
  }
  return last ?? { ok: false, reason: 'no_option', message: 'Nothing to fill.' };
}

async function handleFile(q: Question, r: Resolved, req: FillRequest, report: FillReport, frameId?: number): Promise<boolean> {
  const c = classifyQuestion(q);
  const isResume = c.type === 'file' && c.doc === 'resume';
  if (isResume) report.resumeInputFound = true;
  if (!('file' in r)) {
    if (isResume) report.resume = req.resumeMode === 'off' ? { status: 'off' } : { status: 'no_file' };
    return false;
  }
  const input = q.el as HTMLInputElement;
  const out = await attachFile(input, r.file, req.overwrite && !ours.has(input));
  const what = r.key === 'resume' ? 'Résumé' : 'Cover letter';
  if (out.status === 'attached') {
    ours.add(input);
    report.filled.push({ label: `${what} (${out.name})`, key: r.key, id: q.id, basis: 'explicit' });
    if (r.key === 'resume') report.resume = { status: 'attached', file: out.name, label: q.label };
    const t = highlightTarget(q);
    if (isVisible(t)) mark(t, 'filled');
    return true;
  }
  if (out.status === 'already') {
    if (!ours.has(input) && !report.kept.includes(q.label)) report.kept.push(q.label);
    if (r.key === 'resume') report.resume = { status: 'already', file: out.name, label: q.label };
    return false;
  }
  if (r.key === 'resume') report.resume = { status: out.status, reason: out.reason, label: q.label };
  report.failed!.push({ id: q.id, frameId, label: `${what}: ${q.label}`, reason: out.reason, kind: 'file', required: q.required });
  const t = highlightTarget(q);
  if (isVisible(t)) mark(t, 'failed');
  return false;
}

export interface StepOptions {
  frameId?: number;
  /** Wait this long for the first application field to render (after a page change). */
  waitMs?: number;
}

/**
 * Fills the visible questions of the current step. Answering one can reveal
 * follow-ups ("If yes, please explain"), so the step is re-scanned (up to six
 * passes) while new questions keep appearing. Everything filled is checked
 * again once the page settles; values a framework reverted are moved to
 * `unverified`.
 */
export async function fillStep(doc: Document, req: FillRequest, report: FillReport, opts: StepOptions = {}): Promise<void> {
  if (opts.waitMs) await waitForDom(doc, () => scopedQuestions(doc).length > 0, opts.waitMs);
  const frameId = opts.frameId;
  // Work-history / education entries first: a "My Experience" step may only show "Add" buttons.
  if (req.history) {
    await fillHistory(doc, req, report);
    for (const f of report.failed ?? []) f.frameId ??= frameId;
  }
  const used = new Set<FilledKey>();
  const seen = new Set<string>();
  const filledNow: Array<{ q: Question; expect: Expect; field: FilledField }> = [];
  const failed = report.failed!;
  const pushUnanswered = (u: Unanswered) => {
    if (!report.unanswered.some((x) => (x.id ?? x.label) === (u.id ?? u.label))) report.unanswered.push(u);
  };
  for (let pass = 0; pass < 6; pass++) {
    const scope = detectScope(doc);
    const questions = scopedQuestions(doc, scope).filter((q) => !seen.has(q.id) && !claimed.has(q.el));
    if (!questions.length) break;
    let changed = false;
    for (const q of questions) {
      seen.add(q.id);
      const r = resolve(q, req);
      if (q.kind === 'file') {
        changed = (await handleFile(q, r, req, report, frameId)) || changed;
        continue;
      }
      if ('never' in r) {
        if (!report.skipped!.some((s) => s.label === q.label)) report.skipped!.push({ label: q.label, reason: 'Never filled automatically (identity numbers, passwords, payment details).' });
        continue;
      }
      if (hasValue(q)) {
        // Filled by Job Copilot earlier, or edited by the user since: never touched again.
        if (ours.has(q.el)) continue;
        if (!req.overwrite) {
          if (!('missing' in r) && !report.kept.includes(q.label)) report.kept.push(q.label);
          continue;
        }
      }
      if ('missing' in r) {
        if (r.missing === 'profile') {
          if (!report.noValue.includes(q.label)) report.noValue.push(q.label);
        } else if (q.kind !== 'checkbox' || q.required) pushUnanswered(unansweredOf(q, frameId, r.reason ?? 'no_answer'));
        continue;
      }
      if (!('values' in r)) continue;
      // A profile value goes into the first matching field only (a second "email" is a confirmation).
      if (used.has(r.key) && !REPEATABLE.has(r.key)) continue;
      const out = await tryValues(q, r.values, r.place);
      if (out.ok) {
        changed = true;
        used.add(r.key);
        ours.add(q.el);
        q.members.forEach((m) => ours.add(m));
        written.set(q.el, out.value);
        mark(highlightTarget(q), 'filled');
        const field: FilledField = { label: q.label, key: r.key, id: q.id, basis: r.basis };
        report.filled.push(field);
        filledNow.push({ q, expect: out.expect, field });
        report.unanswered = report.unanswered.filter((u) => (u.id ?? u.label) !== q.id);
        continue;
      }
      if (out.reason === 'ambiguous') {
        pushUnanswered(unansweredOf(q, frameId, 'ambiguous', out.options));
        continue;
      }
      failed.push({ id: q.id, frameId, label: q.label, reason: out.message, kind: q.kind, options: out.options ?? questionOptions(q), required: q.required });
      mark(highlightTarget(q), 'failed');
    }
    if (!changed) break;
    await settle(doc, 150, 1500);
  }
  if (filledNow.length) await recheck(doc, filledNow, report, frameId);
}

/** The second check: a value a framework reverted or replaced after the page settled is not "filled". */
async function recheck(doc: Document, filled: Array<{ q: Question; expect: Expect; field: FilledField }>, report: FillReport, frameId?: number) {
  await settle(doc, 120, 1200);
  let current: Question[] | null = null;
  for (const f of filled) {
    let q: Question | undefined = f.q;
    if (!q.el.isConnected) {
      // Re-rendered: find the same field again by its id.
      current ??= scopedQuestions(doc);
      q = current.find((x) => x.id === f.q.id && x.kind === f.q.kind);
    }
    if (q && holds(q, f.expect)) continue;
    report.filled = report.filled.filter((x) => x !== f.field);
    ours.delete(f.q.el);
    report.unverified!.push({ id: f.q.id, frameId, label: f.q.label, reason: q ? 'The page changed or cleared the value after it was filled.' : 'The field was replaced after it was filled; check it on the page.', kind: f.q.kind, required: f.q.required });
    if (q) mark(highlightTarget(q), 'failed');
  }
}

/** Facts about the step after filling it: buttons, blockers and what is still empty. */
export function stepFacts(doc: Document, report: FillReport, frameId?: number): StepFacts {
  const scope = detectScope(doc);
  const qs = scopedQuestions(doc, scope);
  const form = qs.length > 0;
  const ready = form ? readiness(doc, scope) : { empty: [], invalid: [] };
  for (const q of ready.empty) {
    const listed = report.unanswered.some((u) => u.id === q.id) || report.failed!.some((u) => u.id === q.id) || report.noValue.includes(q.label);
    if (!listed && q.kind !== 'file') report.unanswered.push(unansweredOf(q, frameId, 'no_answer'));
    mark(highlightTarget(q), 'needed');
  }
  const next = form ? findNext(doc, scope) : null;
  const submit = findSubmit(doc, scope);
  const open = !form && mayOpenForm(doc) ? findOpenForm(doc, scope) : null;
  const facts: StepFacts = {
    form,
    next: next ? buttonText(next) || 'Next' : undefined,
    submit: submit ? buttonText(submit) || 'Submit' : undefined,
    open: open ? buttonText(open) || 'Apply' : undefined,
    captcha: hasCaptcha(doc),
    login: needsLogin(doc) && (!form || qs.every((q) => /e ?mail|user|password|login/.test(q.ds.join(' ')))),
    missing: ready.empty.length,
    invalid: ready.invalid,
  };
  // The final step, checked and clean: point at the submit button the user will press.
  if (submit && !next && !facts.missing && !facts.invalid.length && !facts.captcha) {
    submit.style.outline = '3px solid #3b7282';
    submit.style.outlineOffset = '2px';
  }
  return facts;
}

/** Fills the current step of this document and describes it. */
export async function fillOnce(doc: Document, req: FillRequest, opts: StepOptions = {}): Promise<StepResult> {
  const report = emptyReport(doc.location?.href ?? '');
  await fillStep(doc, req, report, opts);
  if (req.resumeMode === 'off' && !report.resume && report.resumeInputFound) report.resume = { status: 'off' };
  return { report, facts: stepFacts(doc, report, opts.frameId) };
}

/* ----------------------------------------------------------------------------
 * Moving between steps
 * ------------------------------------------------------------------------- */

/** Where an "Apply" control leads, when it is a link to another page. */
export function leavingHref(doc: Document, el: HTMLElement): string | null {
  const view = doc.defaultView ?? window;
  const anchor = el instanceof view.HTMLAnchorElement ? el : el.closest('a[href]');
  const href = anchor instanceof view.HTMLAnchorElement ? anchor.href : '';
  if (!href || !/^https?:/i.test(href)) return null;
  return new URL(href, doc.baseURI).href.split('#')[0] !== (doc.location?.href ?? '').split('#')[0] ? href : null;
}

/**
 * The in-page driver: fills and advances within one document. A link to
 * another page ends its run ("navigating"); the extension's tab driver
 * follows such links instead.
 */
export function pageDriver(doc: Document, req: FillRequest): StepDriver {
  return {
    fill: () => fillOnce(doc, req),
    async advance(how): Promise<AdvanceOutcome> {
      const scope: FormScope = detectScope(doc);
      if (how === 'open') {
        const open = findOpenForm(doc, scope);
        if (!open) return { outcome: 'unchanged', errors: [] };
        const href = leavingHref(doc, open);
        if (href) {
          // Followed in this tab: pressing it opened target=_blank links in a new tab (or got them popup-blocked).
          setTimeout(() => doc.location.assign(href), 50);
          return { outcome: 'leaving' };
        }
        press(open);
        await settle(doc, 300, 4000);
        await waitForDom(doc, () => scopedQuestions(doc).length > 0 || needsLogin(doc), 3000);
        return { outcome: 'moved' };
      }
      const next = findNext(doc, scope);
      if (!next) return { outcome: 'unchanged', errors: [] };
      const before = stepSignature(doc);
      press(next);
      await settle(doc, 300, 5000);
      const moved = await waitForDom(doc, () => stepSignature(doc) !== before, 2500);
      return moved ? { outcome: 'moved' } : { outcome: 'unchanged', errors: errorsOnPage(doc) };
    },
  };
}

/**
 * Fills the form step by step in this document. Presses Next / Continue
 * (when `advance` is on) until the final submit button, a CAPTCHA, a login,
 * a validation error or a required question without a saved answer. Never
 * presses submit.
 */
export async function runApplication(doc: Document, req: FillRequest): Promise<FillReport> {
  return runSteps(pageDriver(doc, req), { advance: req.advance, maxSteps: req.maxSteps });
}

/* ----------------------------------------------------------------------------
 * Answers typed in the side panel
 * ------------------------------------------------------------------------- */

export type AnswerOutcome = { ok: true; value: string } | { ok: false; reason: 'not_found' | ApplyResultReason; message: string; options?: string[] };
type ApplyResultReason = Exclude<ApplyResult, { ok: true }>['reason'];

/** Answers one question (by its id, or its label for older reports) with a value the user typed in the side panel. */
export async function answerQuestionDetailed(doc: Document, idOrLabel: string, value: string): Promise<AnswerOutcome> {
  const qs = findQuestions(doc);
  const q = qs.find((x) => x.id === idOrLabel) ?? qs.find((x) => x.label === idOrLabel);
  if (!q || q.kind === 'file') return { ok: false, reason: 'not_found', message: 'That question is no longer on the page.' };
  const c = classifyQuestion(q);
  const out = await applyAnswerDetailed(q, value, { place: c.type === 'profile' && (c.key === 'location' || c.key === 'city') });
  if (!out.ok) return { ok: false, reason: out.reason, message: out.message, options: out.options };
  ours.add(q.el);
  q.members.forEach((m) => ours.add(m));
  written.set(q.el, out.value);
  mark(highlightTarget(q), 'filled');
  return { ok: true, value: out.value };
}

export async function answerQuestion(doc: Document, idOrLabel: string, value: string): Promise<boolean> {
  return (await answerQuestionDetailed(doc, idOrLabel, value)).ok;
}

/** Scrolls a question into view and outlines it ("Show on page"). */
export function revealQuestion(doc: Document, idOrLabel: string): boolean {
  const qs = findQuestions(doc);
  const q = qs.find((x) => x.id === idOrLabel) ?? qs.find((x) => x.label === idOrLabel);
  if (!q) return false;
  const t = highlightTarget(q);
  t.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  mark(t, hasValue(q) ? 'filled' : 'needed');
  return true;
}

export type SubmitOutcome = { status: 'submitted' | 'errors' | 'unknown' | 'not_found' | 'captcha'; label?: string; errors: string[] };

/** Presses the final submit button. Not called by the extension: submitting is always the user's own click. */
export async function submitApplication(doc: Document): Promise<SubmitOutcome> {
  if (hasCaptcha(doc)) return { status: 'captcha', errors: [] };
  const btn = findSubmit(doc);
  if (!btn) return { status: 'not_found', errors: [] };
  const label = buttonText(btn) || 'Submit';
  press(btn);
  await settle(doc, 500, 8000);
  const done = await waitForDom(
    doc,
    () => /thank you|thanks for applying|application (has been |was )?(received|submitted|sent|complete)|we('ve| have) received your application|successfully (submitted|applied)/i.test(doc.body?.innerText ?? doc.body?.textContent ?? '') || !findSubmit(doc),
    3000,
  );
  if (done) return { status: 'submitted', label, errors: [] };
  const errors = errorsOnPage(doc);
  return { status: errors.length ? 'errors' : 'unknown', label, errors };
}

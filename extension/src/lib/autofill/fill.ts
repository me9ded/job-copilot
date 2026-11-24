import type { AutofillKey, StandardQuestion } from '../types';
import { fillHistory } from './history';
import { formSiteFor } from './sites';

/**
 * Application-form autofill. Runs inside the page (isolated world), only after
 * the user presses a Fill button. It types profile values, picks options in
 * selects / radios / checkboxes / pickers, attaches files and (if enabled)
 * presses Next / Continue through multi-step forms, the way the user would.
 *
 * It answers screening questions only with answers the user saved, never
 * guesses, and stops at the final submit button, CAPTCHAs and logins. The
 * submit button is pressed only by `submitApplication`, which the extension
 * calls after the user confirms in the side panel.
 */

export type FillData = Record<AutofillKey, string>;

export interface FillFile {
  name: string;
  type: string;
  base64: string;
}

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

export interface FillRequest {
  data: FillData;
  history?: FillHistory;
  resume?: FillFile;
  overwrite: boolean;
  answers: AnswerBank;
  /** Press Next / Continue between steps. */
  advance: boolean;
  maxSteps?: number;
}

export type FilledKey = AutofillKey | StandardQuestion | 'resume' | 'coverLetter' | 'saved' | 'consent' | 'history';

export interface FilledField {
  label: string;
  key: FilledKey;
}

export interface Unanswered {
  label: string;
  required: boolean;
  /** What kind of control it is, so the side panel can offer the right input. */
  kind?: QuestionKind;
  /** The choices shown on the page (selects, radios, button groups). */
  options?: string[];
  maxLength?: number;
}

/**
 * Why filling stopped:
 * - submit_ready: everything reachable is filled and the final submit button is next (pressed only after confirmation)
 * - needs_answers: required questions on this step have no saved answer
 * - errors: the form rejected the step (validation messages in `errors`)
 * - captcha / login: the user has to do this part
 * - navigating: a button opened another page; the extension continues there
 * - done: filled, no next or submit button found
 * - no_form: nothing fillable on the page
 */
export type StopReason = 'submit_ready' | 'needs_answers' | 'errors' | 'captcha' | 'login' | 'navigating' | 'max_steps' | 'done' | 'no_form';

export interface FillReport {
  url: string;
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
}

/* ----------------------------------------------------------------------------
 * Text helpers
 * ------------------------------------------------------------------------- */

export function normalize(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[’‘]/g, "'")
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-[\].:*()?!/,"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const cleanLabel = (s: string) => s.replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').trim().slice(0, 160);

export function textOf(el: Element | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, button, script, style, [role=listbox], [role=option]').forEach((n) => n.remove());
  return clone.textContent ?? '';
}

// "us" is deliberately not a stop word: it is also the country.
const STOP_WORDS = new Set('a an the of to in for and or you your are is do does did be have has will would with on at this that what which how if any we our please'.split(' '));
const tokens = (s: string) => new Set(normalize(s).split(' ').filter((t) => t.length > 1 && !STOP_WORDS.has(t)));

function overlap(a: string, b: string): { jaccard: number; contained: number } {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return { jaccard: 0, contained: 0 };
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return { jaccard: common / (ta.size + tb.size - common), contained: common / Math.min(ta.size, tb.size) };
}
const similarity = (a: string, b: string) => overlap(a, b).jaccard;

/** Same question in different words: nearly the same terms, or one phrasing fully inside the other. */
function sameQuestion(a: string, b: string): number {
  const { jaccard, contained } = overlap(a, b);
  if (jaccard >= 0.75) return jaccard;
  return contained === 1 && jaccard >= 0.5 ? 0.75 + jaccard / 10 : 0;
}

/* ----------------------------------------------------------------------------
 * Rules
 * ------------------------------------------------------------------------- */

/** Never filled, even with a saved answer: identity numbers, secrets, CAPTCHAs. */
const NEVER_RE = /password|captcha|\bssn\b|social security|\bsin\b|social insurance|national (id|insurance)|passport|date of birth|birth ?date|credit card|card number|bank account|routing number/;

/** Profile values. Ordered: the first rule whose pattern matches any descriptor wins. */
const PROFILE_RULES: Array<{ key: AutofillKey; re: RegExp; not?: RegExp }> = [
  { key: 'linkedin', re: /linked ?in/ },
  { key: 'github', re: /git ?hub/ },
  { key: 'website', re: /portfolio|website|web site|personal (site|url|page)|home ?page|\bblog\b|^urls? other$|^url$/, not: /linked ?in|git ?hub|twitter|facebook|instagram|company/ },
  { key: 'email', re: /e ?mail/ },
  { key: 'phone', re: /phone|mobile|\btel\b|telephone|\bcell\b/, not: /type|country code|extension|\bext\b/ },
  { key: 'firstName', re: /\b(first|given|fore) ?name\b|firstname|givenname|^fname$/ },
  { key: 'lastName', re: /\b(last|family|sur) ?name\b|lastname|surname|familyname|^lname$/ },
  { key: 'fullName', re: /^(full |your |legal |candidate |applicant )?name$|\bfull ?name\b|\byour name\b|^system ?field name$/ },
  { key: 'currentCompany', re: /\b(current|present|most recent|latest) (company|employer|organi[sz]ation)\b|^(company|employer|organi[sz]ation|org)( name)?$/ },
  { key: 'currentTitle', re: /\b(current|present|most recent|latest) (job )?(title|role|position)\b|^(current )?job title$|^headline$/ },
  { key: 'location', re: /location|where (are you|do you) (located|live|based)|current address|^address$|city.*(state|country|province)/, not: /street|line ?\d|zip|postal|willing|prefer|relocat/ },
  { key: 'city', re: /^city$|\bcity\b|\btown\b/ },
  { key: 'school', re: /^(school|university|college|institution)( name)?$|school name|\bschool\b|\buniversity\b/, not: /high school|degree|year|date/ },
  { key: 'degree', re: /\bdegree\b/, not: /year|date|level of|require/ },
  { key: 'discipline', re: /discipline|\bmajor\b|field of study|area of study/ },
];

/** Screening questions. Matched before profile rules; answered only from the user's saved answers. */
const STANDARD_RULES: Array<{ key: StandardQuestion; re: RegExp }> = [
  { key: 'sponsorship', re: /sponsor|visa (status|support)|h ?1 ?b/ },
  { key: 'workAuthorized', re: /authori[sz]ed to work|authori[sz]ation to work|work authori[sz]ation|legally (allowed|able|eligible|permitted|entitled) to work|right to work|eligib\w* to work/ },
  { key: 'relocate', re: /relocat/ },
  { key: 'over18', re: /\b18\b.*(years|older|age)|eighteen|at least 18|legal (working )?age/ },
  { key: 'salary', re: /salary|compensation|pay (expectation|range|requirement)|desired pay|expected (pay|rate)|hourly rate/ },
  { key: 'startDate', re: /start date|available to start|earliest (start|date|availability)|notice period|when (can|could) you start|date available/ },
  // Total experience only: "years of Python experience" is a skill question, drafted in the side panel.
  { key: 'yearsExperience', re: /\byears of (professional |relevant |work |industry |total )?experience\b|how many years (of )?(professional |relevant |work |industry |total )?(experience|have you worked)/ },
  { key: 'hearAbout', re: /how did you (hear|find|learn|discover)|where did you (hear|find|see|learn)|referral source|source of (application|referral)/ },
  { key: 'hispanic', re: /hispanic|latin[oax]/ },
  { key: 'race', re: /\brace\b|ethnic/ },
  { key: 'gender', re: /gender|\bsex\b/ },
  { key: 'veteran', re: /veteran|military service/ },
  { key: 'disability', re: /disab/ },
  { key: 'pronouns', re: /pronoun/ },
];

const RESUME_RE = /resume|résumé|\bcv\b|curriculum/;
const COVER_RE = /cover ?letter|motivation letter|letter of (interest|motivation)/;
const CONSENT_RE = /\bi (agree|acknowledge|consent|certify|confirm|understand|accept|attest)|privacy (policy|notice)|terms (of|and)|data (processing|protection)|gdpr/;

const AUTOCOMPLETE: Record<string, AutofillKey> = {
  'given-name': 'firstName',
  'family-name': 'lastName',
  name: 'fullName',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  organization: 'currentCompany',
  'organization-title': 'currentTitle',
  url: 'website',
  'address-level2': 'city',
};

/* ----------------------------------------------------------------------------
 * Question discovery
 * ------------------------------------------------------------------------- */

export type QuestionKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'combobox' | 'listbox' | 'file' | 'buttons' | 'date';

export interface Question {
  kind: QuestionKind;
  label: string;
  ds: string[];
  el: HTMLElement;
  members: HTMLInputElement[];
  /** Option buttons of a 'buttons' question (Yes / No toggles). */
  choices?: HTMLElement[];
  required: boolean;
}

type TextControl = HTMLInputElement | HTMLTextAreaElement;

type Root = Document | Element | ShadowRoot;

/** querySelectorAll that also looks inside open shadow roots (web-component forms). */
export function deepAll<T extends Element = HTMLElement>(root: Root, selector: string): T[] {
  const out: T[] = [];
  const walk = (r: Root) => {
    out.push(...Array.from(r.querySelectorAll<T>(selector)));
    for (const el of Array.from(r.querySelectorAll('*'))) if (el.shadowRoot) walk(el.shadowRoot);
  };
  walk(root);
  return out;
}

/** The document or shadow root an element lives in (for aria-labelledby lookups). */
function rootOf(el: Element): Document | ShadowRoot {
  const r = el.getRootNode();
  return r instanceof el.ownerDocument.defaultView!.ShadowRoot ? (r as ShadowRoot) : el.ownerDocument;
}
const byId = (el: Element, id: string) => rootOf(el).getElementById(id);

/** Parent, crossing out of a shadow root to its host. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const r = el.getRootNode();
  return (r as ShadowRoot).host ?? null;
}

/** Label-ish text sources for a control, most specific first. */
export function descriptors(el: HTMLElement): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const n = normalize(s);
    if (n && n.length <= 300 && !out.includes(n)) out.push(n);
  };
  push(el.getAttribute('autocomplete')?.replace(/^(section-\S+\s+)?(shipping |billing )?/, ''));
  push(el.getAttribute('name'));
  push(el.id);
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) push(textOf(l));
  push(textOf(el.closest('label')));
  push(el.getAttribute('aria-label'));
  for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) push(textOf(byId(el, id)));
  push(el.getAttribute('placeholder'));
  push(el.getAttribute('title'));
  push(el.getAttribute('data-qa'));
  push(el.getAttribute('data-automation-id'));
  // Unlabelled ATS markup: the text of the nearest container that holds only this control.
  if (out.length < 4) {
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (node.querySelectorAll('input:not([type=hidden]), textarea, select, [role=combobox], button[aria-haspopup=listbox]').length > 1) break;
      const t = normalize(textOf(node));
      if (t) {
        push(t.slice(0, 200));
        break;
      }
    }
  }
  return out;
}

/** The label as shown (a trailing "*" is kept so `isRequired` can see it). */
function visibleLabel(el: HTMLElement, fallback: string): string {
  const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();
  const labels = (el as HTMLInputElement).labels;
  const fromLabel = labels?.[0] ? collapse(textOf(labels[0])) : '';
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const fromIds = ids.length ? collapse(ids.map((id) => textOf(byId(el, id))).join(' ')) : '';
  return fromLabel || fromIds || el.getAttribute('aria-label') || el.getAttribute('placeholder') || fallback;
}

function isVisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view || !(el instanceof view.HTMLElement)) return false;
  for (let n: Element | null = el; n; n = parentOf(n)) {
    if ((n as HTMLElement).hidden || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return false;
    const style = view.getComputedStyle(n);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function isRequired(el: HTMLElement, label: string): boolean {
  return (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label.trim());
}

/** The question text for a radio / checkbox group. */
function groupLabel(members: HTMLInputElement[]): string {
  const first = members[0]!;
  const fieldset = first.closest('fieldset');
  const legend = fieldset?.querySelector('legend');
  if (legend && textOf(legend).trim()) return textOf(legend);
  const group = first.closest('[role=radiogroup], [role=group]');
  if (group) {
    const aria = group.getAttribute('aria-label');
    if (aria) return aria;
    const ids = (group.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    if (ids.length) return ids.map((id) => textOf(byId(first, id))).join(' ');
  }
  // The smallest ancestor holding every option, minus the options' own labels.
  let anc: Element | null = first.parentElement;
  while (anc && !members.every((m) => anc!.contains(m))) anc = anc.parentElement;
  const optionText = members.map((m) => optionLabel(m)).filter(Boolean);
  for (let depth = 0; anc && depth < 3; depth++, anc = anc.parentElement) {
    let t = textOf(anc);
    for (const o of optionText) t = t.replace(o, ' ');
    if (t.trim()) return t;
  }
  return first.name || '';
}

function optionLabel(el: HTMLInputElement): string {
  const l = el.labels?.[0] ? textOf(el.labels[0]) : el.closest('label') ? textOf(el.closest('label')) : el.getAttribute('aria-label') ?? el.value;
  return cleanLabel(l);
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'search', 'number']);
const DATE_TYPES = new Set(['date', 'month']);

/** Short answers that make a set of buttons a question ("Yes" / "No" toggles). */
const CHOICE_TEXT_RE = /^(yes|no|maybe|not sure|n\/?a|prefer not to (say|answer)|decline( to answer)?|true|false)$/;

const choiceText = (b: HTMLElement) => normalize(b.textContent || b.getAttribute('aria-label') || '');

/** Questions answered by pressing one of several buttons: role=radio widgets and Yes/No button pairs. */
function buttonGroups(root: Root, handled: Set<Element>): Question[] {
  const out: Question[] = [];
  const groups = new Map<Element, HTMLElement[]>();
  for (const b of deepAll<HTMLElement>(root, '[role=radio]:not(input), button[aria-pressed], button[type=button]')) {
    if (handled.has(b) || !isVisible(b)) continue;
    const isRadio = b.getAttribute('role') === 'radio';
    if (!isRadio && !CHOICE_TEXT_RE.test(choiceText(b))) continue;
    const parent = (isRadio ? b.closest('[role=radiogroup]') : null) ?? parentOf(b);
    if (!parent) continue;
    groups.set(parent, [...(groups.get(parent) ?? []), b]);
  }
  for (const [parent, choices] of groups) {
    if (choices.length < 2) continue;
    choices.forEach((c) => handled.add(c));
    let label = parent.getAttribute('aria-label') ?? '';
    const ids = (parent.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    if (!label && ids.length) label = ids.map((id) => textOf(byId(parent, id))).join(' ');
    if (!label) {
      const names = choices.map((c) => (c.textContent ?? '').trim()).filter(Boolean);
      let anc: Element | null = parent;
      for (let depth = 0; anc && depth < 4 && !label.trim(); depth++, anc = parentOf(anc)) {
        let t = anc.textContent ?? '';
        for (const n of names) t = t.replace(n, ' ');
        label = t.replace(/\s+/g, ' ').trim();
      }
    }
    const required = parent.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label.trim());
    out.push({ kind: 'buttons', label: cleanLabel(label), ds: [normalize(label)].filter(Boolean), el: parent as HTMLElement, members: [], choices, required });
  }
  return out;
}

export function findQuestions(root: Root): Question[] {
  const out: Question[] = [];
  const handled = new Set<Element>();
  const controls = deepAll<HTMLElement>(root, 'input, textarea, select, [role=combobox], button[aria-haspopup=listbox]');
  for (const el of controls) {
    if (handled.has(el)) continue;
    handled.add(el);
    const view = el.ownerDocument.defaultView!;
    if (el instanceof view.HTMLInputElement) {
      const type = el.type.toLowerCase();
      if (type === 'file') {
        const ds = descriptors(el);
        out.push({ kind: 'file', label: cleanLabel(visibleLabel(el, ds[0] ?? 'File')), ds, el, members: [], required: isRequired(el, '') });
        continue;
      }
      // Styled radios / checkboxes often hide the input itself and show its label.
      const shown = isVisible(el) || ((type === 'radio' || type === 'checkbox') && !!el.labels?.[0] && isVisible(el.labels[0]));
      if (el.disabled || !shown) continue;
      if (type === 'radio' || type === 'checkbox') {
        const scope = el.closest('fieldset, [role=radiogroup], [role=group]') ?? el.form ?? rootOf(el);
        const members = el.name
          ? Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type=${type}]`)).filter((m) => m.name === el.name)
          : el.closest('fieldset, [role=radiogroup], [role=group]')
            ? Array.from(scope.querySelectorAll<HTMLInputElement>(`input[type=${type}]`))
            : [el];
        members.forEach((m) => handled.add(m));
        if (type === 'checkbox' && members.length === 1) {
          const label = optionLabel(el) || groupLabel(members);
          const raw = textOf(el.labels?.[0] ?? el.closest('label'));
          out.push({ kind: 'checkbox', label: cleanLabel(label), ds: [normalize(label), normalize(el.name)].filter(Boolean), el, members, required: isRequired(el, raw) });
        } else {
          const label = cleanLabel(groupLabel(members));
          const required = members.some((m) => m.required) || el.closest('[aria-required=true]') !== null || /\*\s*$/.test(label);
          out.push({ kind: type === 'radio' ? 'radio' : 'checkboxes', label, ds: [normalize(label), normalize(el.name)].filter(Boolean), el, members, required });
        }
        continue;
      }
      if (DATE_TYPES.has(type) && !el.readOnly) {
        const ds = descriptors(el);
        const label = visibleLabel(el, ds[0] ?? 'Date');
        out.push({ kind: 'date', label: cleanLabel(label), ds, el, members: [], required: isRequired(el, label) });
        continue;
      }
      if (!TEXT_TYPES.has(type) || el.readOnly) continue;
      const ds = descriptors(el);
      const label = visibleLabel(el, ds[0] ?? 'Field');
      const kind: QuestionKind = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ? 'combobox' : 'text';
      out.push({ kind, label: cleanLabel(label), ds, el, members: [], required: isRequired(el, label) });
      continue;
    }
    if (!isVisible(el) || (el as HTMLButtonElement).disabled) continue;
    if (el instanceof view.HTMLTextAreaElement) {
      if (el.readOnly) continue;
      const ds = descriptors(el);
      const label = visibleLabel(el, ds[0] ?? 'Field');
      out.push({ kind: 'textarea', label: cleanLabel(label), ds, el, members: [], required: isRequired(el, label) });
    } else if (el instanceof view.HTMLSelectElement) {
      const ds = descriptors(el);
      const label = visibleLabel(el, ds[0] ?? 'Choice');
      out.push({ kind: 'select', label: cleanLabel(label), ds, el, members: [], required: isRequired(el, label) });
    } else if (!el.querySelector('input')) {
      // A custom picker button (Workday-style) or a div[role=combobox] without an input.
      const ds = descriptors(el);
      const label = visibleLabel(el, ds[0] ?? 'Choice');
      out.push({ kind: 'listbox', label: cleanLabel(label), ds, el, members: [], required: isRequired(el, label) });
    }
  }
  out.push(...buttonGroups(root, handled));
  return out;
}

/** The choices a question offers, for the side panel. Pickers are only known once opened. */
export function questionOptions(q: Question): string[] | undefined {
  if (q.kind === 'select')
    return Array.from((q.el as HTMLSelectElement).options)
      .filter((o) => !isPlaceholderOption(o) && !o.disabled)
      .map((o) => (o.textContent ?? o.value).trim())
      .slice(0, 60);
  if (q.kind === 'radio' || q.kind === 'checkboxes') return q.members.map(optionLabel).filter(Boolean);
  if (q.kind === 'buttons') return (q.choices ?? []).map((c) => (c.textContent ?? '').trim()).filter(Boolean);
  return undefined;
}

function unanswered(q: Question): Unanswered {
  const max = (q.el as HTMLInputElement).maxLength;
  return { label: q.label, required: q.required, kind: q.kind, options: questionOptions(q), maxLength: max > 0 ? max : undefined };
}

/* ----------------------------------------------------------------------------
 * Answers
 * ------------------------------------------------------------------------- */

type Resolved = { value: string; key: FilledKey } | { file: FillFile; key: 'resume' | 'coverLetter' } | { never: true } | { missing: 'profile' | 'question' };

/** Kept for callers that only need the profile key of a text field. */
export function classify(el: HTMLInputElement | HTMLTextAreaElement): AutofillKey | StandardQuestion | 'never' | null {
  const ds = descriptors(el);
  if (ds.some((d) => NEVER_RE.test(d))) return 'never';
  const std = STANDARD_RULES.find((r) => ds.some((d) => r.re.test(d)));
  if (std) return std.key;
  const auto = AUTOCOMPLETE[(el.getAttribute('autocomplete') ?? '').trim().toLowerCase().split(/\s+/).pop() ?? ''];
  if (auto) return auto;
  if (el instanceof HTMLInputElement && el.type === 'email') return 'email';
  if (el instanceof HTMLInputElement && el.type === 'tel') return 'phone';
  for (const rule of PROFILE_RULES) if (ds.some((d) => rule.re.test(d) && !rule.not?.test(d))) return rule.key;
  return null;
}

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

export function resolve(q: Question, req: FillRequest): Resolved {
  if (q.ds.some((d) => NEVER_RE.test(d))) return { never: true };
  if (q.kind === 'file') {
    if (q.ds.some((d) => COVER_RE.test(d))) return req.answers.coverLetterFile ? { file: req.answers.coverLetterFile, key: 'coverLetter' } : { missing: 'question' };
    if (q.ds.some((d) => RESUME_RE.test(d))) return req.resume ? { file: req.resume, key: 'resume' } : { missing: 'question' };
    return { missing: 'question' };
  }
  const saved = savedAnswerFor(q.label, req);
  if (saved !== null) return { value: saved, key: 'saved' };
  if (q.kind === 'checkbox' && q.ds.some((d) => CONSENT_RE.test(d))) return req.answers.tickConsent ? { value: 'yes', key: 'consent' } : { missing: 'question' };
  if ((q.kind === 'textarea' || q.kind === 'text') && q.ds.some((d) => COVER_RE.test(d)))
    return req.answers.coverLetter ? { value: req.answers.coverLetter, key: 'coverLetter' } : { missing: 'question' };
  const std = STANDARD_RULES.find((r) => q.ds.some((d) => r.re.test(d)));
  if (std) {
    const v = req.answers.standard[std.key]?.trim();
    return v ? { value: v, key: std.key } : { missing: 'question' };
  }
  const el = q.el;
  let key: AutofillKey | undefined = AUTOCOMPLETE[(el.getAttribute('autocomplete') ?? '').trim().toLowerCase().split(/\s+/).pop() ?? ''];
  if (!key && el instanceof HTMLInputElement && el.type === 'email') key = 'email';
  if (!key && el instanceof HTMLInputElement && el.type === 'tel') key = 'phone';
  key ??= PROFILE_RULES.find((r) => q.ds.some((d) => r.re.test(d) && !r.not?.test(d)))?.key;
  if (key) {
    const v = req.data[key]?.trim();
    return v ? { value: v, key } : { missing: 'profile' };
  }
  return { missing: 'question' };
}

/* ----------------------------------------------------------------------------
 * Acting on controls, the way a person would
 * ------------------------------------------------------------------------- */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => T | null | undefined, maxMs = 2500, every = 80): Promise<T | null> {
  const end = Date.now() + maxMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

/** Resolves once the DOM has been quiet for `quietMs` (or after `maxMs`). */
export function settle(doc: Document, quietMs = 250, maxMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quietMs);
    const hard = setTimeout(done, maxMs);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quietMs);
    });
    obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true });
    function done() {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(hard);
      resolve();
    }
  });
}

/** A full pointer + mouse sequence and a click, as from a real mouse press. */
export function press(el: HTMLElement) {
  el.scrollIntoView?.({ block: 'center' });
  const view = el.ownerDocument.defaultView ?? window;
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
  const P = (view as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (P) el.dispatchEvent(new P('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new view.MouseEvent('mousedown', opts));
  el.focus?.({ preventScroll: true });
  if (P) el.dispatchEvent(new P('pointerup', { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new view.MouseEvent('mouseup', { ...opts, buttons: 0 }));
  el.click();
}

/** Sets a value the way typing does, so React / Vue / Angular controlled inputs pick it up. */
function setValue(el: TextControl, value: string) {
  const view = el.ownerDocument.defaultView ?? window;
  const proto = el instanceof view.HTMLTextAreaElement ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  el.focus?.({ preventScroll: true });
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function blur(el: HTMLElement) {
  el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  el.blur?.();
}

const YES = /^(yes|y|true|i (am|do|have|will|can)\b)/;
const NO = /^(no|n|false|i (am|do|have|will|can) not|i don't|i'm not)\b/;
const DECLINE = /decline|prefer not|don't wish|do not wish|not (wish )?to (say|answer|disclose|self ?identify)|rather not/;

/** How well an option's text matches the wanted answer (0…1). */
export function optionScore(optionText: string, wanted: string): number {
  const t = normalize(optionText);
  const v = normalize(wanted);
  if (!t || !v) return 0;
  if (t === v) return 1;
  if (DECLINE.test(v) && DECLINE.test(t)) return 0.95;
  if (YES.test(v) && !NO.test(v)) return YES.test(t) && !NO.test(t) ? 0.9 : 0;
  if (NO.test(v)) return NO.test(t) ? 0.9 : 0;
  if (t.startsWith(`${v} `) || v.startsWith(`${t} `)) return 0.8;
  if (v.length >= 3 && t.length >= 3 && (t.includes(v) || v.includes(t))) return 0.7;
  return similarity(t, v) * 0.65;
}

function bestOption<T>(items: T[], text: (t: T) => string, wanted: string): T | null {
  let best: { item: T; score: number } | null = null;
  for (const item of items) {
    const s = optionScore(text(item), wanted);
    if (s >= 0.45 && (!best || s > best.score)) best = { item, score: s };
  }
  return best?.item ?? null;
}

const isPlaceholderOption = (o: HTMLOptionElement) => !o.value || /^(select|choose|please|--|—)/i.test(o.textContent?.trim() ?? '');

export function hasValue(q: Question): boolean {
  const el = q.el;
  if (q.kind === 'radio') return q.members.some((m) => m.checked);
  if (q.kind === 'checkbox') return (el as HTMLInputElement).checked;
  if (q.kind === 'checkboxes') return q.members.some((m) => m.checked);
  if (q.kind === 'select') {
    const s = el as HTMLSelectElement;
    const o = s.selectedOptions[0];
    return !!o && !isPlaceholderOption(o);
  }
  if (q.kind === 'file') return ((el as HTMLInputElement).files?.length ?? 0) > 0;
  if (q.kind === 'listbox') {
    const t = normalize(el.textContent);
    return !!t && !/^(select|choose|please|--)/.test(t);
  }
  if (q.kind === 'buttons') return (q.choices ?? []).some(isChosen);
  return !!(el as TextControl).value?.trim();
}

const isChosen = (b: HTMLElement) =>
  b.getAttribute('aria-checked') === 'true' || b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-selected') === 'true' || /\b(selected|active|checked|is-selected)\b/i.test(b.className);

/** Option markup used by common pickers besides role=option (react-select, Workday prompts). */
const OPTION_SELECTOR = '[role=option], [data-automation-id=promptOption], .select__option, [class*="__option"]';

/** Options of an open picker: the element it controls, else any visible option in the document. */
function visibleOptions(doc: Document, owner: HTMLElement): HTMLElement[] {
  const ids = `${owner.getAttribute('aria-controls') ?? ''} ${owner.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean);
  for (const id of ids) {
    const list = byId(owner, id);
    const opts = list ? Array.from(list.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(isVisible) : [];
    if (opts.length) return opts;
  }
  const seen = new Set<Element>();
  return deepAll<HTMLElement>(doc, OPTION_SELECTOR).filter((o) => {
    // A react-select option wrapper and its role=option child are the same choice.
    if (seen.has(o) || (o.parentElement && seen.has(o.parentElement))) return false;
    seen.add(o);
    return isVisible(o);
  });
}

/** "2026-01-15", "Jan 2026", "01/2026", "2026" → ISO date / month for date inputs. Null when not a date. */
export function toIsoDate(value: string, type: 'date' | 'month'): string | null {
  const v = value.trim().toLowerCase();
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let y: number | null = null;
  let m = 1;
  let d = 1;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(v))) [y, m, d] = [Number(r[1]), Number(r[2]), r[3] ? Number(r[3]) : 1];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [y, m, d] = [Number(r[3]), Number(r[1]), Number(r[2])];
  else if ((r = /^(\d{1,2})\/(\d{4})$/.exec(v))) [y, m] = [Number(r[2]), Number(r[1])];
  else if ((r = /^([a-z]{3})[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/.exec(v)) && MONTHS.includes(r[1]!)) [y, m, d] = [Number(r[3]), MONTHS.indexOf(r[1]!) + 1, r[2] ? Number(r[2]) : 1];
  else if ((r = /^(\d{4})$/.exec(v))) y = Number(r[1]);
  if (y === null || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const mm = String(m).padStart(2, '0');
  return type === 'month' ? `${y}-${mm}` : `${y}-${mm}-${String(d).padStart(2, '0')}`;
}

function attachFile(input: HTMLInputElement, file: FillFile): boolean {
  if (typeof DataTransfer === 'undefined') return false;
  const accept = (input.accept ?? '').toLowerCase();
  const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
  if (accept && !accept.split(',').some((a) => a.trim() === ext || a.trim() === file.type || a.trim() === '*/*' || (a.trim().endsWith('/*') && file.type.startsWith(a.trim().slice(0, -1))))) return false;
  const bin = atob(file.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer();
  dt.items.add(new File([bytes], file.name, { type: file.type }));
  input.files = dt.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return input.files?.length === 1;
}

/** Applies an answer to a question. Returns false if no matching option exists. */
export async function applyAnswer(q: Question, value: string): Promise<boolean> {
  const doc = q.el.ownerDocument;
  switch (q.kind) {
    case 'text':
    case 'textarea': {
      const el = q.el as TextControl;
      const max = el.maxLength > 0 ? el.maxLength : Infinity;
      setValue(el, value.slice(0, max));
      blur(el);
      return true;
    }
    case 'select': {
      const el = q.el as HTMLSelectElement;
      const opt = bestOption(
        Array.from(el.options).filter((o) => !isPlaceholderOption(o) && !o.disabled),
        (o) => o.textContent ?? o.value,
        value,
      );
      if (!opt) return false;
      const view = doc.defaultView ?? window;
      Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set?.call(el, opt.value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    case 'radio': {
      const m = bestOption(q.members, optionLabel, value);
      if (!m) return false;
      if (!m.checked) press(m);
      return m.checked;
    }
    case 'checkbox': {
      const el = q.el as HTMLInputElement;
      const want = optionScore('yes', value) >= 0.9 || optionScore(optionLabel(el), value) >= 0.7;
      const dontWant = optionScore('no', value) >= 0.9;
      if (!want && !dontWant) return false;
      if (el.checked !== want) press(el);
      return el.checked === want;
    }
    case 'checkboxes': {
      const wanted = value.split(/\s*[;\n]\s*|\s*,\s*(?=[A-Z])/).filter(Boolean);
      let any = false;
      for (const w of wanted) {
        const m = bestOption(q.members, optionLabel, w);
        if (m && !m.checked) press(m);
        any ||= !!m;
      }
      return any;
    }
    case 'combobox': {
      // Type to filter, then pick the matching suggestion.
      const el = q.el as HTMLInputElement;
      press(el);
      setValue(el, value);
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      const opt = await waitFor(() => bestOption(visibleOptions(doc, el), (o) => o.textContent ?? '', value), 2000);
      if (opt) {
        press(opt);
        await settle(doc, 150, 1500);
        blur(el);
        return true;
      }
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      // Free-text location pickers accept typed text; other pickers need a real choice.
      if (q.ds.some((d) => /location|city/.test(d))) {
        blur(el);
        return true;
      }
      setValue(el, '');
      blur(el);
      return false;
    }
    case 'listbox': {
      press(q.el);
      const opt = await waitFor(() => bestOption(visibleOptions(doc, q.el), (o) => o.textContent ?? '', value), 2500);
      if (opt) {
        press(opt);
        await settle(doc, 150, 1500);
        return true;
      }
      q.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      doc.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      return false;
    }
    case 'date': {
      const el = q.el as HTMLInputElement;
      const iso = toIsoDate(value, el.type === 'month' ? 'month' : 'date');
      if (!iso) return false;
      setValue(el, iso);
      blur(el);
      return el.value === iso;
    }
    case 'buttons': {
      const b = bestOption(q.choices ?? [], (c) => c.textContent ?? c.getAttribute('aria-label') ?? '', value);
      if (!b) return false;
      if (!isChosen(b)) press(b);
      return true;
    }
    case 'file':
      return false;
  }
}

/* ----------------------------------------------------------------------------
 * Highlighting
 * ------------------------------------------------------------------------- */

/** Elements this script filled, so a second run doesn't report them as "already typed". */
export const ours = new WeakSet<Element>();

export function highlight(el: HTMLElement) {
  const prev = { outline: el.style.outline, offset: el.style.outlineOffset };
  el.style.outline = '2px solid #16a34a';
  el.style.outlineOffset = '1px';
  el.setAttribute('data-job-copilot-filled', '');
  el.addEventListener(
    'focus',
    () => {
      el.style.outline = prev.outline;
      el.style.outlineOffset = prev.offset;
      el.removeAttribute('data-job-copilot-filled');
    },
    { once: true },
  );
}

export function highlightTarget(q: Question): HTMLElement {
  if (q.kind === 'radio' || q.kind === 'checkboxes') return (q.members[0]?.closest('fieldset, [role=radiogroup], [role=group]') as HTMLElement) ?? q.members[0]!;
  if (q.kind === 'buttons') return q.el;
  if (q.kind === 'file' || q.kind === 'checkbox') {
    const t = q.el.closest('label') ?? q.el.parentElement;
    return t instanceof HTMLElement ? t : q.el;
  }
  return q.el;
}

/* ----------------------------------------------------------------------------
 * One step: fill everything visible
 * ------------------------------------------------------------------------- */

export function emptyReport(url: string): FillReport {
  return { url, filled: [], kept: [], noValue: [], unanswered: [], steps: 0, stop: 'done', errors: [], resumeInputFound: false };
}

/** Controls inside work-history / education entries, filled by `fillHistory` and skipped here. */
export const claimed = new WeakSet<Element>();

/**
 * Fills the visible questions. Answering one can reveal follow-ups ("If yes,
 * please explain"), so the step is re-scanned (up to 3 passes) while new
 * questions keep appearing. Returns the unanswered required ones.
 */
export async function fillStep(doc: Document, req: FillRequest, report: FillReport): Promise<Unanswered[]> {
  const usedProfileKeys = new Set<FilledKey>();
  const stepMissing: Unanswered[] = [];
  const seen = new Set<Element>();
  const addUnique = (list: Unanswered[], item: Unanswered) => {
    if (!list.some((x) => x.label === item.label)) list.push(item);
  };
  for (let pass = 0; pass < 3; pass++) {
    const questions = findQuestions(doc).filter((q) => !seen.has(q.el) && !claimed.has(q.el));
    if (!questions.length) break;
    let changed = false;
    for (const q of questions) {
      seen.add(q.el);
      if (q.kind === 'file') {
        const r = resolve(q, req);
        if (q.ds.some((d) => RESUME_RE.test(d)) && !q.ds.some((d) => COVER_RE.test(d))) report.resumeInputFound = true;
        if (!('file' in r)) continue;
        if (hasValue(q) && !req.overwrite) continue;
        if (attachFile(q.el as HTMLInputElement, r.file)) {
          ours.add(q.el);
          changed = true;
          report.filled.push({ label: `${r.key === 'resume' ? 'Résumé' : 'Cover letter'} (${r.file.name})`, key: r.key });
          const t = highlightTarget(q);
          if (isVisible(t)) highlight(t);
        }
        continue;
      }
      const r = resolve(q, req);
      if ('never' in r) continue;
      if (hasValue(q)) {
        if (ours.has(q.el)) continue;
        if (!req.overwrite) {
          if (!('missing' in r) && !report.kept.includes(q.label)) report.kept.push(q.label);
          continue;
        }
      }
      if ('missing' in r) {
        if (r.missing === 'profile') {
          if (!report.noValue.includes(q.label)) report.noValue.push(q.label);
        } else if (q.kind !== 'checkbox' || q.required) addUnique(report.unanswered, unanswered(q));
        if (q.required) stepMissing.push(unanswered(q));
        continue;
      }
      if (!('value' in r)) continue;
      // A profile value goes into the first matching field only (a second "email" is a confirmation).
      if (usedProfileKeys.has(r.key) && r.key !== 'email' && r.key !== 'saved') continue;
      const ok = await applyAnswer(q, r.value);
      if (!ok) {
        addUnique(report.unanswered, unanswered(q));
        if (q.required) stepMissing.push(unanswered(q));
        continue;
      }
      changed = true;
      usedProfileKeys.add(r.key);
      ours.add(q.el);
      q.members.forEach((m) => ours.add(m));
      highlight(highlightTarget(q));
      report.filled.push({ label: q.label, key: r.key });
      report.unanswered = report.unanswered.filter((u) => u.label !== q.label);
    }
    if (!changed) break;
    await settle(doc, 150, 1500);
  }
  return stepMissing;
}

/* ----------------------------------------------------------------------------
 * Steps, buttons and stop conditions
 * ------------------------------------------------------------------------- */

const buttonText = (el: HTMLElement) =>
  normalize((el instanceof HTMLInputElement ? el.value : el.textContent) || el.getAttribute('aria-label') || '')
    .replace(/[→›»>]+/g, '')
    .trim();

const SUBMIT_RE = /^(submit( (my |your |the )?application)?|send( (my |your )?application)?|apply( now)?|complete( (my |your )?application)?|finish( application)?|confirm (and|&) submit|submit (and|&) finish)$/;
const NEXT_RE = /^(next( step| page)?|continue( to next step)?|save (and|&) (continue|next)|proceed|review( (my |your )?application)?|go to next step)$/;
const OPEN_FORM_RE = /^(apply|apply now|apply for this (job|position|role|opening)|start (your |my )?application|i'?m interested|apply here|apply manually)$/;
const THIRD_PARTY_RE = /linked ?in|indeed|google|facebook|seek|glassdoor|ziprecruiter|easy apply/;

export function visibleButtons(doc: Document): HTMLElement[] {
  return deepAll<HTMLElement>(doc, 'button, input[type=submit], input[type=button], [role=button], a[href]').filter(
    (b) => isVisible(b) && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true' && !b.closest('job-copilot-root, job-copilot-toast'),
  );
}

export function findSubmit(doc: Document): HTMLElement | null {
  const candidates = visibleButtons(doc).filter((b) => !(b instanceof HTMLAnchorElement) && SUBMIT_RE.test(buttonText(b)) && !THIRD_PARTY_RE.test(buttonText(b)));
  // Prefer a button inside a form, then the last one on the page.
  return candidates.find((b) => b.closest('form')) ?? candidates[candidates.length - 1] ?? null;
}

/** Visible, enabled elements matching a site's selectors. */
function siteButtons(doc: Document, selectors: string[] | undefined): HTMLElement[] {
  if (!selectors?.length) return [];
  const ok = new Set(visibleButtons(doc));
  return selectors.flatMap((sel) => deepAll<HTMLElement>(doc, sel)).filter((b) => ok.has(b) || ok.has(b.closest('button, [role=button]') as HTMLElement));
}

function findNext(doc: Document): HTMLElement | null {
  const site = formSiteFor(doc.location?.href);
  // A site's "next" button becomes "Submit" on the last step: never treat that as Next.
  const hinted = siteButtons(doc, site?.next).find((b) => !SUBMIT_RE.test(buttonText(b)));
  return hinted ?? visibleButtons(doc).find((b) => !(b instanceof HTMLAnchorElement) && NEXT_RE.test(buttonText(b))) ?? null;
}

function findOpenForm(doc: Document): HTMLElement | null {
  const site = formSiteFor(doc.location?.href);
  const hinted = siteButtons(doc, site?.open).find((b) => !THIRD_PARTY_RE.test(buttonText(b)));
  return hinted ?? visibleButtons(doc).find((b) => OPEN_FORM_RE.test(buttonText(b)) && !THIRD_PARTY_RE.test(buttonText(b))) ?? null;
}

function hasCaptcha(doc: Document): boolean {
  const frames = Array.from(doc.querySelectorAll('iframe')).some((f) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(f.src) && isVisible(f));
  return frames || Array.from(doc.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')).some(isVisible);
}

function needsLogin(doc: Document): boolean {
  const site = formSiteFor(doc.location?.href);
  if (site?.login?.some((sel) => deepAll(doc, sel).some(isVisible))) return true;
  return deepAll(doc, 'input[type=password]').some(isVisible);
}

function errorsOnPage(doc: Document): string[] {
  const out = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[role=alert], [aria-live=assertive], .error, .errors, .field-error, .invalid-feedback, [class*=error-message], [id*=error]'))) {
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (t && isVisible(el) && t.length < 300) out.add(t);
  }
  // Field-level messages first, named after their field ("Email: Enter a valid email").
  const fieldMessages: string[] = [];
  for (const el of deepAll<HTMLElement>(doc, '[aria-invalid=true]')) {
    if (!isVisible(el)) continue;
    const label = cleanLabel(visibleLabel(el, descriptors(el)[0] ?? 'A field'));
    const ids = `${el.getAttribute('aria-errormessage') ?? ''} ${el.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean);
    const msg = ids.map((id) => byId(el, id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '').find((t) => t && t.length < 200);
    if (msg) out.delete(msg);
    fieldMessages.push(msg ? `${label}: ${msg}` : `${label} needs attention`);
  }
  return [...fieldMessages, ...out].slice(0, 10);
}

/** A cheap fingerprint of the current step, to tell whether pressing Next moved on. */
function stepSignature(doc: Document): string {
  return `${doc.location?.href ?? ''}|${findQuestions(doc)
    .map((q) => q.label)
    .join('|')}`;
}

const ORDER: StopReason[] = ['no_form', 'done', 'max_steps', 'submit_ready', 'needs_answers', 'errors', 'login', 'captcha', 'navigating'];
export const moreImportant = (a: StopReason, b: StopReason) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

/**
 * Fills the form step by step. Presses Next / Continue (when `advance` is on)
 * until the final submit button, a CAPTCHA, a login, a validation error or a
 * required question without a saved answer. Never presses submit.
 */
export async function runApplication(doc: Document, req: FillRequest): Promise<FillReport> {
  const report = emptyReport(doc.location?.href ?? '');
  const maxSteps = req.maxSteps ?? 12;
  for (let step = 0; step < maxSteps; step++) {
    let questions = findQuestions(doc).filter((q) => q.kind !== 'file' || q.ds.some((d) => RESUME_RE.test(d) || COVER_RE.test(d)));
    // A job page whose form opens behind an "Apply" button (sometimes followed by a chooser: "Apply Manually").
    for (let opened = 0; !questions.length && step === 0 && req.advance && opened < 2; opened++) {
      const open = findOpenForm(doc);
      if (!open) break;
      const href = open instanceof HTMLAnchorElement ? open.href : '';
      const leaves = href && !href.startsWith('javascript:') && new URL(href, doc.baseURI).href.split('#')[0] !== (doc.location?.href ?? '').split('#')[0];
      press(open);
      if (leaves) {
        report.stop = 'navigating';
        return report;
      }
      await settle(doc, 300, 4000);
      if (needsLogin(doc)) break;
      questions = findQuestions(doc);
    }
    // Work-history / education entries first: a "My Experience" step may only show "Add" buttons.
    if (req.history) {
      const before = report.filled.length;
      await fillHistory(doc, req, report);
      if (report.filled.length !== before || !questions.length) questions = findQuestions(doc);
    }
    if (!questions.length) {
      // A review page: nothing to fill, only the submit button.
      report.stop = needsLogin(doc) ? 'login' : hasCaptcha(doc) ? 'captcha' : step > 0 && findSubmit(doc) ? 'submit_ready' : step === 0 ? 'no_form' : 'done';
      break;
    }
    if (needsLogin(doc) && questions.every((q) => /e ?mail|user|password|login/.test(q.ds.join(' ')))) {
      report.stop = 'login';
      break;
    }
    const missing = await fillStep(doc, req, report);
    const submit = findSubmit(doc);
    const next = findNext(doc);
    if (hasCaptcha(doc)) {
      report.stop = 'captcha';
      break;
    }
    if (missing.length) {
      report.stop = 'needs_answers';
      break;
    }
    if (next && req.advance && next !== submit) {
      const before = stepSignature(doc);
      press(next);
      await settle(doc, 300, 5000);
      const moved = await waitFor(() => stepSignature(doc) !== before, 2500);
      if (!moved) {
        report.errors = errorsOnPage(doc);
        report.stop = 'errors';
        break;
      }
      report.steps++;
      continue;
    }
    report.stop = submit ? 'submit_ready' : 'done';
    break;
  }
  if (report.steps >= maxSteps) report.stop = 'max_steps';
  const submit = findSubmit(doc);
  if (submit && (report.stop === 'submit_ready' || report.stop === 'needs_answers' || report.stop === 'captcha')) {
    report.submitLabel = buttonText(submit) || 'Submit';
    if (report.stop === 'submit_ready') {
      submit.style.outline = '3px solid #3b7282';
      submit.style.outlineOffset = '2px';
    }
  }
  return report;
}

/** Answers one question (by its label) with a value the user typed in the side panel. */
export async function answerQuestion(doc: Document, label: string, value: string): Promise<boolean> {
  const q = findQuestions(doc).find((x) => x.label === label);
  if (!q || q.kind === 'file') return false;
  const ok = await applyAnswer(q, value);
  if (ok) {
    ours.add(q.el);
    highlight(highlightTarget(q));
  }
  return ok;
}

export type SubmitOutcome = { status: 'submitted' | 'errors' | 'unknown' | 'not_found' | 'captcha'; label?: string; errors: string[] };

/** Presses the final submit button. Called only after the user confirmed in the side panel. */
export async function submitApplication(doc: Document): Promise<SubmitOutcome> {
  if (hasCaptcha(doc)) return { status: 'captcha', errors: [] };
  const btn = findSubmit(doc);
  if (!btn) return { status: 'not_found', errors: [] };
  const label = buttonText(btn) || 'Submit';
  press(btn);
  await settle(doc, 500, 8000);
  const done = await waitFor(
    () => /thank you|thanks for applying|application (has been |was )?(received|submitted|sent|complete)|we('ve| have) received your application|successfully (submitted|applied)/i.test(doc.body?.innerText ?? doc.body?.textContent ?? '') || !findSubmit(doc),
    3000,
  );
  if (done) return { status: 'submitted', label, errors: [] };
  const errors = errorsOnPage(doc);
  return { status: errors.length ? 'errors' : 'unknown', label, errors };
}

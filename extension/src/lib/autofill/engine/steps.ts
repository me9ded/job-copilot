import { formSiteFor } from '../sites';
import { detectScope, scopedQuestions, type FormScope } from './detect';
import { descriptors, visibleLabel, type Question } from './discover';
import { byId, deepAll, hostOf, isTopFrame, isVisible } from './dom';
import { cleanLabel, normalize } from './text';
import { hasValue } from './verify';

/**
 * Facts about the current step: its Next / Submit / Apply buttons, CAPTCHAs,
 * log-in walls, validation errors and whether anything required is still
 * empty. Only buttons that belong to the application count.
 */

export const buttonText = (el: HTMLElement) =>
  normalize((el instanceof (el.ownerDocument.defaultView ?? window).HTMLInputElement ? el.value : el.textContent) || el.getAttribute('aria-label') || '')
    .replace(/[→›»>]+/g, '')
    .trim();

const SUBMIT_RE = /^(submit( (my |your |the )?application)?|send( (my |your )?application)?|complete( (my |your )?application)?|finish( application)?|confirm (and|&) submit|submit (and|&) finish)$/;
/** "Apply" ends the application only inside a form that has application fields; elsewhere it opens one. */
const APPLY_RE = /^apply( now)?$/;
const NEXT_RE = /^(next( step| page| section)?|continue( to next step)?|save (and|&) (continue|next)|proceed|review( (my |your )?application)?|go to next step)$/;
/** The same buttons naming where they lead: "Next: Experience", "Continue to questions", "Next (2 of 4)". */
const NEXT_TO_RE = /^(next( step| page| section)?|continue to|proceed to|save (and|&) continue to) [a-z0-9][a-z0-9' &]{0,40}$/;
/** Never pressed as Next: anything that submits, signs in or leaves the application. */
const NOT_NEXT_RE = /\b(submi\w*|send|finish|complete|confirm|sign|log|login|register|account|pay\w*|jobs?|postings?|openings?|search|results?|later|with|home|site|website|careers?)\b/;

export const isNextText = (text: string) => NEXT_RE.test(text) || (NEXT_TO_RE.test(text) && !NOT_NEXT_RE.test(text));
const OPEN_FORM_RE = /^(apply|apply now|apply for this (job|position|role|opening)|start (your |my )?application|i'?m interested|apply here|apply manually)$/;
const THIRD_PARTY_RE = /linked ?in|indeed|google|facebook|seek|glassdoor|ziprecruiter|easy apply/;

export function visibleButtons(doc: Document, scope?: FormScope): HTMLElement[] {
  return deepAll<HTMLElement>(doc, 'button, input[type=submit], input[type=button], [role=button], a[href]').filter(
    (b) => isVisible(b) && !(b as HTMLButtonElement).disabled && b.getAttribute('aria-disabled') !== 'true' && !b.closest('job-copilot-root, job-copilot-toast') && !scope?.skip(b),
  );
}

export function findSubmit(doc: Document, scope = detectScope(doc)): HTMLElement | null {
  const buttons = visibleButtons(doc, scope).filter((b) => !(b instanceof (doc.defaultView ?? window).HTMLAnchorElement) && !THIRD_PARTY_RE.test(buttonText(b)));
  const inAppForm = (b: HTMLElement) => {
    const f = b.closest('form, [role=form]');
    return !!f && scopedQuestions(doc, scope).some((q) => f.contains(q.el));
  };
  const candidates = buttons.filter((b) => SUBMIT_RE.test(buttonText(b)) || (APPLY_RE.test(buttonText(b)) && inAppForm(b)));
  // Prefer a button inside a form, then the last one on the page.
  return candidates.find((b) => b.closest('form')) ?? candidates[candidates.length - 1] ?? null;
}

/** Visible, enabled elements matching a site's selectors. */
function siteButtons(doc: Document, selectors: string[] | undefined, scope?: FormScope): HTMLElement[] {
  if (!selectors?.length) return [];
  const ok = new Set(visibleButtons(doc, scope));
  return selectors.flatMap((sel) => deepAll<HTMLElement>(doc, sel)).filter((b) => ok.has(b) || ok.has(b.closest('button, [role=button]') as HTMLElement));
}

export function findNext(doc: Document, scope = detectScope(doc)): HTMLElement | null {
  const site = formSiteFor(doc.location?.href);
  // A site's "next" button becomes "Submit" on the last step: never treat that as Next.
  const hinted = siteButtons(doc, site?.next, scope).find((b) => !SUBMIT_RE.test(buttonText(b)));
  return hinted ?? visibleButtons(doc, scope).find((b) => !(b instanceof (doc.defaultView ?? window).HTMLAnchorElement) && isNextText(buttonText(b))) ?? null;
}

export function findOpenForm(doc: Document, scope = detectScope(doc)): HTMLElement | null {
  const site = formSiteFor(doc.location?.href);
  const hinted = siteButtons(doc, site?.open, scope).find((b) => !THIRD_PARTY_RE.test(buttonText(b)));
  return hinted ?? visibleButtons(doc, scope).find((b) => OPEN_FORM_RE.test(buttonText(b)) && !THIRD_PARTY_RE.test(buttonText(b))) ?? null;
}

/** Applicant-tracking systems whose forms careers sites embed in an iframe. */
export const ATS_HOST_RE =
  /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|myworkdayjobs\.com|myworkdaysite\.com|icims\.com|jobvite\.com|bamboohr\.com|recruitee\.com|breezy\.hr|applytojob\.com|teamtailor\.com|pinpointhq\.com|rippling\.com|dayforcehcm\.com|successfactors\.(com|eu)|taleo\.net|ultipro\.com|paylocity\.com)$/;

/**
 * Whether this frame may press "Apply" to open a form. Every frame of the tab
 * runs the filler, so without this the careers page around an embedded
 * Greenhouse / Lever form pressed its own "Apply" link and navigated away
 * from the form being filled, and ad or chat frames pressed their own buttons.
 */
export function mayOpenForm(doc: Document): boolean {
  if (!isTopFrame(doc)) return ATS_HOST_RE.test(hostOf(doc.location?.href)) || !!formSiteFor(doc.location?.href);
  return !Array.from(doc.querySelectorAll('iframe')).some((f) => ATS_HOST_RE.test(hostOf(f.getAttribute('src') ?? '', doc.baseURI)) && isVisible(f));
}

export function hasCaptcha(doc: Document): boolean {
  const frames = Array.from(doc.querySelectorAll('iframe')).some((f) => /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|funcaptcha/i.test(f.src) && isVisible(f));
  return frames || Array.from(doc.querySelectorAll('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]')).some(isVisible);
}

export function needsLogin(doc: Document): boolean {
  const site = formSiteFor(doc.location?.href);
  if (site?.login?.some((sel) => deepAll(doc, sel).some(isVisible))) return true;
  return deepAll(doc, 'input[type=password]').some(isVisible);
}

/** Validation messages: field-level ones first, named after their field ("Email: Enter a valid email"). */
export function errorsOnPage(doc: Document): string[] {
  const out = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>('[role=alert], [aria-live=assertive], .error, .errors, .field-error, .invalid-feedback, [class*=error-message], [id*=error]'))) {
    const t = el.textContent?.replace(/\s+/g, ' ').trim();
    if (t && isVisible(el) && t.length < 300) out.add(t);
  }
  return [...fieldErrors(doc, out), ...out].slice(0, 10);
}

/** Fields the page marks invalid, with their message. Messages found are removed from `pageLevel`. */
function fieldErrors(doc: Document, pageLevel = new Set<string>(), scope?: FormScope): string[] {
  const msgs: string[] = [];
  for (const el of deepAll<HTMLElement>(doc, '[aria-invalid=true]')) {
    if (!isVisible(el) || scope?.skip(el)) continue;
    const label = cleanLabel(visibleLabel(el, descriptors(el)[0] ?? 'A field'));
    const ids = `${el.getAttribute('aria-errormessage') ?? ''} ${el.getAttribute('aria-describedby') ?? ''}`.split(/\s+/).filter(Boolean);
    const msg = ids.map((id) => byId(el, id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '').find((t) => t && t.length < 200);
    if (msg) pageLevel.delete(msg);
    msgs.push(msg ? `${label}: ${msg}` : `${label} needs attention`);
  }
  return msgs;
}

/** A cheap fingerprint of the current step, to tell whether pressing Next moved on. */
export function stepSignature(doc: Document): string {
  return `${doc.location?.href ?? ''}|${scopedQuestions(doc)
    .map((q) => q.id)
    .join('|')}`;
}

export interface Readiness {
  /** Required questions that are still empty. */
  empty: Question[];
  /** Fields the page or the browser considers invalid. */
  invalid: string[];
}

/**
 * The audit before "ready to submit": every required field answered, no
 * field the browser or the page flags as invalid.
 */
export function readiness(doc: Document, scope = detectScope(doc)): Readiness {
  const qs = scopedQuestions(doc, scope);
  const empty = qs.filter((q) => q.required && !hasValue(q));
  const invalid = fieldErrors(doc, new Set(), scope);
  for (const q of qs) {
    const el = q.el as HTMLInputElement;
    if (!hasValue(q) || !el.validity || el.validity.valid || q.kind === 'file') continue;
    if (el.getAttribute('aria-invalid') === 'true') continue;
    const why = el.validity.typeMismatch ? 'isn’t in the expected format' : el.validity.patternMismatch ? 'doesn’t match the required format' : el.validity.tooLong ? 'is too long' : el.validity.tooShort ? 'is too short' : el.validity.rangeOverflow || el.validity.rangeUnderflow ? 'is out of range' : 'isn’t valid';
    invalid.push(`${q.label}: ${why}`);
  }
  return { empty, invalid };
}

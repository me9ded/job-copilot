import { findQuestions, type Question } from './discover';
import { deepAll, isVisible, parentOf } from './dom';
import { normalize, textOf } from './text';

/**
 * Generic form detection: which parts of the page belong to the
 * application. Site search, newsletter and job-alert sign-ups, log-in boxes,
 * cookie banners, chat widgets and the page's navigation, header and footer
 * are left out, so the applicant's email never lands in a newsletter box and
 * a page that has only those counts as having no form.
 */

const NOISE_ID_RE = /cookie|consent[-_]?banner|onetrust|gdpr|truste|osano|cookiebot|\bcc[-_]banner|intercom|drift|zendesk|hubspot-messages|livechat|crisp|chat[-_]?widget|tawk|olark|freshchat|launcher|newsletter|subscribe/i;
const NOISE_TEXT_RE = /newsletter|subscribe|sign up for (our|job)|job alerts?|talent (community|network)|get (job )?alerts|search jobs|keyword search|log ?in|sign ?in|forgot (your )?password|cookie/;
const APPLICATION_RE = /apply|application|candidate|applicant|résumé|resume|\bcv\b|cover letter|work experience|employment history/;

/** Application signals among a region's questions: contact fields and a résumé upload. */
function signals(qs: Question[]): number {
  let s = 0;
  for (const q of qs) {
    const d = q.ds.join(' ');
    if (q.kind === 'file') s += 4;
    else if (/first ?name|last ?name|full ?name|phone|linked ?in|\btel\b/.test(d)) s += 2;
  }
  return s;
}

/** A region of the page that isn't the application (by its own markup, before looking at its fields). */
function noiseByMarkup(el: Element): boolean {
  const tag = el.tagName;
  const role = el.getAttribute('role');
  if (tag === 'NAV' || role === 'navigation' || role === 'search' || role === 'banner' || role === 'contentinfo') return true;
  // The page's own header / footer, not a <header> inside the form or an article.
  if ((tag === 'HEADER' || tag === 'FOOTER') && !el.closest('form, main, article, [role=main], [role=form], dialog, [role=dialog]')) return true;
  const idClass = `${el.id} ${typeof el.className === 'string' ? el.className : ''} ${el.getAttribute('data-testid') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
  return NOISE_ID_RE.test(idClass);
}

/** A small form about something else (search, newsletter, log-in). */
function noiseForm(form: Element): boolean {
  const qs = findQuestions(form);
  if (!qs.length) return false;
  if (qs.some((q) => q.kind === 'file') || signals(qs) >= 4) return false;
  if (qs.length > 4) return false;
  const text = normalize(`${textOf(form)} ${form.getAttribute('action') ?? ''} ${form.id} ${typeof form.className === 'string' ? form.className : ''} ${form.getAttribute('aria-label') ?? ''}`);
  return NOISE_TEXT_RE.test(text) && !/apply|application/.test(normalize(form.getAttribute('aria-label') ?? form.id));
}

export interface FormScope {
  /** True for elements that are not part of the application. */
  skip(el: Element): boolean;
  /** The forms judged to be the application, when the page has forms. */
  forms: Element[];
}

export function detectScope(doc: Document): FormScope {
  const noisyForms = new Set<Element>();
  const forms = deepAll<HTMLElement>(doc, 'form, [role=form]').filter((f) => isVisible(f) || f.tagName === 'FORM');
  for (const f of forms) if (noiseForm(f)) noisyForms.add(f);
  const cache = new Map<Element, boolean>();
  const skip = (el: Element): boolean => {
    const path: Element[] = [];
    let result = false;
    for (let n: Element | null = el; n && n !== doc.body && n !== doc.documentElement; n = parentOf(n)) {
      const known = cache.get(n);
      if (known !== undefined) {
        result = known;
        break;
      }
      path.push(n);
      if (noisyForms.has(n) || noiseByMarkup(n)) {
        // A header that is itself the application (rare) holds application fields: keep it.
        result = !(n.tagName === 'HEADER' && signals(findQuestions(n)) >= 4);
        break;
      }
    }
    for (const p of path) cache.set(p, result);
    return result;
  };
  const appForms = forms.filter((f) => !noisyForms.has(f) && !skip(f));
  return { skip, forms: appForms };
}

/** The page's application questions: discovery minus everything outside the application. */
export function scopedQuestions(doc: Document, scope = detectScope(doc)): Question[] {
  return findQuestions(doc).filter((q) => !scope.skip(q.el));
}

/** Whether the page talks about applying (used to decide that an unlabelled upload is the résumé, and for "Apply" buttons inside forms). */
export const looksLikeApplication = (text: string) => APPLICATION_RE.test(normalize(text));

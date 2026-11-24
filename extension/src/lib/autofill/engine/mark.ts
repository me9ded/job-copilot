import type { Question } from './discover';

/**
 * On-page marks: green for fields Job Copilot filled and verified, red
 * dashed for ones it couldn't fill, amber for required questions still
 * waiting for the applicant. A mark clears when the user focuses the field.
 */

type Tone = 'filled' | 'failed' | 'needed';
const STYLE: Record<Tone, string> = {
  filled: '2px solid #16a34a',
  failed: '2px dashed #dc2626',
  needed: '2px solid #d97706',
};

/** Elements this script filled, so a second run doesn't report them as "already typed". */
export const ours = new WeakSet<Element>();
/** What Job Copilot last wrote into a field; a different value later means the user edited it. */
export const written = new WeakMap<Element, string>();
/** Controls inside work-history / education entries, filled by `fillHistory` and skipped elsewhere. */
export const claimed = new WeakSet<Element>();

const saved = new WeakMap<HTMLElement, { outline: string; offset: string }>();

export function mark(el: HTMLElement, tone: Tone) {
  if (!saved.has(el)) saved.set(el, { outline: el.style.outline, offset: el.style.outlineOffset });
  el.style.outline = STYLE[tone];
  el.style.outlineOffset = '1px';
  el.setAttribute('data-job-copilot', tone);
  if (tone === 'filled') el.setAttribute('data-job-copilot-filled', '');
  else el.removeAttribute('data-job-copilot-filled');
  el.addEventListener('focusin', () => unmark(el), { once: true });
}

export function unmark(el: HTMLElement) {
  const prev = saved.get(el);
  if (!prev) return;
  el.style.outline = prev.outline;
  el.style.outlineOffset = prev.offset;
  el.removeAttribute('data-job-copilot');
  el.removeAttribute('data-job-copilot-filled');
  saved.delete(el);
}

/** Kept name: green "filled" outline. */
export const highlight = (el: HTMLElement) => mark(el, 'filled');

export function highlightTarget(q: Question): HTMLElement {
  if (q.kind === 'radio' || q.kind === 'checkboxes') return (q.members[0]?.closest('fieldset, [role=radiogroup], [role=group]') as HTMLElement) ?? q.members[0]!;
  if (q.kind === 'buttons') return q.el;
  if (q.kind === 'file' || q.kind === 'checkbox') {
    const t = q.el.closest('label') ?? q.el.parentElement;
    return t instanceof HTMLElement ? t : q.el;
  }
  return q.el;
}

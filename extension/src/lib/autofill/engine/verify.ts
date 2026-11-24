import { isPlaceholderOption, optionLabel, type Question } from './discover';
import { isSelect } from './dom';
import { optionScore, sameText } from './match';
import { containsWords, normalize, textOf } from './text';

/**
 * Verification: reads back what a control shows after Job Copilot set it.
 * A field counts as filled only when this agrees with the answer.
 */

/** Where pickers show what's already chosen: react-select's single / multi values, Workday's selected-item pills. */
export const PICKED_SELECTOR =
  '[class*="single-value"], [class*="singleValue"], [class*="multi-value"], [class*="multiValue"], [data-automation-id=selectedItem], [data-automation-id=promptSelectionLabel], .select2-selection__rendered, [class*="selected-value"], [class*="selectedValue"]';

const PLACEHOLDER_RE = /^(select|choose|please|--|—|search)/;

/** The choice a search-style picker shows next to its input, or '' when nothing is chosen. */
export function pickedText(el: HTMLElement): string {
  let n: Element | null = el.parentElement;
  for (let depth = 0; n && depth < 5; depth++, n = n.parentElement) {
    // Don't wander into a neighbouring field's picker.
    if (n.querySelectorAll('input:not([type=hidden]), textarea, select').length > 1) break;
    const picked = n.querySelector(PICKED_SELECTOR);
    const t = picked ? normalize(textOf(picked)) : '';
    if (t && !PLACEHOLDER_RE.test(t)) return t;
  }
  return '';
}

/** A choice button that shows it is selected (ARIA state, or a "selected" / "active" class, hashed CSS-module names included). */
export const isChosen = (b: HTMLElement) =>
  b.getAttribute('aria-checked') === 'true' ||
  b.getAttribute('aria-pressed') === 'true' ||
  b.getAttribute('aria-selected') === 'true' ||
  b.getAttribute('data-state') === 'checked' ||
  b.getAttribute('data-state') === 'on' ||
  /(^|[\s_-])(selected|active|checked|pressed|chosen)([\s_-]|$)|is-?(selected|active|checked)/i.test(typeof b.className === 'string' ? b.className : '');

const ariaChecked = (el: HTMLElement) => el.getAttribute('aria-checked') === 'true';

/** The text a picker button or combobox currently shows as its value. */
export function shownChoice(el: HTMLElement): string {
  const picked = pickedText(el);
  if (picked) return picked;
  if (el instanceof (el.ownerDocument.defaultView ?? window).HTMLInputElement) return normalize(el.value);
  const t = normalize(el.getAttribute('aria-valuetext') ?? '') || normalize(textOf(el)) || normalize(el.getAttribute('value') ?? '');
  return PLACEHOLDER_RE.test(t) ? '' : t;
}

export function hasValue(q: Question): boolean {
  const el = q.el;
  if (q.kind === 'radio') return q.members.some((m) => m.checked);
  if (q.kind === 'checkbox') return q.members.length ? (el as HTMLInputElement).checked : ariaChecked(el);
  if (q.kind === 'checkboxes') return q.members.some((m) => m.checked);
  if (q.kind === 'select') {
    const o = (el as HTMLSelectElement).selectedOptions[0];
    return !!o && !isPlaceholderOption(o);
  }
  if (q.kind === 'file') return ((el as HTMLInputElement).files?.length ?? 0) > 0;
  if (q.kind === 'listbox') return !!shownChoice(el);
  if (q.kind === 'buttons') return (q.choices ?? []).some(isChosen);
  if (q.kind === 'editable') return !!el.textContent?.trim();
  // React-select and Workday prompts clear their search box once a choice is made and show the choice beside it.
  if (q.kind === 'combobox') return !!(el as HTMLInputElement).value?.trim() || !!pickedText(el);
  return !!(el as HTMLInputElement).value?.trim();
}

/** What a field currently holds, as the user would read it (for "kept" and "changed to" messages). */
export function shownValue(q: Question): string {
  const el = q.el;
  switch (q.kind) {
    case 'radio':
    case 'checkboxes':
      return q.members
        .filter((m) => m.checked)
        .map(optionLabel)
        .join(', ');
    case 'checkbox':
      return (q.members.length ? (el as HTMLInputElement).checked : ariaChecked(el)) ? 'checked' : '';
    case 'select':
      return isSelect(el) ? (el.selectedOptions[0]?.textContent ?? '').trim() : '';
    case 'file':
      return Array.from((el as HTMLInputElement).files ?? [])
        .map((f) => f.name)
        .join(', ');
    case 'buttons':
      return (q.choices ?? [])
        .filter(isChosen)
        .map((c) => (c.textContent ?? '').trim())
        .join(', ');
    case 'listbox':
    case 'combobox':
      return shownChoice(el);
    case 'editable':
      return (el.textContent ?? '').trim();
    default:
      return (el as HTMLInputElement).value ?? '';
  }
}

/** What a filled field should keep showing; checked again once the page settles. */
export type Expect =
  | { type: 'text'; value: string }
  | { type: 'select'; text: string }
  | { type: 'checked'; labels: string[] }
  | { type: 'checkbox'; checked: boolean }
  | { type: 'chosen'; text: string }
  | { type: 'picked'; text: string }
  | { type: 'file'; name: string; size: number };

const sameChoice = (shown: string, wanted: string) => !!shown && (normalize(shown) === normalize(wanted) || optionScore(shown, wanted) >= 0.9 || containsWords(shown, wanted));

/** Whether the field still shows what was set. */
export function holds(q: Question, e: Expect): boolean {
  const el = q.el;
  if (!el.isConnected) return false;
  switch (e.type) {
    case 'text':
      return q.kind === 'editable' ? sameText((el.textContent ?? '').trim(), e.value) : sameText((el as HTMLInputElement).value ?? '', e.value);
    case 'select': {
      const o = isSelect(el) ? el.selectedOptions[0] : undefined;
      return !!o && normalize(o.textContent) === normalize(e.text);
    }
    case 'checked': {
      const want = new Set(e.labels.map(normalize));
      const hits = q.members.filter((m) => want.has(normalize(optionLabel(m))));
      return hits.length === want.size && hits.every((m) => m.checked);
    }
    case 'checkbox':
      return (q.members.length ? (el as HTMLInputElement).checked : ariaChecked(el)) === e.checked;
    case 'chosen': {
      const c = (q.choices ?? []).find((x) => normalize(x.textContent || x.getAttribute('aria-label')) === normalize(e.text));
      if (c && isChosen(c)) return true;
      // Groups that record the answer only in a hidden input next to the buttons.
      const hidden = el.querySelector<HTMLInputElement>('input[type=hidden]');
      return !!hidden && !!hidden.value && sameChoice(hidden.value, e.text);
    }
    case 'picked':
      return sameChoice(shownChoice(el), e.text);
    case 'file': {
      const f = (el as HTMLInputElement).files?.[0];
      return !!f && f.name === e.name && f.size === e.size;
    }
  }
}

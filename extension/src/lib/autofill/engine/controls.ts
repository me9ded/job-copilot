import { isPlaceholderOption, optionLabel, type Question } from './discover';
import { byId, deepAll, isVisible, parentOf } from './dom';
import { blurOut, fireChange, fireInput, focusIn, key, press, setEditable, setNativeValue, setText, typeValue } from './interact';
import { formatForPlaceholder, optionScore, pickOption, sameText, toIsoDate } from './match';
import { settle, tick, waitForDom } from './observe';
import { holds, isChosen, shownChoice, type Expect } from './verify';

/**
 * Filling one control and confirming it took the value. Custom dropdowns
 * are opened, their own options found (never options already showing
 * elsewhere on the page), the answer chosen strictly, and the result read
 * back. A value that doesn't stick is reported, not counted.
 */

export type ApplyResult =
  | { ok: true; expect: Expect; value: string }
  | { ok: false; reason: 'no_option' | 'ambiguous' | 'rejected' | 'unsupported'; message: string; options?: string[] };

type TextControl = HTMLInputElement | HTMLTextAreaElement;

const fail = (reason: Exclude<ApplyResult, { ok: true }>['reason'], message: string, options?: string[]): ApplyResult => ({ ok: false, reason, message, options: options?.slice(0, 40) });

/** Option markup used by common pickers besides role=option (react-select, Workday prompts, MUI, Select2). */
export const OPTION_SELECTOR = '[role=option], [data-automation-id=promptOption], .select__option, [class*="__option"], .select2-results__option, [role=menuitemradio]';

const optionText = (o: HTMLElement) => (o.textContent ?? o.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();

/** The options showing right now, so a picker's own options can be told apart from ones already on the page. */
export function visibleOptionSet(doc: Document): Set<Element> {
  return new Set(deepAll<HTMLElement>(doc, OPTION_SELECTOR).filter(isVisible));
}

function dedupe(opts: HTMLElement[]): HTMLElement[] {
  // A react-select option wrapper and its role=option child are the same choice.
  const set = new Set(opts);
  return opts.filter((o) => !(o.parentElement && set.has(o.parentElement)) && !!optionText(o));
}

/** The options of the list this control opened: by aria-controls / aria-owns / aria-activedescendant, else those that appeared since. */
export function ownedOptions(owner: HTMLElement, before: Set<Element>): HTMLElement[] {
  const doc = owner.ownerDocument;
  const related = [owner, owner.closest('[role=combobox]'), owner.querySelector('[role=combobox], input')].filter((x): x is HTMLElement => !!x);
  for (const el of related) {
    const ids = `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/).filter(Boolean);
    for (const id of ids) {
      const list = byId(el, id) ?? doc.getElementById(id);
      const opts = list ? dedupe(Array.from(list.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(isVisible)) : [];
      if (opts.length) return opts;
    }
    const active = el.getAttribute('aria-activedescendant');
    const list = active ? (byId(el, active) ?? doc.getElementById(active))?.closest('[role=listbox]') : null;
    if (list) {
      const opts = dedupe(Array.from(list.querySelectorAll<HTMLElement>(OPTION_SELECTOR)).filter(isVisible));
      if (opts.length) return opts;
    }
  }
  return dedupe(deepAll<HTMLElement>(doc, OPTION_SELECTOR).filter((o) => !before.has(o) && isVisible(o)));
}

const nonEmpty = <T>(xs: T[]) => (xs.length ? xs : null);

/** Keyboard fallback: arrow down until the option is the active one, then Enter. */
async function chooseByKeyboard(owner: HTMLElement, opt: HTMLElement): Promise<boolean> {
  focusIn(owner);
  for (let i = 0; i < 80; i++) {
    key(owner, 'ArrowDown');
    await Promise.resolve();
    const active = owner.getAttribute('aria-activedescendant');
    if ((active && opt.id && active === opt.id) || opt.getAttribute('aria-selected') === 'true' || /focused|highlighted|active/i.test(typeof opt.className === 'string' ? opt.className : '')) {
      key(owner, 'Enter');
      return true;
    }
  }
  return false;
}

function closeList(owner: HTMLElement) {
  key(owner, 'Escape');
}

async function fillText(q: Question, value: string): Promise<ApplyResult> {
  const el = q.el as TextControl;
  const max = el.maxLength > 0 ? el.maxLength : Infinity;
  const placeholder = el.getAttribute('placeholder') ?? '';
  const v = (formatForPlaceholder(value, placeholder) ?? value).slice(0, max);
  const before = el.value;
  setText(el, v);
  await tick();
  if (sameText(el.value, v)) return { ok: true, expect: { type: 'text', value: v }, value: v };
  // Fields that rebuild their value from key presses (masks, some controlled inputs).
  await typeValue(el, v);
  await tick();
  if (sameText(el.value, v)) return { ok: true, expect: { type: 'text', value: v }, value: v };
  const got = el.value;
  // Leave the field as it was rather than half-typed.
  setText(el, before);
  return fail('rejected', got ? `The field changed it to “${got.slice(0, 60)}”.` : 'The field didn’t keep the value.');
}

async function fillSelect(q: Question, value: string, place: boolean): Promise<ApplyResult> {
  const el = q.el as HTMLSelectElement;
  const options = Array.from(el.options).filter((o) => !isPlaceholderOption(o) && !o.disabled);
  const texts = options.map((o) => (o.textContent ?? o.value).trim());
  const pick = pickOption(options, (o) => o.textContent ?? o.value, value, { place });
  if (!pick) return fail('no_option', `No choice matches “${value}”.`, texts);
  if ('ambiguous' in pick) return fail('ambiguous', `More than one choice could mean “${value}”.`, pick.ambiguous.map((o) => (o.textContent ?? '').trim()));
  const opt = pick.item;
  focusIn(el);
  setNativeValue(el, opt.value);
  if (el.value !== opt.value) opt.selected = true;
  fireInput(el);
  fireChange(el);
  blurOut(el);
  await tick();
  const expect: Expect = { type: 'select', text: (opt.textContent ?? '').trim() };
  return holds(q, expect) ? { ok: true, expect, value: expect.text } : fail('rejected', 'The page reset this choice.');
}

async function fillRadio(q: Question, value: string): Promise<ApplyResult> {
  const labels = q.members.map(optionLabel);
  const pick = pickOption(q.members, optionLabel, value);
  if (!pick) return fail('no_option', `No choice matches “${value}”.`, labels);
  if ('ambiguous' in pick) return fail('ambiguous', `More than one choice could mean “${value}”.`, pick.ambiguous.map(optionLabel));
  const m = pick.item;
  if (!m.checked) press(m);
  await tick();
  if (!m.checked && m.labels?.[0]) {
    press(m.labels[0]);
    await tick();
  }
  const expect: Expect = { type: 'checked', labels: [optionLabel(m)] };
  return m.checked ? { ok: true, expect, value: optionLabel(m) } : fail('rejected', 'The choice didn’t stay selected.');
}

const YES_RE = /^(yes|y|true|1|checked|on|i (agree|accept|consent|confirm))\b/i;
const NO_RE = /^(no|n|false|0|unchecked|off)\b/i;

async function fillCheckbox(q: Question, value: string): Promise<ApplyResult> {
  const native = q.members.length > 0;
  const el = q.el;
  const want = YES_RE.test(value.trim()) || optionScore(native ? optionLabel(el as HTMLInputElement) : q.label, value) >= 0.9;
  const dontWant = NO_RE.test(value.trim());
  if (!want && !dontWant) return fail('no_option', `“${value}” isn’t a yes or no for this checkbox.`);
  const checked = () => (native ? (el as HTMLInputElement).checked : el.getAttribute('aria-checked') === 'true');
  if (checked() !== want) press(el);
  await tick();
  if (checked() !== want && native && (el as HTMLInputElement).labels?.[0]) {
    press((el as HTMLInputElement).labels![0]!);
    await tick();
  }
  const expect: Expect = { type: 'checkbox', checked: want };
  return checked() === want ? { ok: true, expect, value: want ? 'checked' : 'unchecked' } : fail('rejected', 'The checkbox didn’t change.');
}

async function fillCheckboxes(q: Question, value: string): Promise<ApplyResult> {
  const wanted = value.split(/\s*[;\n]\s*|\s*,\s*(?=[A-Z])/).filter(Boolean);
  const chosen: HTMLInputElement[] = [];
  for (const w of wanted) {
    const pick = pickOption(q.members, optionLabel, w);
    if (!pick) return fail('no_option', `No choice matches “${w}”.`, q.members.map(optionLabel));
    if ('ambiguous' in pick) return fail('ambiguous', `More than one choice could mean “${w}”.`, pick.ambiguous.map(optionLabel));
    if (!pick.item.checked) press(pick.item);
    chosen.push(pick.item);
  }
  await tick();
  const expect: Expect = { type: 'checked', labels: chosen.map(optionLabel) };
  return chosen.length && holds(q, expect) ? { ok: true, expect, value: expect.labels.join(', ') } : fail('rejected', 'Some choices didn’t stay ticked.');
}

async function fillButtons(q: Question, value: string): Promise<ApplyResult> {
  const choices = q.choices ?? [];
  const text = (c: HTMLElement) => c.textContent || c.getAttribute('aria-label') || '';
  const pick = pickOption(choices, text, value);
  if (!pick) return fail('no_option', `No choice matches “${value}”.`, choices.map((c) => text(c).trim()));
  if ('ambiguous' in pick) return fail('ambiguous', `More than one choice could mean “${value}”.`, pick.ambiguous.map((c) => text(c).trim()));
  const b = pick.item;
  if (!isChosen(b)) press(b);
  await settle(b.ownerDocument, 60, 800);
  const expect: Expect = { type: 'chosen', text: text(b).trim() };
  return holds(q, expect) ? { ok: true, expect, value: expect.text } : fail('rejected', 'The page didn’t show the choice as selected.');
}

async function fillDate(q: Question, value: string): Promise<ApplyResult> {
  const el = q.el as HTMLInputElement;
  const iso = toIsoDate(value, el.type === 'month' ? 'month' : 'date');
  if (!iso) return fail('no_option', `“${value}” isn’t a date.`);
  setText(el, iso);
  await tick();
  return el.value === iso ? { ok: true, expect: { type: 'text', value: iso }, value: iso } : fail('rejected', 'The date wasn’t accepted.');
}

async function fillEditable(q: Question, value: string): Promise<ApplyResult> {
  setEditable(q.el, value);
  await tick();
  const expect: Expect = { type: 'text', value };
  return holds(q, expect) ? { ok: true, expect, value } : fail('rejected', 'The editor didn’t keep the text.');
}

/** Free-text pickers (location / city) accept typed text when no suggestion matches. */
const acceptsTypedText = (q: Question) => q.ds.some((d) => /location|\bcity\b/.test(d));

async function fillCombobox(q: Question, value: string, place: boolean): Promise<ApplyResult> {
  const el = q.el as HTMLInputElement;
  const doc = el.ownerDocument;
  const before = visibleOptionSet(doc);
  press(el);
  focusIn(el);
  setNativeValue(el, value);
  fireInput(el, 'insertText', value);
  key(el, 'ArrowDown');
  let opts = await waitForDom(doc, () => nonEmpty(ownedOptions(el, before)), 1500);
  // Search prompts (Workday's "How did you hear about us", school and skill pickers) only search on Enter.
  // Pressed only while no list is open: with a list open, Enter would pick whatever option is highlighted.
  if (!opts && !ownedOptions(el, before).length) {
    key(el, 'Enter');
    opts = await waitForDom(doc, () => nonEmpty(ownedOptions(el, before)), 2500);
  }
  if (opts) {
    const pick = pickOption(opts, optionText, value, { place });
    if (pick && 'ambiguous' in pick) {
      closeList(el);
      setText(el, '');
      return fail('ambiguous', `More than one suggestion could mean “${value}”.`, pick.ambiguous.map(optionText));
    }
    if (pick) {
      const wanted = optionText(pick.item);
      press(pick.item);
      await settle(doc, 120, 1500);
      blurOut(el);
      await tick();
      const expect: Expect = { type: 'picked', text: wanted };
      if (holds(q, expect)) return { ok: true, expect, value: wanted };
      // The click didn't take: choose it with the keyboard instead.
      const again = ownedOptions(el, before).find((o) => optionText(o) === wanted);
      if (again && (await chooseByKeyboard(el, again))) {
        await settle(doc, 120, 1500);
        blurOut(el);
        await tick();
        if (holds(q, expect)) return { ok: true, expect, value: wanted };
      }
      return fail('rejected', 'The picker didn’t keep the choice.');
    }
  }
  closeList(el);
  if (acceptsTypedText(q)) {
    blurOut(el);
    await tick();
    if (sameText(el.value, value) || sameText(shownChoice(el), value)) return { ok: true, expect: { type: 'text', value }, value };
  }
  const offered = opts?.map(optionText);
  setText(el, '');
  return fail(opts ? 'no_option' : 'rejected', opts ? `No suggestion matches “${value}”.` : 'The picker showed no suggestions.', offered);
}

async function fillListbox(q: Question, value: string, place: boolean): Promise<ApplyResult> {
  const el = q.el;
  const doc = el.ownerDocument;
  const before = visibleOptionSet(doc);
  press(el);
  let opts = await waitForDom(doc, () => nonEmpty(ownedOptions(el, before)), 2500);
  if (!opts) {
    key(el, 'ArrowDown');
    opts = await waitForDom(doc, () => nonEmpty(ownedOptions(el, before)), 1500);
  }
  if (!opts) {
    closeList(el);
    return fail('rejected', 'The list of choices didn’t open.');
  }
  const pick = pickOption(opts, optionText, value, { place });
  if (!pick || 'ambiguous' in pick) {
    const offered = opts.map(optionText);
    closeList(el);
    doc.body.dispatchEvent(new (doc.defaultView ?? window).MouseEvent('mousedown', { bubbles: true }));
    return pick ? fail('ambiguous', `More than one choice could mean “${value}”.`, pick.ambiguous.map(optionText)) : fail('no_option', `No choice matches “${value}”.`, offered);
  }
  const wanted = optionText(pick.item);
  press(pick.item);
  await settle(doc, 120, 1500);
  const expect: Expect = { type: 'picked', text: wanted };
  if (holds(q, expect)) return { ok: true, expect, value: wanted };
  // Re-open and use the keyboard.
  const before2 = visibleOptionSet(doc);
  press(el);
  const opts2 = await waitForDom(doc, () => nonEmpty(ownedOptions(el, before2)), 1500);
  const again = opts2?.find((o) => optionText(o) === wanted);
  if (again && (await chooseByKeyboard(el, again))) {
    await settle(doc, 120, 1500);
    if (holds(q, expect)) return { ok: true, expect, value: wanted };
  }
  closeList(el);
  return fail('rejected', 'The picker didn’t keep the choice.');
}

/** Applies an answer to a question and confirms the page kept it. */
export async function applyAnswerDetailed(q: Question, value: string, opts: { place?: boolean } = {}): Promise<ApplyResult> {
  const place = !!opts.place;
  try {
    switch (q.kind) {
      case 'text':
      case 'textarea':
        return await fillText(q, value);
      case 'select':
        return await fillSelect(q, value, place);
      case 'radio':
        return await fillRadio(q, value);
      case 'checkbox':
        return await fillCheckbox(q, value);
      case 'checkboxes':
        return await fillCheckboxes(q, value);
      case 'combobox':
        return await fillCombobox(q, value, place);
      case 'listbox':
        return await fillListbox(q, value, place);
      case 'date':
        return await fillDate(q, value);
      case 'buttons':
        return await fillButtons(q, value);
      case 'editable':
        return await fillEditable(q, value);
      case 'file':
        return fail('unsupported', 'Files are attached separately.');
    }
  } catch (err) {
    return fail('rejected', `The page raised an error (${err instanceof Error ? err.message.slice(0, 80) : 'unknown'}).`);
  }
}

/** Applies an answer; true only when the page kept it. */
export async function applyAnswer(q: Question, value: string): Promise<boolean> {
  return (await applyAnswerDetailed(q, value)).ok;
}

/* ----------------------------------------------------------------------------
 * Files
 * ------------------------------------------------------------------------- */

export interface FillFile {
  name: string;
  type: string;
  base64: string;
}

export type AttachOutcome = { status: 'attached'; name: string } | { status: 'already'; name: string } | { status: 'not_accepted'; reason: string } | { status: 'rejected'; reason: string };

function toFile(view: Window & typeof globalThis, file: FillFile): File {
  const bin = atob(file.base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new view.File([bytes], file.name, { type: file.type });
}

function accepts(input: HTMLInputElement, file: FillFile): boolean {
  const accept = (input.accept ?? '').toLowerCase();
  if (!accept) return true;
  const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
  return accept.split(',').some((a) => {
    const t = a.trim();
    return t === ext || t === file.type || t === '*/*' || (t.endsWith('/*') && file.type.startsWith(t.slice(0, -1)));
  });
}

const ERROR_TEXT = /error|invalid|failed|too large|not supported|unsupported|couldn'?t|could not|try again/i;

/** Error text the upload widget shows next to the input, if any. */
function uploadError(input: HTMLInputElement): string {
  let n: Element | null = parentOf(input);
  for (let depth = 0; n && depth < 4; depth++, n = parentOf(n)) {
    for (const e of Array.from(n.querySelectorAll<HTMLElement>('[role=alert], [aria-live], [class*=error], [class*=Error]'))) {
      const t = (e.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 200 && ERROR_TEXT.test(t) && isVisible(e)) return t;
    }
  }
  return '';
}

/**
 * Attaches a file through the input's own file list, then confirms the
 * browser kept exactly that file and watches briefly for the widget's error
 * message. Reported as attached only when the input holds the file.
 */
export async function attachFile(input: HTMLInputElement, file: FillFile, overwrite: boolean): Promise<AttachOutcome> {
  const current = input.files?.[0];
  if (current && !overwrite) return { status: 'already', name: current.name };
  if (!accepts(input, file)) return { status: 'not_accepted', reason: `This upload takes ${input.accept.replace(/,/g, ', ')} files.` };
  const view = (input.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  const DT = (view as unknown as { DataTransfer?: typeof DataTransfer }).DataTransfer;
  if (typeof DT === 'undefined') return { status: 'rejected', reason: 'This browser didn’t allow setting the file.' };
  const f = toFile(view, file);
  try {
    const dt = new DT();
    dt.items.add(f);
    input.files = dt.files;
  } catch (err) {
    return { status: 'rejected', reason: `The browser refused the file (${err instanceof Error ? err.message : 'unknown error'}).` };
  }
  fireInput(input);
  fireChange(input);
  const kept = () => {
    const got = input.files?.[0];
    return !!got && got.name === f.name && got.size === f.size;
  };
  if (!kept()) return { status: 'rejected', reason: 'The page didn’t keep the file.' };
  // Upload widgets validate (and sometimes upload) right away; a quick error means it was refused.
  const err = await waitForDom(input.ownerDocument, () => uploadError(input) || null, 1200);
  if (err) return { status: 'rejected', reason: err };
  return { status: 'attached', name: f.name };
}


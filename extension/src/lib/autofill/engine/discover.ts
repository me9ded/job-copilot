import { byId, deepAll, isHoneypot, isOwnUi, isVisible, parentOf, rootOf, viewOf, type Root } from './dom';
import { cleanLabel, normalize, textOf } from './text';

/**
 * Field discovery: every control a person could answer, with the text that
 * describes it. Finds native inputs, selects and text areas, radio and
 * checkbox groups (native and ARIA), comboboxes, picker buttons, rich-text
 * editors, Yes / No button groups and file inputs, including those inside
 * open shadow roots. Hidden, disabled, read-only, search, password and
 * honeypot fields are left out.
 */

export type QuestionKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkboxes' | 'combobox' | 'listbox' | 'file' | 'buttons' | 'date' | 'editable';

export interface Descriptor {
  text: string;
  /** How much this text says about the field: 1 for its label, less for names, ids and nearby text. */
  w: number;
}

export interface Question {
  /** Stable within the page: kind, label and position among fields with the same label. */
  id: string;
  kind: QuestionKind;
  label: string;
  /** Normalised descriptor texts, most specific first. */
  ds: string[];
  dw: Descriptor[];
  /** The heading of the section the field is in ("References", "Emergency contact"). */
  section: string;
  el: HTMLElement;
  members: HTMLInputElement[];
  /** Option buttons of a 'buttons' question (Yes / No toggles). */
  choices?: HTMLElement[];
  required: boolean;
}

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6, legend, [role=heading]';

/** Label-ish text sources for a control, weighted by how directly they describe it. */
export function weightedDescriptors(el: HTMLElement): Descriptor[] {
  const out: Descriptor[] = [];
  const push = (s: string | null | undefined, w: number) => {
    const n = normalize(s);
    if (!n || n.length > 300) return;
    const have = out.find((d) => d.text === n);
    if (have) have.w = Math.max(have.w, w);
    else out.push({ text: n, w });
  };
  push(el.getAttribute('autocomplete')?.replace(/^(section-\S+\s+)?(shipping |billing )?/, ''), 1);
  push(el.getAttribute('name'), 0.7);
  push(el.id, 0.6);
  const labels = (el as HTMLInputElement).labels;
  if (labels) for (const l of Array.from(labels)) push(textOf(l), 1);
  push(textOf(el.closest('label')), 1);
  push(el.getAttribute('aria-label'), 1);
  for (const id of (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) push(textOf(byId(el, id)), 1);
  push(el.getAttribute('placeholder'), 0.8);
  push(el.getAttribute('title'), 0.7);
  push(el.getAttribute('data-qa'), 0.7);
  push(el.getAttribute('data-automation-id'), 0.7);
  // Unlabelled ATS markup: the text of the nearest container that holds only this control.
  if (out.length < 4) {
    let node: Element | null = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (node.querySelectorAll('input:not([type=hidden]), textarea, select, [role=combobox], button[aria-haspopup=listbox]').length > 1) break;
      const t = normalize(textOf(node));
      if (t) {
        push(t.slice(0, 200), 0.6);
        break;
      }
    }
  }
  // Help text under the field: a hint about the field, never enough on its own to fill it.
  for (const id of (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)) push(textOf(byId(el, id)).slice(0, 200), 0.3);
  return out;
}

export const descriptors = (el: HTMLElement): string[] => weightedDescriptors(el).map((d) => d.text);

/**
 * What the section around a file input is about. Upload widgets (Workday's drop
 * zone, many custom careers sites) put "Resume/CV" in a heading or an automation
 * id several levels above the hidden input, past where `descriptors` looks.
 */
export function sectionContext(el: HTMLElement): string[] {
  const out: string[] = [];
  let n: Element | null = el.parentElement;
  for (let depth = 0; n && depth < 8; depth++, n = n.parentElement) {
    // Stop before a container that also holds another upload: its heading isn't this one's.
    if (n.querySelectorAll('input[type=file]').length > 1) break;
    for (const attr of ['data-automation-id', 'aria-label', 'id']) {
      const v = normalize(n.getAttribute(attr));
      if (v && v.length <= 80) out.push(v);
    }
    const heading = n.querySelector(HEADING_SEL);
    const t = heading ? normalize(textOf(heading)) : '';
    if (t && t.length <= 80) {
      out.push(t);
      break;
    }
  }
  return out;
}

/**
 * The heading of the part of the form a field sits in: its fieldset legend, a
 * labelled group, or the nearest heading above it. A legend or heading that is
 * the question itself (`own`, e.g. a radio group's legend) is passed over.
 */
export function sectionOf(el: Element, own = ''): string {
  const self = normalize(cleanLabel(own));
  const take = (text: string) => {
    const t = cleanLabel(text);
    return t && normalize(t) !== self ? t.slice(0, 80) : '';
  };
  let child: Element = el;
  for (let n = parentOf(el), depth = 0; n && depth < 10; child = n, n = parentOf(n), depth++) {
    if (n.tagName === 'FIELDSET') {
      const legend = Array.from(n.children).find((c) => c.tagName === 'LEGEND');
      const t = legend ? take(textOf(legend)) : '';
      if (t) return t;
    }
    const role = n.getAttribute('role');
    if ((role === 'group' || role === 'region') && n.getAttribute('aria-label')) {
      const t = take(n.getAttribute('aria-label')!);
      if (t) return t;
    }
    for (let sib = child.previousElementSibling, hops = 0; sib && hops < 12; sib = sib.previousElementSibling, hops++) {
      const inner = sib.matches(HEADING_SEL) ? [sib] : Array.from(sib.querySelectorAll(HEADING_SEL));
      const last = inner[inner.length - 1];
      if (!last) continue;
      const t = take(textOf(last));
      if (t) return t;
    }
    if (n.tagName === 'FORM' || n.tagName === 'BODY') break;
  }
  return '';
}

/** The label as shown (a trailing "*" is kept so `isRequired` can see it). */
export function visibleLabel(el: HTMLElement, fallback: string): string {
  const collapse = (t: string) => t.replace(/\s+/g, ' ').trim();
  const labels = (el as HTMLInputElement).labels;
  const fromLabel = labels?.[0] ? collapse(textOf(labels[0])) : '';
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  const fromIds = ids.length ? collapse(ids.map((id) => textOf(byId(el, id))).join(' ')) : '';
  return fromLabel || fromIds || el.getAttribute('aria-label') || el.getAttribute('placeholder') || fallback;
}

const REQUIRED_TEXT = /\*\s*$|\(required\)\s*$|\brequired\s*$/i;

function isRequired(el: HTMLElement, label: string): boolean {
  return (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true' || REQUIRED_TEXT.test(label.trim());
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

export function optionLabel(el: HTMLInputElement): string {
  const l = el.labels?.[0] ? textOf(el.labels[0]) : el.closest('label') ? textOf(el.closest('label')) : (el.getAttribute('aria-label') ?? el.value);
  return cleanLabel(l);
}

const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'url', 'number']);
const DATE_TYPES = new Set(['date', 'month']);

/** Short answers that make a set of buttons a question ("Yes" / "No" toggles). */
const CHOICE_TEXT_RE = /^(yes|no|maybe|not sure|n\/?a|prefer not to (say|answer)|decline( to answer)?|true|false)$/;

const choiceText = (b: HTMLElement) => normalize(b.textContent || b.getAttribute('aria-label') || '');

/** A site's search box, never an application field. */
function isSearchBox(el: HTMLElement): boolean {
  if ((el as HTMLInputElement).type?.toLowerCase() === 'search' || el.getAttribute('role') === 'searchbox' || el.closest('[role=search]')) return true;
  const own = normalize(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('name') ?? ''}`);
  return /^(search|keywords?|q)( jobs?| for jobs| this site| site)?$|^search (jobs|by|for|the site)/.test(own);
}

const disabled = (el: HTMLElement) => (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

/** Questions answered by pressing one of several buttons: role=radio widgets and Yes/No button pairs. */
function buttonGroups(root: Root, handled: Set<Element>): Question[] {
  const out: Question[] = [];
  const groups = new Map<Element, HTMLElement[]>();
  for (const b of deepAll<HTMLElement>(root, '[role=radio]:not(input), button[aria-pressed], button[type=button]')) {
    if (handled.has(b) || !isVisible(b) || isOwnUi(b)) continue;
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
    const required = parent.getAttribute('aria-required') === 'true' || REQUIRED_TEXT.test(label.trim());
    const n = normalize(label);
    out.push(make('buttons', label, n ? [{ text: n, w: 1 }] : [], parent as HTMLElement, [], required, choices));
  }
  return out;
}

function make(kind: QuestionKind, rawLabel: string, dw: Descriptor[], el: HTMLElement, members: HTMLInputElement[], required: boolean, choices?: HTMLElement[]): Question {
  return { id: '', kind, label: cleanLabel(rawLabel), ds: dw.map((d) => d.text), dw, section: '', el, members, choices, required };
}

/** Assigns ids ("text:email#1") and section headings once the page's questions are known. */
function finish(questions: Question[]): Question[] {
  const counts = new Map<string, number>();
  for (const q of questions) {
    const base = `${q.kind}:${normalize(q.label) || q.ds[0] || 'field'}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    q.id = `${base}#${n}`;
    q.section = sectionOf(q.kind === 'radio' || q.kind === 'checkboxes' ? (q.members[0] ?? q.el) : q.el, q.label);
  }
  return questions;
}

export function findQuestions(root: Root): Question[] {
  const out: Question[] = [];
  const handled = new Set<Element>();
  const controls = deepAll<HTMLElement>(
    root,
    'input, textarea, select, [role=combobox], button[aria-haspopup=listbox], [role=checkbox]:not(input), [role=switch]:not(input), [contenteditable=""], [contenteditable=true], [role=textbox]:not(input):not(textarea)',
  );
  const fileInputs = controls.filter((c) => c instanceof viewOf(c).HTMLInputElement && (c as HTMLInputElement).type.toLowerCase() === 'file');
  for (const el of controls) {
    if (handled.has(el) || isOwnUi(el)) continue;
    handled.add(el);
    const view = viewOf(el);
    if (el instanceof view.HTMLInputElement) {
      const type = el.type.toLowerCase();
      if (type === 'file') {
        if (el.disabled) continue;
        const dw = weightedDescriptors(el);
        const has = (re: RegExp) => dw.some((d) => re.test(d.text));
        const docTypeKnown = () => has(/resume|résumé|\bcv\b|curriculum|cover ?letter|motivation letter|letter of (interest|motivation)/) || has(OTHER_DOC_RE);
        if (!docTypeKnown()) for (const c of sectionContext(el)) if (!dw.some((d) => d.text === c)) dw.push({ text: c, w: 0.6 });
        // The only upload on an application that asks for a résumé somewhere is the résumé.
        if (!docTypeKnown() && fileInputs.length === 1 && /resume|résumé|\bcv\b|curriculum/.test(normalize(el.ownerDocument.body?.textContent))) dw.push({ text: 'resume', w: 0.5 });
        out.push(make('file', visibleLabel(el, dw[0]?.text ?? 'File'), dw, el, [], isRequired(el, '')));
        continue;
      }
      if (type === 'hidden' || type === 'password' || type === 'submit' || type === 'button' || type === 'reset' || type === 'image') continue;
      // Styled radios / checkboxes often hide the input itself and show its label.
      const shown = isVisible(el) || ((type === 'radio' || type === 'checkbox') && !!el.labels?.[0] && isVisible(el.labels[0]));
      if (disabled(el) || !shown) continue;
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
          out.push(make('checkbox', label, [{ text: normalize(label), w: 1 }, { text: normalize(el.name), w: 0.7 }].filter((d) => d.text), el, members, isRequired(el, raw)));
        } else {
          const label = groupLabel(members);
          const required = members.some((m) => m.required) || el.closest('[aria-required=true]') !== null || REQUIRED_TEXT.test(cleanLabel(label)) || REQUIRED_TEXT.test(label.trim());
          out.push(make(type === 'radio' ? 'radio' : 'checkboxes', label, [{ text: normalize(label), w: 1 }, { text: normalize(el.name), w: 0.7 }].filter((d) => d.text), el, members, required));
        }
        continue;
      }
      if (el.readOnly || isHoneypot(el) || isSearchBox(el)) continue;
      if (DATE_TYPES.has(type)) {
        const dw = weightedDescriptors(el);
        out.push(make('date', visibleLabel(el, dw[0]?.text ?? 'Date'), dw, el, [], isRequired(el, visibleLabel(el, ''))));
        continue;
      }
      if (!TEXT_TYPES.has(type)) continue;
      const dw = weightedDescriptors(el);
      const label = visibleLabel(el, dw[0]?.text ?? 'Field');
      const kind: QuestionKind = el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' ? 'combobox' : 'text';
      out.push(make(kind, label, dw, el, [], isRequired(el, label)));
      continue;
    }
    if (!isVisible(el) || disabled(el)) continue;
    if (el instanceof view.HTMLTextAreaElement) {
      if (el.readOnly || isHoneypot(el)) continue;
      const dw = weightedDescriptors(el);
      const label = visibleLabel(el, dw[0]?.text ?? 'Field');
      out.push(make('textarea', label, dw, el, [], isRequired(el, label)));
    } else if (el instanceof view.HTMLSelectElement) {
      const dw = weightedDescriptors(el);
      const label = visibleLabel(el, dw[0]?.text ?? 'Choice');
      out.push(make('select', label, dw, el, [], isRequired(el, label)));
    } else if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
      const dw = weightedDescriptors(el);
      const label = visibleLabel(el, textOf(el).trim() || (dw[0]?.text ?? 'Checkbox'));
      out.push(make('checkbox', label, dw.length ? dw : [{ text: normalize(label), w: 1 }], el, [], isRequired(el, label)));
    } else if (el.isContentEditable || el.getAttribute('contenteditable') !== null || el.getAttribute('role') === 'textbox') {
      if (el.parentElement?.closest('[contenteditable=""], [contenteditable=true]') || el.getAttribute('aria-readonly') === 'true') continue;
      const dw = weightedDescriptors(el);
      const label = visibleLabel(el, dw[0]?.text ?? 'Answer');
      out.push(make('editable', label, dw, el, [], isRequired(el, label)));
    } else if (!el.querySelector('input')) {
      // A custom picker button (Workday-style) or a div[role=combobox] without an input.
      const dw = weightedDescriptors(el);
      const label = visibleLabel(el, dw[0]?.text ?? 'Choice');
      out.push(make('listbox', label, dw, el, [], isRequired(el, label)));
    }
  }
  out.push(...buttonGroups(root, handled));
  return finish(out);
}

/** Uploads that aren't a résumé, even when they're the only one on the page. */
export const OTHER_DOC_RE = /transcript|portfolio|writing sample|work sample|certificat|diploma|licen[cs]e|photo|headshot|reference|recommendation|additional|other (document|file)/;

const isPlaceholderText = (t: string) => /^(select|choose|please|--|—)/i.test(t.trim());
export const isPlaceholderOption = (o: HTMLOptionElement) => !o.value || isPlaceholderText(o.textContent ?? '');

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

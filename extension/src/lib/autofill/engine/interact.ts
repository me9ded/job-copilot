import { viewOf, isTextArea } from './dom';

/**
 * Acting on controls the way a person would: pointer presses, focus changes,
 * typing. Every event bubbles and is `composed`, so listeners outside a
 * shadow root (web-component forms) see it too.
 */

type TextControl = HTMLInputElement | HTMLTextAreaElement;

/** A full pointer + mouse sequence and a click, as from a real mouse press. */
export function press(el: HTMLElement) {
  el.scrollIntoView?.({ block: 'center' });
  const view = viewOf(el);
  const opts = { bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1 };
  const P = (view as unknown as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  if (P) el.dispatchEvent(new P('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new view.MouseEvent('mousedown', opts));
  focusIn(el);
  if (P) el.dispatchEvent(new P('pointerup', { ...opts, buttons: 0, pointerType: 'mouse', isPrimary: true }));
  el.dispatchEvent(new view.MouseEvent('mouseup', { ...opts, buttons: 0 }));
  el.click();
}

/**
 * Focuses an element and makes sure focus events reach the page. Chrome
 * skips them while the page itself isn't focused (the side panel is), and
 * Angular / Knockout / Workday validate and commit on focus changes.
 */
export function focusIn(el: HTMLElement) {
  const view = viewOf(el);
  let seen = false;
  const mark = () => (seen = true);
  el.addEventListener('focus', mark, { once: true });
  el.focus?.({ preventScroll: true });
  el.removeEventListener('focus', mark);
  if (seen) return;
  el.dispatchEvent(new view.FocusEvent('focus', { bubbles: false, composed: true }));
  el.dispatchEvent(new view.FocusEvent('focusin', { bubbles: true, composed: true }));
}

export function blurOut(el: HTMLElement) {
  const view = viewOf(el);
  let seen = false;
  const mark = () => (seen = true);
  el.addEventListener('blur', mark, { once: true });
  el.blur?.();
  el.removeEventListener('blur', mark);
  if (seen) return;
  el.dispatchEvent(new view.FocusEvent('blur', { bubbles: false, composed: true }));
  el.dispatchEvent(new view.FocusEvent('focusout', { bubbles: true, composed: true }));
}

/** Sets `value` through the native setter, so React's and Vue's value trackers notice the change. */
export function setNativeValue(el: TextControl | HTMLSelectElement, value: string) {
  const view = viewOf(el);
  const proto = el instanceof view.HTMLSelectElement ? view.HTMLSelectElement.prototype : isTextArea(el) ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function fireInput(el: HTMLElement, inputType = 'insertText', data: string | null = null) {
  const view = viewOf(el);
  const IE = (view as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
  el.dispatchEvent(IE ? new IE('input', { bubbles: true, composed: true, inputType, data }) : new view.Event('input', { bubbles: true, composed: true }));
}

export function fireChange(el: HTMLElement) {
  el.dispatchEvent(new (viewOf(el).Event)('change', { bubbles: true, composed: true }));
}

/** Sets a text field in one go: focus, value, input, change, blur. */
export function setText(el: TextControl, value: string) {
  focusIn(el);
  setNativeValue(el, value);
  fireInput(el, value ? 'insertReplacementText' : 'deleteContentBackward', value || null);
  fireChange(el);
  blurOut(el);
}

const KEY_CODES: Record<string, number> = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9, Backspace: 8 };

/** A key press as pickers expect it (`key`, `code` and the legacy `keyCode` some libraries still read). Returns false if the page cancelled keydown. */
export function key(el: HTMLElement, name: 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape' | 'Tab') {
  const view = viewOf(el);
  const keyCode = KEY_CODES[name] ?? 0;
  const init = { key: name, code: name, keyCode, which: keyCode, bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
  const ok = el.dispatchEvent(new view.KeyboardEvent('keydown', init));
  el.dispatchEvent(new view.KeyboardEvent('keyup', init));
  return ok;
}

/**
 * Types a value character by character, the way a keyboard does, for
 * fields that ignore a pasted value (input masks, inputs that rebuild their
 * value from key events). A cancelled keydown or beforeinput stops that
 * character, as it would in a browser.
 */
export async function typeValue(el: TextControl, value: string): Promise<void> {
  const view = viewOf(el);
  const IE = (view as unknown as { InputEvent?: typeof InputEvent }).InputEvent;
  focusIn(el);
  setNativeValue(el, '');
  fireInput(el, 'deleteContentBackward');
  for (const ch of value) {
    const code = ch.length === 1 ? ch.toUpperCase().charCodeAt(0) : 0;
    const init = { key: ch, code: /\d/.test(ch) ? `Digit${ch}` : /[a-z]/i.test(ch) ? `Key${ch.toUpperCase()}` : '', keyCode: code, which: code, charCode: ch.charCodeAt(0), bubbles: true, cancelable: true, composed: true } as KeyboardEventInit;
    const down = el.dispatchEvent(new view.KeyboardEvent('keydown', init));
    if (down) {
      el.dispatchEvent(new view.KeyboardEvent('keypress', init));
      const before = IE ? el.dispatchEvent(new IE('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: ch })) : true;
      if (before) {
        setNativeValue(el, el.value + ch);
        fireInput(el, 'insertText', ch);
      }
    }
    el.dispatchEvent(new view.KeyboardEvent('keyup', init));
    // Let masks and typeahead handlers react to each character.
    await Promise.resolve();
  }
  fireChange(el);
  blurOut(el);
}

/** Rich-text answers (contenteditable editors, role=textbox). */
export function setEditable(el: HTMLElement, value: string): void {
  const doc = el.ownerDocument;
  focusIn(el);
  const sel = doc.getSelection?.();
  if (sel) {
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // execCommand fires the native beforeinput / input events editors listen for.
  let inserted = false;
  try {
    inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, value);
  } catch {
    inserted = false;
  }
  if (!inserted || (el.textContent ?? '').trim() !== value.trim()) {
    el.textContent = value;
    fireInput(el, 'insertReplacementText', value);
  }
  blurOut(el);
}

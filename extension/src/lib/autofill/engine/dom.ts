/** DOM helpers: shadow-DOM aware lookups and visibility. Never crosses into closed shadow roots or other origins. */

export type Root = Document | Element | ShadowRoot;

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

export const viewOf = (el: Element): Window & typeof globalThis => (el.ownerDocument.defaultView ?? window) as Window & typeof globalThis;

/** The document or shadow root an element lives in (for aria-labelledby lookups). */
export function rootOf(el: Element): Document | ShadowRoot {
  const r = el.getRootNode();
  const view = el.ownerDocument.defaultView;
  return view && r instanceof view.ShadowRoot ? (r as ShadowRoot) : el.ownerDocument;
}
export const byId = (el: Element, id: string) => rootOf(el).getElementById(id);

/** Parent, crossing out of a shadow root to its host. */
export function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const r = el.getRootNode();
  return (r as ShadowRoot).host ?? null;
}

/** Whether the browser has laid the page out (jsdom doesn't; size checks are skipped there). */
export function hasLayout(doc: Document): boolean {
  const r = doc.documentElement.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}

export function isVisible(el: Element): boolean {
  const view = el.ownerDocument.defaultView;
  if (!view || !(el instanceof view.HTMLElement)) return false;
  for (let n: Element | null = el; n; n = parentOf(n)) {
    if ((n as HTMLElement).hidden || n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('inert')) return false;
    const style = view.getComputedStyle(n);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

/**
 * A field meant for bots, not people: off-screen, or squeezed to a pixel.
 * Only judged where layout exists, so a page that hasn't been laid out
 * (tests, prerendering) never loses its fields.
 */
export function isHoneypot(el: HTMLElement): boolean {
  const doc = el.ownerDocument;
  if (!hasLayout(doc)) return /honeypot|hp[-_]?field|leave (this )?(field )?(blank|empty)/i.test(`${el.getAttribute('name') ?? ''} ${el.id} ${el.className}`);
  const r = el.getBoundingClientRect();
  const view = viewOf(el);
  const left = r.left + view.scrollX;
  const top = r.top + view.scrollY;
  if (r.right + view.scrollX <= 0 || r.bottom + view.scrollY <= 0 || left > doc.documentElement.scrollWidth + 500 || top < -500) return true;
  if (r.width <= 1 && r.height <= 1) return true;
  const style = view.getComputedStyle(el);
  return style.opacity === '0' && style.pointerEvents === 'none';
}

/** Job Copilot's own on-page UI (toast, in-page panel). */
export const isOwnUi = (el: Element) => !!el.closest('job-copilot-root, job-copilot-toast');

export function isTopFrame(doc: Document): boolean {
  const view = doc.defaultView;
  try {
    return !view || view === view.top;
  } catch {
    return false;
  }
}

export const hostOf = (url: string | undefined, base?: string) => {
  try {
    return url ? new URL(url, base).hostname : '';
  } catch {
    return '';
  }
};

export const isInput = (el: Element): el is HTMLInputElement => el instanceof viewOf(el).HTMLInputElement;
export const isTextArea = (el: Element): el is HTMLTextAreaElement => el instanceof viewOf(el).HTMLTextAreaElement;
export const isSelect = (el: Element): el is HTMLSelectElement => el instanceof viewOf(el).HTMLSelectElement;

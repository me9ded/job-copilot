import { normalizeWhitespace } from '../util';

const BLOCK = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'HEADER', 'FOOTER', 'BLOCKQUOTE', 'DL', 'DT', 'DD', 'BR', 'HR', 'MAIN', 'ASIDE',
]);
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'IFRAME', 'BUTTON', 'FORM', 'INPUT', 'SELECT', 'TEXTAREA', 'IMG', 'VIDEO', 'CANVAS']);

/** Converts an element to readable text, preserving headings, paragraphs and list items. */
export function elementToText(root: Element | null | undefined): string {
  if (!root) return '';
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push((node.textContent ?? '').replace(/\s+/g, ' '));
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (SKIP.has(el.tagName)) return;
    if (el.getAttribute('aria-hidden') === 'true' || el.hasAttribute('hidden')) return;
    const block = BLOCK.has(el.tagName);
    if (el.tagName === 'LI') parts.push('\n• ');
    else if (block) parts.push('\n');
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block || el.tagName === 'LI') parts.push('\n');
  };
  walk(root);
  return normalizeWhitespace(parts.join('').replace(/\n\s*•\s*\n/g, '\n'));
}

export function htmlToText(html: string, doc: Document = document): string {
  const tpl = doc.createElement('template');
  // Template content is inert: scripts do not run and resources do not load.
  tpl.innerHTML = html;
  const wrapper = doc.createElement('div');
  wrapper.appendChild(tpl.content.cloneNode(true));
  return elementToText(wrapper);
}

/** Decodes HTML that was entity-escaped (e.g. "&lt;p&gt;") before treating it as markup. */
export function unescapeHtml(html: string, doc: Document = document): string {
  if (!/&lt;[a-z/]/i.test(html)) return html;
  const ta = doc.createElement('textarea');
  ta.innerHTML = html;
  return ta.value;
}

export function textOf(doc: Document | Element, selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const t = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return undefined;
}

export function firstEl(doc: Document | Element, selectors: string[]): Element | null {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    if (el && (el.textContent ?? '').trim().length > 0) return el;
  }
  return null;
}

export function meta(doc: Document, name: string): string | undefined {
  const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
  return el?.getAttribute('content')?.trim() || undefined;
}

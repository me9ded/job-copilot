/** Text helpers shared by the autofill engine. Pure functions; no DOM state. */

/** Lower-case words without punctuation. Splits camelCase, for attribute names ("firstName" → "first name"). */
export function normalize(s: string | null | undefined): string {
  return plain((s ?? '').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

/** Like `normalize` but keeps camelCase words whole, for text people read ("JavaScript" stays one word). */
export function plain(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/[’‘]/g, "'")
    .replace(/[_\-[\].:*()?!/,"“”]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A label as shown to the user: whitespace collapsed, a trailing required "*" removed. */
export const cleanLabel = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/\s*\*\s*$/, '')
    .replace(/\s*\((required|optional)\)\s*$/i, '')
    .trim()
    .slice(0, 160);

/** An element's own text, without the controls and option lists nested in it. */
export function textOf(el: Element | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, button, script, style, [role=listbox], [role=option]').forEach((n) => n.remove());
  return clone.textContent ?? '';
}

// "us" is deliberately not a stop word: it is also the country.
const STOP_WORDS = new Set('a an the of to in for and or you your are is do does did be have has will would with on at this that what which how if any we our please'.split(' '));
export const tokens = (s: string) => new Set(normalize(s).split(' ').filter((t) => t.length > 1 && !STOP_WORDS.has(t)));

export function overlap(a: string, b: string): { jaccard: number; contained: number } {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.size || !tb.size) return { jaccard: 0, contained: 0 };
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return { jaccard: common / (ta.size + tb.size - common), contained: common / Math.min(ta.size, tb.size) };
}

/** Same question in different words: nearly the same terms, or one phrasing fully inside the other. */
export function sameQuestion(a: string, b: string): number {
  const { jaccard, contained } = overlap(a, b);
  if (jaccard >= 0.75) return jaccard;
  return contained === 1 && jaccard >= 0.5 ? 0.75 + jaccard / 10 : 0;
}

const words = (s: string) => plain(s).split(' ').filter(Boolean);

/**
 * Whether every word of `needle` appears in `hay` as a whole word, in order
 * ("Software Engineer" in "Senior Software Engineer"; never "Java" in
 * "JavaScript" or "male" in "female").
 */
export function containsWords(hay: string, needle: string): boolean {
  const h = words(hay);
  const n = words(needle);
  if (!n.length || n.length > h.length) return false;
  for (let i = 0; i + n.length <= h.length; i++) if (n.every((w, j) => h[i + j] === w)) return true;
  return false;
}

/** Share of `hay`'s words covered by `needle` (1 when they're the same words). */
export function coverage(hay: string, needle: string): number {
  const h = words(hay).length;
  return h ? Math.min(1, words(needle).length / h) : 0;
}

export const digitsOf = (s: string) => s.replace(/\D/g, '');

/** A URL without scheme, "www." or a trailing slash, for comparing what a field kept. */
export const bareUrl = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');

/** Small, dependency-free helpers shared by every extension context. */

export const nowIso = (): string => new Date().toISOString();

export function uid(prefix = ''): string {
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
  return prefix ? `${prefix}_${id}` : id;
}

/** cyrb53: fast, synchronous, well-distributed 53-bit string hash. Not cryptographic. */
export function hash(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/ /g, ' ').replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export function uniq<T>(items: Iterable<T>): T[] {
  return Array.from(new Set(items));
}

export function uniqBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TRACKING_PARAMS = [
  /^utm_/i,
  /^gh_src$/i,
  /^gh_jid$/i,
  /^lever-(source|origin|via)/i,
  /^source$/i,
  /^src$/i,
  /^ref$/i,
  /^refid$/i,
  /^trk/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_[ce]id$/i,
  /^_hs/i,
];

/** Canonicalises a job URL for duplicate detection: strips tracking params, hash, trailing slash. */
export function canonicalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    const keep = new URLSearchParams();
    const entries = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of entries) {
      if (!TRACKING_PARAMS.some((re) => re.test(k))) keep.append(k, v);
    }
    u.search = keep.toString();
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Returns the `scheme://host/*` match pattern for a URL's origin. */
export function originPattern(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  bull: '•',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  euro: '€',
  pound: '£',
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITY_MAP[code.toLowerCase()] ?? m;
  });
}

/**
 * DOM-free HTML → text conversion for contexts without DOMParser (service worker).
 * Preserves paragraph and list structure; never executes or evaluates markup.
 */
export function htmlToTextLite(html: string): string {
  let s = html;
  s = s.replace(/<(script|style|noscript|template|svg|iframe)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|article|ul|ol|h[1-6]|tr|table|header|footer|blockquote)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return normalizeWhitespace(s.replace(/\n\s*•\s*\n/g, '\n'));
}

export function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

export function formatRelative(iso: string | undefined, now = new Date()): string {
  const d = parseDate(iso);
  if (!d) return '—';
  const days = daysBetween(d, now);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months} mo ago` : `${Math.floor(months / 12)} yr ago`;
}

export function formatDate(iso: string | undefined): string {
  const d = parseDate(iso);
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unexpected error';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

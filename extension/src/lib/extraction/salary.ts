import type { Salary } from '../types';

const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', C$: 'CAD', A$: 'AUD', CA$: 'CAD', US$: 'USD' };
const CODES = 'USD|EUR|GBP|CAD|AUD|CHF|JPY|INR|SEK|NOK|DKK|NZD|SGD|PLN|BRL|MXN';

function toNumber(raw: string, k: string | undefined): number | null {
  const n = Number(raw.replace(/[,\s]/g, '').replace(/\.(?=\d{3}\b)/g, ''));
  if (!Number.isFinite(n)) return null;
  return k && /k/i.test(k) ? n * 1000 : n;
}

function detectPeriod(text: string): Salary['period'] {
  if (/(per|an|\/|a)\s*(hour|hr)\b|hourly/i.test(text)) return 'hour';
  if (/(per|\/|a)\s*day\b|daily/i.test(text)) return 'day';
  if (/(per|\/|a)\s*week\b|weekly/i.test(text)) return 'week';
  if (/(per|\/|a)\s*month\b|monthly/i.test(text)) return 'month';
  return 'year';
}

const RANGE = new RegExp(
  String.raw`(C\$|CA\$|A\$|US\$|[$€£¥₹])?\s?(${CODES})?\s?(\d{1,3}(?:[,.\s]\d{3})+|\d+(?:\.\d+)?)\s?([kK])?\s*(?:-|–|—|to)\s*(C\$|CA\$|A\$|US\$|[$€£¥₹])?\s?(?:${CODES})?\s?(\d{1,3}(?:[,.\s]\d{3})+|\d+(?:\.\d+)?)\s?([kK])?\s?(${CODES})?`,
);

/** Parses "$120,000 – $150,000 USD", "€150K – €250K", "USD 60-75 per hour"… Returns undefined when unsure. */
export function parseSalaryText(text: string | undefined): Salary | undefined {
  if (!text) return undefined;
  const m = text.match(RANGE);
  if (!m) return undefined;
  const [, sym1, code1, a, k1, sym2, b, k2, code2] = m;
  const symbol = sym1 ?? sym2;
  const currency = code1 ?? code2 ?? (symbol ? CURRENCY_SYMBOLS[symbol] : undefined);
  if (!currency) return undefined; // bare number ranges ("3-5 years") are not salaries
  const min = toNumber(a ?? '', k1 ?? k2);
  const max = toNumber(b ?? '', k2 ?? k1);
  if (min === null || max === null || max < min) return undefined;
  const period = detectPeriod(text.slice(m.index ?? 0, (m.index ?? 0) + m[0].length + 30));
  if (period === 'year' && max < 1000) return undefined;
  return { min, max, currency, period, text: m[0].trim() };
}

/** Finds a salary statement inside a description, looking only near pay-related words. */
export function findSalaryInText(text: string): Salary | undefined {
  for (const line of text.split('\n')) {
    if (/salary|compensation|pay range|base pay|pay:|wage|hourly rate|ote|\$|€|£/i.test(line)) {
      const s = parseSalaryText(line);
      if (s) return s;
    }
  }
  return undefined;
}

export function formatSalary(s: Salary | undefined): string {
  if (!s) return '';
  if (s.min === undefined && s.max === undefined) return s.text ?? '';
  const fmt = (n: number) =>
    new Intl.NumberFormat(undefined, { style: 'currency', currency: s.currency ?? 'USD', maximumFractionDigits: 0, notation: n >= 10000 ? 'compact' : 'standard' }).format(n);
  const range = s.min !== undefined && s.max !== undefined && s.min !== s.max ? `${fmt(s.min)} – ${fmt(s.max)}` : fmt((s.max ?? s.min) as number);
  return s.period && s.period !== 'year' ? `${range} / ${s.period}` : range;
}

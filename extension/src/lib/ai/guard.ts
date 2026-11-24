import { customMatchers, extractSkills, getBaseMatchers } from '../matching/skills';
import { normalizeForCompare } from '../util';

/**
 * Factual safeguards for AI output. Generated text may only contain numbers
 * and skills that already appear in the user's own profile text. Anything
 * else is flagged and never applied without the user's explicit approval.
 */

const NUMBER_RE = /(?:[$€£]\s?)?\d[\d,.]*\s?(?:%|k|m|x|\+)?/gi;

function numbersIn(text: string): Set<string> {
  return new Set((text.match(NUMBER_RE) ?? []).map((n) => n.replace(/[\s,]/g, '').replace(/\.$/, '').toLowerCase()).filter((n) => /\d/.test(n)));
}

export interface ClaimCheck {
  unsupportedNumbers: string[];
  unsupportedSkills: string[];
  ok: boolean;
}

export function checkClaims(output: string, allowedSource: string, declaredSkills: string[] = []): ClaimCheck {
  const sourceNums = numbersIn(allowedSource);
  const unsupportedNumbers = [...numbersIn(output)].filter((n) => !sourceNums.has(n) && !sourceNums.has(n.replace(/[%+kmx]$/, '')));
  const matchers = [...getBaseMatchers(), ...customMatchers(declaredSkills)];
  const sourceSkills = new Set(extractSkills(allowedSource, matchers));
  const unsupportedSkills = extractSkills(output, matchers).filter((s) => !sourceSkills.has(s));
  return { unsupportedNumbers, unsupportedSkills, ok: !unsupportedNumbers.length && !unsupportedSkills.length };
}

/** True when a quoted piece of evidence actually appears (approximately) in the profile. */
export function evidenceSupported(quote: string, profileText: string): boolean {
  const q = normalizeForCompare(quote);
  if (q.length < 4) return false;
  const p = normalizeForCompare(profileText);
  if (p.includes(q)) return true;
  const words = q.split(' ').filter((w) => w.length > 2);
  if (!words.length) return false;
  const present = words.filter((w) => p.includes(w)).length;
  return present / words.length >= 0.8;
}

/** Places untrusted text inside a delimited block the model is told to treat as data. */
export function fence(tag: string, text: string, max = 12_000): string {
  const safe = text.slice(0, max).replace(new RegExp(`</?\\s*${tag}\\s*>`, 'gi'), '[removed tag]');
  return `<${tag}>\n${safe}\n</${tag}>`;
}

import { escapeRegExp } from '../util';
import { SKILLS, findSkillDef, type SkillDef } from './taxonomy';

export interface SkillMatcher {
  name: string;
  def?: SkillDef;
  patterns: RegExp[];
}

const BEFORE = '(?<![A-Za-z0-9+#])';
const AFTER = '(?![A-Za-z0-9+#]|\\.[A-Za-z0-9])';
// Case-sensitive short aliases ("Go", "R", "TS") must not be part of "R&D", "TS/SCI", "Go-to-market"…
const EXACT_AFTER = `${AFTER}(?![&'’-])`;
const EXACT_GUARDS: Record<string, string> = {
  Go: '(?!\\s+(?:to|ahead|above|beyond|live|back|forward|through|deep|far|over|out)\\b)',
  TS: '(?!\\/?\\s*SCI)',
  Excel: '(?!\\s+(?:at|in)\\b)',
};

/** Canonical names that are also everyday English words; only their aliases are matched. */
const AMBIGUOUS_NAMES = new Set(['linear', 'sketch', 'sales', 'excel', 'assembly', 'swift', 'unity']);

function aliasPattern(alias: string, caseSensitive: boolean): RegExp {
  const body = escapeRegExp(alias).replace(/ /g, '[\\s-]+');
  const after = caseSensitive ? EXACT_AFTER + (EXACT_GUARDS[alias] ?? '') : AFTER;
  return new RegExp(`${BEFORE}${body}${after}`, caseSensitive ? 'g' : 'gi');
}

function compile(def: SkillDef): SkillMatcher {
  const aliases = new Set([def.name.toLowerCase(), ...(def.aliases ?? [])]);
  // A one-letter canonical name ("R", "C") is far too ambiguous as a case-insensitive alias.
  if (def.name.length <= 2 && !/[+#.]/.test(def.name)) aliases.delete(def.name.toLowerCase());
  if (AMBIGUOUS_NAMES.has(def.name.toLowerCase())) aliases.delete(def.name.toLowerCase());
  const patterns = [...aliases].map((a) => aliasPattern(a, false));
  for (const e of def.exact ?? []) patterns.push(aliasPattern(e, true));
  return { name: def.name, def, patterns };
}

let baseMatchers: SkillMatcher[] | null = null;
export function getBaseMatchers(): SkillMatcher[] {
  baseMatchers ??= SKILLS.map(compile);
  return baseMatchers;
}

/** Matchers for user-declared skills that are not part of the taxonomy. */
export function customMatchers(skills: string[]): SkillMatcher[] {
  const out: SkillMatcher[] = [];
  const seen = new Set<string>();
  for (const raw of skills) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name.length < 2 || name.length > 60 || seen.has(key) || findSkillDef(name)) continue;
    seen.add(key);
    out.push({ name, patterns: [aliasPattern(name, false)] });
  }
  return out;
}

/** Maps any skill string (canonical or alias) to its canonical display name. */
export function canonicalSkill(name: string): string {
  return findSkillDef(name)?.name ?? name.trim();
}

function prepare(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/ /g, ' ');
}

export function containsSkill(text: string, matcher: SkillMatcher): boolean {
  const t = prepare(text);
  return matcher.patterns.some((re) => {
    re.lastIndex = 0;
    return re.test(t);
  });
}

/** Returns canonical skill names mentioned in `text`, in order of first appearance. */
export function extractSkills(text: string, matchers: SkillMatcher[] = getBaseMatchers()): string[] {
  if (!text) return [];
  const t = prepare(text);
  const found: Array<{ name: string; at: number }> = [];
  for (const m of matchers) {
    let first = Infinity;
    for (const re of m.patterns) {
      re.lastIndex = 0;
      const hit = re.exec(t);
      if (hit && hit.index < first) first = hit.index;
    }
    if (first !== Infinity) found.push({ name: m.name, at: first });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.name);
}

export function familyOf(skill: string): string | undefined {
  return findSkillDef(skill)?.family;
}

import { COUNTRIES, countryVariants, findCountry, findRegion, parseLocation, regionVariants } from '../../geo';
import { bareUrl, containsWords, coverage, digitsOf, normalize, plain } from './text';

/**
 * Profile matching: which values to offer a field, and how strictly an
 * option on the page has to agree with the answer before it is chosen.
 * Options are matched exactly, through known synonyms (countries,
 * provinces / states, degree levels, yes / no, "decline to answer", gender
 * words) or as whole words. Never by substring: "Java" doesn't pick
 * "JavaScript" and "Male" doesn't pick "Female".
 */

export const MIN_OPTION_SCORE = 0.6;
/** Two options this close are a tie: the user picks. */
const TIE = 0.05;

const YES = /^(yes|y|true|i (am|do|have|will|can)\b)/;
const NO = /^(no|n|false|i (am|do|have|will|can) not|i don't|i'm not)\b/;
const DECLINE = /decline|prefer not|don't wish|do not wish|not (wish )?to (say|answer|disclose|self ?identify)|rather not/;

const GENDER: Array<[string, RegExp]> = [
  ['male', /^(male|man|cis ?gender (male|man)|cis ?(male|man))$/],
  ['female', /^(female|woman|cis ?gender (female|woman)|cis ?(female|woman))$/],
  ['nonbinary', /^(non ?binary|gender ?queer|gender non ?conforming|non ?binary gender ?queer)$/],
];

const DEGREE_LEVELS: Array<[string, RegExp]> = [
  ['doctorate', /\b(ph ?d|doctor(ate|al)?|d ?phil|ed ?d)\b/],
  ['master', /\b(master'?s?|m ?sc|m ?eng|mba|m ?a|m ?s|m ?ed|graduate degree|postgraduate)\b/],
  ['bachelor', /\b(bachelor'?s?|b ?sc|b ?eng|b ?a|b ?s|b ?tech|b ?comm?|bba|undergraduate degree|baccalaureate)\b/],
  ['associate', /\b(associate'?s?)( degree)?\b/],
  ['diploma', /\b(advanced diploma|college diploma|diploma|certificate program)\b/],
  ['highschool', /\b(high school|secondary school|ged)\b/],
];
const DEGREE_FILLER = /\b(degree|level|of|or|equivalent|the|program|'?s)\b/g;

/** The degree level a text names, and whether it names only the level ("Bachelor's Degree", not "Bachelor of Arts"). */
export function degreeLevel(text: string): { level: string; generic: boolean } | null {
  const t = normalize(text);
  for (const [level, re] of DEGREE_LEVELS) {
    const m = re.exec(t);
    if (!m) continue;
    const rest = t.replace(re, ' ').replace(DEGREE_FILLER, ' ').replace(/\s+/g, ' ').trim();
    return { level, generic: !rest };
  }
  return null;
}

function stripDial(text: string): string {
  return text.replace(/\(?\+\s?\d[\d\s-]*\)?/g, ' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A canonical meaning for short answers that are written many ways. */
function concept(text: string): string | null {
  const n = normalize(text);
  for (const [k, re] of GENDER) if (re.test(n)) return `gender:${k}`;
  const raw = stripDial(text);
  const region = findRegion(raw);
  if (region) return `region:${region.country}-${region.code}`;
  const country = findCountry(raw) ?? findCountry(n.replace(/\b(the)\b/g, '').trim(), false);
  if (country) return `country:${country.code}`;
  return null;
}

/** How well an option's text matches the wanted answer (0…1). */
export function optionScore(optionText: string, wanted: string, opts: { place?: boolean } = {}): number {
  const t = plain(optionText);
  const v = plain(wanted);
  if (!t || !v) return 0;
  if (t === v) return 1;
  if (DECLINE.test(v)) return DECLINE.test(t) ? 0.95 : 0;
  if (YES.test(v) && !NO.test(v)) return YES.test(t) && !NO.test(t) ? 0.9 : 0;
  if (NO.test(v)) return NO.test(t) ? 0.9 : 0;
  if (YES.test(t) || NO.test(t) || DECLINE.test(t)) return 0;
  const ct = concept(optionText);
  const cv = concept(wanted);
  if (ct && cv) return ct === cv ? 0.9 : 0;
  const dt = degreeLevel(optionText);
  const dv = degreeLevel(wanted);
  if (dt && dv && dt.level === dv.level && dt.generic) return 0.85;
  if (opts.place) {
    const p = placeScore(optionText, wanted);
    if (p !== null) return p;
  }
  // An option holding the whole answer as words ("Canada" in "Canada (+1)").
  if (containsWords(t, v)) return 0.6 + 0.3 * coverage(t, v);
  // The answer holding the whole option ("Ottawa" for "Ottawa, Ontario"): only when the option is most of it.
  if (containsWords(v, t)) return 0.45 + 0.3 * coverage(v, t);
  return 0;
}

/** City, then province / state, then country: an option naming another place scores 0. */
function placeScore(optionText: string, wanted: string): number | null {
  const a = parseLocation(optionText);
  const b = parseLocation(wanted);
  if (!a.city || !b.city || normalize(a.city) !== normalize(b.city)) return a.city && b.city ? 0 : null;
  if (a.regionCode && b.regionCode && a.regionCode !== b.regionCode) return 0;
  if (a.countryCode && b.countryCode && a.countryCode !== b.countryCode) return 0;
  let s = 0.75;
  if (a.regionCode && a.regionCode === b.regionCode) s += 0.1;
  if (a.countryCode && a.countryCode === b.countryCode) s += 0.1;
  return s;
}

export type Pick<T> = { item: T; score: number } | { ambiguous: T[] } | null;

/**
 * The option that answers `wanted`, if exactly one clearly does. Two options
 * scoring about the same is a tie: the user is asked instead of guessing.
 */
export function pickOption<T>(items: T[], text: (t: T) => string, wanted: string, opts: { place?: boolean } = {}): Pick<T> {
  const scored = items
    .map((item) => ({ item, score: optionScore(text(item), wanted, opts) }))
    .filter((s) => s.score >= MIN_OPTION_SCORE)
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best) return null;
  if (second && best.score < 1 && best.score - second.score < TIE && normalize(text(best.item)) !== normalize(text(second.item))) {
    return { ambiguous: scored.filter((s) => best.score - s.score < TIE).map((s) => s.item) };
  }
  return best;
}

/** Degree strings forms tend to offer for a degree on the résumé ("BSc" → "Bachelor's Degree"). */
export function degreeValues(degree: string): string[] {
  const out = [degree];
  const level = degreeLevel(degree)?.level;
  const extra: Record<string, string[]> = {
    bachelor: ["Bachelor's Degree", 'Bachelor', "Bachelor's"],
    master: ["Master's Degree", 'Master', "Master's"],
    doctorate: ['Doctorate', 'PhD', 'Doctoral Degree'],
    associate: ["Associate's Degree", 'Associate'],
    diploma: ['Diploma', 'College Diploma'],
    highschool: ['High School Diploma', 'High School'],
  };
  if (level) out.push(...(extra[level] ?? []));
  return [...new Set(out)];
}

/** "2026-01-15", "Jan 2026", "01/2026", "2026" → ISO date / month for date inputs. Null when not a date. */
export function toIsoDate(value: string, type: 'date' | 'month'): string | null {
  const v = value.trim().toLowerCase();
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  let y: number | null = null;
  let m = 1;
  let d = 1;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(v))) [y, m, d] = [Number(r[1]), Number(r[2]), r[3] ? Number(r[3]) : 1];
  else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v))) [y, m, d] = [Number(r[3]), Number(r[1]), Number(r[2])];
  else if ((r = /^(\d{1,2})\/(\d{4})$/.exec(v))) [y, m] = [Number(r[2]), Number(r[1])];
  else if ((r = /^([a-z]{3})[a-z]*\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/.exec(v)) && MONTHS.includes(r[1]!)) [y, m, d] = [Number(r[3]), MONTHS.indexOf(r[1]!) + 1, r[2] ? Number(r[2]) : 1];
  else if ((r = /^(\d{4})$/.exec(v))) y = Number(r[1]);
  if (y === null || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const mm = String(m).padStart(2, '0');
  return type === 'month' ? `${y}-${mm}` : `${y}-${mm}-${String(d).padStart(2, '0')}`;
}

/** A date typed the way a text field's placeholder shows it ("MM/DD/YYYY", "DD/MM/YYYY", "MM/YYYY", "YYYY-MM-DD"). */
export function formatForPlaceholder(value: string, placeholder: string): string | null {
  const iso = toIsoDate(value, 'date');
  if (!iso) return null;
  const [y, m, d] = iso.split('-') as [string, string, string];
  const p = placeholder.trim().toLowerCase();
  if (/^mm\s*\/\s*dd\s*\/\s*yyyy$/.test(p)) return `${m}/${d}/${y}`;
  if (/^dd\s*\/\s*mm\s*\/\s*yyyy$/.test(p)) return `${d}/${m}/${y}`;
  if (/^mm\s*\/\s*yyyy$/.test(p)) return `${m}/${y}`;
  if (/^yyyy-mm-dd$/.test(p)) return iso;
  if (/^mm-dd-yyyy$/.test(p)) return `${m}-${d}-${y}`;
  return null;
}

/** "+1 (613) 555-0100" → "(613) 555-0100". Numbers whose country code can't be told apart are left as typed. */
export function nationalNumber(phone: string): string {
  const p = phone.trim();
  const sep = /^(?:\+|00)\d{1,3}[\s.\-]+(?=\(?\d)/.exec(p);
  if (sep) return p.slice(sep[0].length).trim();
  // "+16135550100": only North American numbers (+1 and ten digits) are unambiguous without a separator.
  const digits = p.replace(/\D/g, '');
  if (/^\+1/.test(p) && digits.length === 11 && /^\+?1[\d\s().-]*$/.test(p)) return digits.slice(1);
  return p;
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

/** Values worth trying for a location field, most complete first. */
export function locationValues(location: string, state = '', country = ''): string[] {
  const p = parseLocation(location);
  const region = findRegion(state || p.region || p.regionCode);
  const nation = findCountry(country || p.country || p.countryCode) ?? (region ? findCountry(region.country) : undefined);
  const city = p.city;
  return uniq([
    location,
    city && region && nation ? `${city}, ${region.name}, ${nation.name}` : '',
    city && region ? `${city}, ${region.code}` : '',
    city && region ? `${city}, ${region.name}` : '',
    city && nation && !region ? `${city}, ${nation.name}` : '',
  ]);
}

export const stateValues = (state: string) => uniq(regionVariants(state));
export const countryValues = (country: string) => uniq(countryVariants(country));

/**
 * Values for a phone country-code field. The code comes from the number
 * itself ("+44 20…"), else from the country the applicant lives in. A
 * picker gets "Canada (+1)", "Canada" or "+1"; a plain text box just "+1".
 */
export function phoneCodeValues(country: string, phone: string, picker: boolean): string[] {
  const home = findCountry(country);
  const p = phone.trim();
  const dial = /^(?:\+|00)(\d{1,3})[\s.\-(]/.exec(p)?.[1] ?? (/^\+1\d{10}$/.test(p.replace(/[\s().-]/g, '')) ? '1' : undefined);
  let c = home;
  if (dial && (!home || home.dial !== dial)) {
    const all = COUNTRIES.filter((x) => x.dial === dial);
    c = all.length === 1 ? all[0] : undefined;
    if (!c) return picker ? [] : [`+${dial}`];
  }
  if (!c) return [];
  return picker ? uniq([`${c.name} (+${c.dial})`, c.name, `+${c.dial}`]) : [`+${c.dial}`];
}

/** As many items as fit in `max` characters, comma-separated. */
export function joinFit(items: string[], max = Infinity): string {
  let out = '';
  for (const s of items) {
    const next = out ? `${out}, ${s}` : s;
    if (next.length > max) break;
    out = next;
  }
  return out;
}

/** Whether a text field holds the value that was written, allowing for the formatting fields apply. */
export function sameText(shown: string, wanted: string): boolean {
  if (shown === wanted) return true;
  const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (collapse(shown) === collapse(wanted)) return true;
  if (normalize(shown) === normalize(wanted) && normalize(wanted)) return true;
  // Masks reformat numbers: "(613) 555-0100" for "6135550100"; a national box drops the "+1".
  const dw = digitsOf(wanted);
  const ds = digitsOf(shown);
  if (dw.length >= 7 && wanted.replace(/[\d\s()+.\-]/g, '') === '' && ds.length >= 7 && (ds === dw || dw.endsWith(ds) || ds.endsWith(dw))) return true;
  if (/^(https?:\/\/|www\.)|\.[a-z]{2,}\//i.test(wanted) && bareUrl(shown) === bareUrl(wanted)) return true;
  const a = toIsoDate(shown, 'date');
  return !!a && a === toIsoDate(wanted, 'date');
}

import { parseLocation } from '../geo';
import { monthIndex } from '../matching/analysis';
import { Basics, type Education, type Experience, type Profile, type Project, type ResumeContent, type ResumeVersion } from '../types';
import { uid } from '../util';
import { linkKey, linkKind, normalizeEmail, phoneDigits, skillKey, textKey, uniqueBy, type LinkKind } from './normalize';

/**
 * Profile merge and conflict resolver. `planImport` compares a newly parsed
 * résumé with the profile and proposes, for every field and entry, whether it
 * is new, already there, an update or a conflict. The review screen lets the
 * user change any decision; `applyImport` then builds the new profile.
 *
 * Existing information is never overwritten unless the user picks the new
 * value: conflicts default to keeping what the profile already has.
 */

export type BasicsField = 'name' | 'headline' | 'email' | 'phone' | 'location' | 'summary';
export const BASICS_FIELDS: BasicsField[] = ['name', 'headline', 'email', 'phone', 'location', 'summary'];

export interface FieldChoice {
  field: BasicsField;
  current: string;
  incoming: string;
  /** new: the profile had nothing; same: equal once normalised; conflict: both set and different; kept: not in the résumé. */
  status: 'new' | 'same' | 'conflict' | 'kept' | 'none';
  take: 'current' | 'incoming';
}

export interface LinkChoice {
  url: string;
  kind: LinkKind;
  status: 'new' | 'same' | 'conflict';
  /** For a conflict: the profile's link of the same kind (e.g. another LinkedIn URL). */
  replaces?: string;
  include: boolean;
}

export interface EntryConflict {
  field: string;
  label: string;
  current: string;
  incoming: string;
  take: 'current' | 'incoming';
}

export type EntryKind = 'experience' | 'education' | 'projects';
export type Entry = Experience | Education | Project;

export interface EntryPlan<T extends Entry = Entry> {
  /** The entry as read from the new résumé (editable during review). */
  incoming: T;
  /** The profile entry it is the same as. */
  existingId?: string;
  /** A profile entry that looks the same but has other dates: maybe a duplicate, maybe a separate term. */
  similarId?: string;
  status: 'new' | 'duplicate' | 'update' | 'conflict';
  /** What merging would add ("2 new bullets", "location"). */
  adds: string[];
  conflicts: EntryConflict[];
  /** add: as a new entry; merge: into `existingId`; skip: leave it out. */
  action: 'add' | 'merge' | 'skip';
}

export type ListKind = 'skills' | 'certifications' | 'languages' | 'awards';
export const LIST_KINDS: ListKind[] = ['skills', 'certifications', 'languages', 'awards'];

export interface ListItemChoice {
  value: string;
  include: boolean;
}

export interface ListPlan {
  added: ListItemChoice[];
  /** Items the profile already has (nothing to do). */
  alreadyHave: string[];
}

export interface ImportPlan {
  basics: FieldChoice[];
  links: LinkChoice[];
  experience: EntryPlan<Experience>[];
  education: EntryPlan<Education>[];
  projects: EntryPlan<Project>[];
  lists: Record<ListKind, ListPlan>;
  /** Skills the roles and projects mention but the skills list doesn't: offered, off by default. */
  mentionedSkills: ListItemChoice[];
  extras: Array<{ heading: string; items: ListItemChoice[] }>;
}

/* ----------------------------------------------------------------------------
 * Similarity
 * ------------------------------------------------------------------------- */

const LEGAL_RE = /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|co|company|gmbh|plc|sa|sarl|srl|pty|ag|the)\b/g;
export const companyKey = (s: string): string => textKey(s).replace(LEGAL_RE, ' ').replace(/\s+/g, ' ').trim();
const institutionKey = (s: string): string => textKey(s).replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();

const TITLE_ALIASES: Array<[RegExp, string]> = [
  [/\bsr\b/g, 'senior'],
  [/\bjr\b/g, 'junior'],
  [/\beng\b/g, 'engineer'],
  [/\bdev\b/g, 'developer'],
  [/\b(swe|sde)\b/g, 'software engineer'],
  [/\bmgr\b/g, 'manager'],
  [/\bco op\b|\bcoop\b/g, 'coop'],
  [/\binternship\b/g, 'intern'],
];

function words(s: string): Set<string> {
  let t = textKey(s);
  for (const [re, r] of TITLE_ALIASES) t = t.replace(re, r);
  return new Set(t.split(' ').filter((w) => w.length > 1 || /\d/.test(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
}

/** 1 for the same name, 0.85 when one contains the other ("Initech" / "Initech Canada"), else word overlap. */
function nameSim(a: string, b: string, key: (s: string) => string = textKey): number {
  const ka = key(a);
  const kb = key(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (` ${ka} `.includes(` ${kb} `) || ` ${kb} `.includes(` ${ka} `)) return 0.85;
  return jaccard(new Set(ka.split(' ')), new Set(kb.split(' ')));
}

const titleSim = (a: string, b: string) => (textKey(a) && textKey(a) === textKey(b) ? 1 : jaccard(words(a), words(b)));

function span(start: string, end: string): [number, number] | null {
  const s = monthIndex(start);
  if (s === null) return null;
  const e = !end ? s + (start.length === 4 ? 11 : 0) : (monthIndex(end) ?? s);
  return [s, Math.max(s, e + (end.length === 4 ? 11 : 0))];
}

/** 1: same start, 0.6: overlapping periods, 0: unknown, -1: separate periods. */
function dateRelation(a: { start: string; end: string }, b: { start: string; end: string }): number {
  const sa = a.start || a.end;
  const sb = b.start || b.end;
  if (!sa || !sb) return 0;
  if (a.start && b.start && (a.start === b.start || ((a.start.length === 4 || b.start.length === 4) && a.start.slice(0, 4) === b.start.slice(0, 4)))) return 1;
  const x = span(a.start || a.end, a.end);
  const y = span(b.start || b.end, b.end);
  if (!x || !y) return 0;
  return x[0] <= y[1] && y[0] <= x[1] ? 0.6 : -1;
}

type Match = { score: number } | 'similar' | null;

function experienceMatch(a: Experience, b: Experience): Match {
  const c = a.company && b.company ? nameSim(a.company, b.company, companyKey) : 0.4;
  const t = titleSim(a.title, b.title);
  const d = dateRelation(a, b);
  if (d === -1) return c >= 0.85 && t >= 0.8 ? 'similar' : null;
  const ok = (c >= 0.85 && (t >= 0.5 || d === 1 || (d > 0 && t >= 0.25))) || (c >= 0.5 && c < 0.85 && t >= 0.8 && (d > 0 || t === 1)) || (c === 0.4 && t >= 0.8 && d === 1);
  return ok ? { score: c + t + Math.max(d, 0) } : null;
}

const DEGREE_LEVELS: Array<[RegExp, string]> = [
  [/\b(ph\.?\s?d|doctor(ate)?)\b/i, 'doctorate'],
  [/\b(master'?s?|m\.?\s?sc|m\.?\s?eng|mba|m\.?a\b|m\.?s\b|meng|msc)\b/i, 'master'],
  [/\b(bachelor'?s?|b\.?\s?sc|b\.?\s?eng|b\.?a\b|b\.?s\b|bcs|bba|bcomm?|beng|bsc|b\.?\s?tech|undergraduate)\b/i, 'bachelor'],
  [/\bassociate'?s?\b/i, 'associate'],
  [/\b(advanced diploma|diploma|dec|aec|technology)\b/i, 'diploma'],
  [/\b(certificate|certification)\b/i, 'certificate'],
  [/\b(high school|secondary|ged)\b/i, 'secondary'],
];

/** The level of a degree ("B.Sc. Computer Science" → "bachelor"), or "" when unclear. */
export function degreeLevel(degree: string): string {
  for (const [re, level] of DEGREE_LEVELS) if (re.test(degree)) return level;
  return '';
}

const DEGREE_CODES: Array<[RegExp, string]> = [
  [/^(bachelor'?s?( degree)? of science|b\.?\s?sc\.?|b\.?s\.?|bsc)$/i, 'bsc'],
  [/^(bachelor'?s?( degree)? of arts|b\.?a\.?)$/i, 'ba'],
  [/^(bachelor'?s?( degree)? of engineering|b\.?\s?eng\.?|beng)$/i, 'beng'],
  [/^(bachelor'?s?( degree)? of applied science|b\.?a\.?\s?sc\.?|basc)$/i, 'basc'],
  [/^(bachelor'?s?( degree)? of computer science|bcs)$/i, 'bcs'],
  [/^(bachelor'?s?( degree)? of commerce|b\.?\s?comm?\.?)$/i, 'bcom'],
  [/^(bachelor'?s?( degree)? of business administration|bba)$/i, 'bba'],
  [/^(master'?s?( degree)? of science|m\.?\s?sc\.?|m\.?s\.?|msc)$/i, 'msc'],
  [/^(master'?s?( degree)? of arts|m\.?a\.?)$/i, 'ma'],
  [/^(master'?s?( degree)? of engineering|m\.?\s?eng\.?|meng)$/i, 'meng'],
  [/^(master'?s?( degree)? of business administration|mba)$/i, 'mba'],
  [/^(doctor of philosophy|ph\.?\s?d\.?|doctorate)$/i, 'phd'],
];

/** "B.Sc." and "Bachelor of Science" are the same degree; "" when the wording is unknown. */
export function degreeCode(degree: string): string {
  const d = degree.trim();
  for (const [re, code] of DEGREE_CODES) if (re.test(d)) return code;
  return '';
}

function sameDegree(a: string, b: string): boolean {
  const x = degreeCode(a);
  const y = degreeCode(b);
  if (x && y) return x === y;
  return titleSim(a, b) === 1;
}

function educationMatch(a: Education, b: Education): Match {
  const i = a.institution && b.institution ? nameSim(a.institution, b.institution, institutionKey) : 0;
  const la = degreeLevel(a.degree);
  const lb = degreeLevel(b.degree);
  const sameLevel = !la || !lb || la === lb;
  const dg = a.degree && b.degree ? (sameDegree(a.degree, b.degree) ? 1 : titleSim(a.degree, b.degree)) : 0.5;
  const d = dateRelation(a, b);
  if (i >= 0.85 && sameLevel) {
    if (d === -1) return dg >= 0.8 ? 'similar' : null;
    return { score: i + dg + Math.max(d, 0) };
  }
  // School missing on one side: same degree and dates.
  if ((!a.institution || !b.institution) && dg >= 0.8 && d === 1) return { score: dg + d };
  return null;
}

function projectMatch(a: Project, b: Project): Match {
  if (a.url && b.url && linkKey(a.url) === linkKey(b.url)) return { score: 3 };
  const n = nameSim(a.name, b.name);
  return n >= 0.8 ? { score: n } : null;
}

/** Pairs each incoming entry with at most one profile entry, best matches first. */
function pairUp<T extends Entry>(incoming: T[], existing: T[], match: (a: T, b: T) => Match): Map<string, { existingId?: string; similarId?: string }> {
  const pairs: Array<{ a: string; b: string; score: number }> = [];
  const similar = new Map<string, string>();
  for (const a of incoming)
    for (const b of existing) {
      const m = match(a, b);
      if (m === 'similar') {
        if (!similar.has(a.id)) similar.set(a.id, b.id);
      } else if (m) pairs.push({ a: a.id, b: b.id, score: m.score });
    }
  pairs.sort((x, y) => y.score - x.score);
  const out = new Map<string, { existingId?: string; similarId?: string }>();
  const taken = new Set<string>();
  for (const p of pairs) {
    if (out.has(p.a) || taken.has(p.b)) continue;
    out.set(p.a, { existingId: p.b });
    taken.add(p.b);
  }
  for (const a of incoming) if (!out.has(a.id) && similar.has(a.id)) out.set(a.id, { similarId: similar.get(a.id) });
  return out;
}

/* ----------------------------------------------------------------------------
 * Comparing two entries
 * ------------------------------------------------------------------------- */

const FIELDS: Record<EntryKind, Array<[string, string]>> = {
  experience: [
    ['title', 'Job title'],
    ['company', 'Company'],
    ['location', 'Location'],
    ['start', 'Start date'],
    ['end', 'End date'],
    ['employmentType', 'Employment type'],
  ],
  education: [
    ['institution', 'School'],
    ['degree', 'Degree'],
    ['field', 'Field of study'],
    ['start', 'Start date'],
    ['end', 'End date'],
  ],
  projects: [
    ['name', 'Name'],
    ['description', 'Description'],
    ['url', 'Link'],
    ['kind', 'Type'],
    ['start', 'Start date'],
    ['end', 'End date'],
  ],
};

const LIST_FIELDS: Record<EntryKind, Array<[string, string, (s: string) => string]>> = {
  experience: [
    ['bullets', 'bullet', textKey],
    ['skills', 'technology', skillKey],
  ],
  education: [
    ['details', 'detail', textKey],
    ['coursework', 'course', textKey],
  ],
  projects: [
    ['bullets', 'bullet', textKey],
    ['skills', 'technology', skillKey],
  ],
};

const isDate = (f: string) => f === 'start' || f === 'end';
const get = (e: Entry, f: string): unknown => (e as unknown as Record<string, unknown>)[f];
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);

function sameValue(kind: EntryKind, field: string, a: string, b: string): boolean {
  if (isDate(field)) return a === b || (a.length !== b.length && (a.startsWith(b) || b.startsWith(a)));
  if (field === 'company') return companyKey(a) === companyKey(b);
  if (field === 'institution') return institutionKey(a) === institutionKey(b);
  if (field === 'url') return linkKey(a) === linkKey(b);
  if (kind === 'education' && field === 'degree') return sameDegree(a, b);
  if (field === 'title') return titleSim(a, b) === 1;
  return textKey(a) === textKey(b);
}

/** A bullet reworded only slightly is the same bullet (the profile's wording is kept). */
function sameBullet(a: string, b: string): boolean {
  return textKey(a) === textKey(b) || jaccard(new Set(textKey(a).split(' ')), new Set(textKey(b).split(' '))) >= 0.85;
}

/** What `incoming` adds to `existing` and where they disagree. */
export function compareEntry(kind: EntryKind, existing: Entry, incoming: Entry): { adds: string[]; conflicts: EntryConflict[] } {
  const adds: string[] = [];
  const conflicts: EntryConflict[] = [];
  for (const [f, label] of FIELDS[kind]) {
    const cur = str(get(existing, f));
    const inc = str(get(incoming, f));
    if (!inc) continue;
    if (!cur) adds.push(label.toLowerCase());
    else if (sameValue(kind, f, cur, inc)) {
      if (isDate(f) && inc.length > cur.length) adds.push(`exact ${label.toLowerCase()}`);
    } else if (f !== 'employmentType' && f !== 'kind') conflicts.push({ field: f, label, current: cur, incoming: inc, take: 'current' });
  }
  for (const [f, label, key] of LIST_FIELDS[kind]) {
    const cur = arr(get(existing, f));
    const fresh = arr(get(incoming, f)).filter((x) => !cur.some((y) => (f === 'bullets' ? sameBullet(x, y) : key(x) === key(y))));
    if (fresh.length) adds.push(`${fresh.length} new ${fresh.length === 1 ? label : label === 'technology' ? 'technologies' : `${label}s`}`);
  }
  return { adds, conflicts };
}

function planEntries<T extends Entry>(kind: EntryKind, current: T[], incoming: T[], match: (a: T, b: T) => Match): EntryPlan<T>[] {
  const pairs = pairUp(incoming, current, match);
  return incoming.map((inc) => {
    const p = pairs.get(inc.id);
    const existing = p?.existingId ? current.find((x) => x.id === p.existingId) : undefined;
    if (!existing) return { incoming: inc, similarId: p?.similarId, status: 'new', adds: [], conflicts: [], action: 'add' };
    const { adds, conflicts } = compareEntry(kind, existing, inc);
    return { incoming: inc, existingId: existing.id, status: conflicts.length ? 'conflict' : adds.length ? 'update' : 'duplicate', adds, conflicts, action: 'merge' };
  });
}

/** Re-checks one entry after the user edited it during review (keeps their conflict choices where still relevant). */
export function replanEntry<T extends Entry>(kind: EntryKind, plan: EntryPlan<T>, current: T[]): EntryPlan<T> {
  const existing = plan.existingId ? current.find((x) => x.id === plan.existingId) : undefined;
  if (!existing) return plan;
  const { adds, conflicts } = compareEntry(kind, existing, plan.incoming);
  for (const c of conflicts) c.take = plan.conflicts.find((x) => x.field === c.field && x.incoming === c.incoming)?.take ?? 'current';
  return { ...plan, adds, conflicts, status: conflicts.length ? 'conflict' : adds.length ? 'update' : 'duplicate' };
}

/* ----------------------------------------------------------------------------
 * Planning
 * ------------------------------------------------------------------------- */

function sameBasics(field: BasicsField, a: string, b: string): boolean {
  if (field === 'email') return normalizeEmail(a) === normalizeEmail(b);
  if (field === 'phone') {
    const x = phoneDigits(a);
    const y = phoneDigits(b);
    return x === y || (Math.min(x.length, y.length) >= 8 && (x.endsWith(y) || y.endsWith(x)));
  }
  if (field === 'location') {
    const x = parseLocation(a);
    const y = parseLocation(b);
    if (x.city && y.city && textKey(x.city) === textKey(y.city)) return !x.regionCode || !y.regionCode || x.regionCode === y.regionCode;
  }
  return textKey(a) === textKey(b);
}

const listKey = (kind: ListKind) => (kind === 'skills' ? skillKey : textKey);

const EMPTY: ResumeContent = { basics: Basics.parse({}), skills: [], experience: [], education: [], projects: [], certifications: [] };

/** Compares a parsed résumé with the profile. With no profile (or `replace`), everything is new. */
export function planImport(current: ResumeContent | null, incoming: ResumeContent): ImportPlan {
  const cur = current ?? EMPTY;
  const basics = BASICS_FIELDS.map((field): FieldChoice => {
    const c = cur.basics[field] ?? '';
    const i = incoming.basics[field] ?? '';
    const status: FieldChoice['status'] = !i ? (c ? 'kept' : 'none') : !c ? 'new' : sameBasics(field, c, i) ? 'same' : 'conflict';
    return { field, current: c, incoming: i, status, take: status === 'new' ? 'incoming' : 'current' };
  });

  const curLinks = cur.basics.links;
  const links = uniqueBy(incoming.basics.links, linkKey).map((url): LinkChoice => {
    const kind = linkKind(url);
    if (curLinks.some((l) => linkKey(l) === linkKey(url))) return { url, kind, status: 'same', include: false };
    const sameKind = kind === 'portfolio' ? undefined : curLinks.find((l) => linkKind(l) === kind);
    return sameKind ? { url, kind, status: 'conflict', replaces: sameKind, include: false } : { url, kind, status: 'new', include: true };
  });

  const lists = Object.fromEntries(
    LIST_KINDS.map((kind): [ListKind, ListPlan] => {
      const key = listKey(kind);
      const have = new Set((cur[kind] ?? []).map(key));
      const items = incoming[kind] ?? [];
      return [kind, { added: uniqueBy(items.filter((x) => !have.has(key(x))), key).map((value) => ({ value, include: true })), alreadyHave: items.filter((x) => have.has(key(x))) }];
    }),
  ) as Record<ListKind, ListPlan>;

  const knownSkills = new Set([...cur.skills, ...incoming.skills].map(skillKey));
  const mentioned = uniqueBy(
    [...incoming.experience.flatMap((e) => e.skills ?? []), ...incoming.projects.flatMap((p) => p.skills)].filter((s) => !knownSkills.has(skillKey(s))),
    skillKey,
  ).map((value) => ({ value, include: false }));

  const extras = (incoming.extras ?? []).map((x) => {
    const mine = (cur.extras ?? []).find((y) => textKey(y.heading) === textKey(x.heading));
    return { heading: x.heading, items: x.items.filter((i) => !mine?.items.some((m) => textKey(m) === textKey(i))).map((value) => ({ value, include: true })) };
  }).filter((x) => x.items.length);

  return {
    basics,
    links,
    experience: planEntries('experience', cur.experience, incoming.experience, experienceMatch),
    education: planEntries('education', cur.education, incoming.education, educationMatch),
    projects: planEntries('projects', cur.projects, incoming.projects, projectMatch),
    lists,
    mentionedSkills: mentioned,
    extras,
  };
}

/** Counts for the review summary and the save button. */
export function planCounts(plan: ImportPlan): { added: number; merged: number; conflicts: number; unchanged: number; possibleDuplicates: number } {
  const entries = [...plan.experience, ...plan.education, ...plan.projects] as EntryPlan[];
  const items = LIST_KINDS.reduce((n, k) => n + plan.lists[k].added.filter((i) => i.include).length, 0) + plan.mentionedSkills.filter((i) => i.include).length;
  return {
    added:
      entries.filter((e) => e.action === 'add').length +
      items +
      plan.basics.filter((b) => b.take === 'incoming' && b.incoming && b.status !== 'same').length +
      plan.links.filter((l) => l.include && l.status !== 'same').length +
      plan.extras.reduce((n, x) => n + x.items.filter((i) => i.include).length, 0),
    merged: entries.filter((e) => e.action === 'merge' && e.status !== 'duplicate').length,
    conflicts: plan.basics.filter((b) => b.status === 'conflict').length + plan.links.filter((l) => l.status === 'conflict').length + entries.filter((e) => e.action === 'merge').reduce((n, e) => n + e.conflicts.length, 0),
    unchanged: entries.filter((e) => e.status === 'duplicate' && e.action !== 'add').length,
    possibleDuplicates: entries.filter((e) => e.similarId && e.action === 'add').length,
  };
}

/* ----------------------------------------------------------------------------
 * Applying
 * ------------------------------------------------------------------------- */

function recency(e: Entry): number {
  if (e.end === 'present') return Number.MAX_SAFE_INTEGER;
  return monthIndex(e.end) ?? monthIndex(e.start) ?? -1;
}

/** Inserts a new entry among the existing ones by date (newest first), without reordering them. */
function insertByDate<T extends Entry>(list: T[], entry: T): T[] {
  const r = recency(entry);
  if (r < 0) return [...list, entry];
  const at = list.findIndex((x) => recency(x) >= 0 && recency(x) < r);
  return at < 0 ? [...list, entry] : [...list.slice(0, at), entry, ...list.slice(at)];
}

function mergeEntry<T extends Entry>(kind: EntryKind, existing: T, incoming: T, conflicts: EntryConflict[]): T {
  const out = { ...existing } as Record<string, unknown>;
  for (const [f] of FIELDS[kind]) {
    const cur = str(get(existing, f));
    const inc = str(get(incoming, f));
    const conflict = conflicts.find((c) => c.field === f);
    if (conflict) out[f] = conflict.take === 'incoming' ? inc : cur;
    else if (!cur && inc) out[f] = inc;
    else if (isDate(f) && inc.length > cur.length && inc.startsWith(cur)) out[f] = inc;
  }
  for (const [f, , key] of LIST_FIELDS[kind]) {
    const cur = arr(get(existing, f));
    const inc = arr(get(incoming, f));
    if (!inc.length) continue;
    out[f] = [...cur, ...inc.filter((x) => !cur.some((y) => (f === 'bullets' ? sameBullet(x, y) : key(x) === key(y))))];
  }
  return out as T;
}

/**
 * Builds the profile the user confirmed. `resumeId` is recorded as the source
 * of everything taken from the résumé. `replace` starts from an empty profile
 * (job preferences are kept); use it with a plan made against no profile.
 */
export function applyImport(profile: Profile, plan: ImportPlan, resumeId: string, opts: { replace?: boolean } = {}): Profile {
  const base: Profile = opts.replace
    ? { ...profile, basics: Basics.parse({}), skills: [], experience: [], education: [], projects: [], certifications: [], languages: [], awards: [], extras: [], provenance: {} }
    : profile;
  const prov: Record<string, string[]> = { ...(base.provenance ?? {}) };
  const note = (key: string) => {
    const list = prov[key] ?? [];
    if (!list.includes(resumeId)) prov[key] = [...list, resumeId];
  };

  const basics = { ...base.basics };
  for (const c of plan.basics) {
    if (c.status === 'same') note(`basics.${c.field}`);
    else if (c.take === 'incoming' && c.incoming && (c.status === 'new' || c.status === 'conflict')) {
      basics[c.field] = c.incoming;
      prov[`basics.${c.field}`] = [resumeId];
    }
  }
  let links = [...base.basics.links];
  for (const l of plan.links) {
    if (l.status === 'same') note(`links:${linkKey(l.url)}`);
    else if (l.include) {
      links = l.status === 'conflict' && l.replaces ? links.map((x) => (x === l.replaces ? l.url : x)) : [...links, l.url];
      prov[`links:${linkKey(l.url)}`] = [resumeId];
    }
  }
  basics.links = uniqueBy(links, linkKey);

  const mergeAll = <T extends Entry>(kind: EntryKind, existing: T[], plans: EntryPlan<T>[], prefix: string): T[] => {
    let list = [...existing];
    for (const p of plans) {
      if (p.action === 'skip') continue;
      const target = p.action === 'merge' && p.existingId ? list.find((x) => x.id === p.existingId) : undefined;
      if (target) {
        const merged = mergeEntry(kind, target, p.incoming, p.conflicts);
        list = list.map((x) => (x.id === target.id ? merged : x));
        note(`${kind}:${target.id}`);
      } else {
        const entry = { ...p.incoming, id: list.some((x) => x.id === p.incoming.id) ? uid(prefix) : p.incoming.id };
        // Into an empty list the résumé's own order is kept; otherwise new entries are slotted in by date.
        list = existing.length ? insertByDate(list, entry) : [...list, entry];
        prov[`${kind}:${entry.id}`] = [resumeId];
      }
    }
    return list;
  };

  const lists = {} as Record<ListKind, string[]>;
  for (const kind of LIST_KINDS) {
    const key = listKey(kind);
    const additions = plan.lists[kind].added.filter((i) => i.include).map((i) => i.value);
    if (kind === 'skills') additions.push(...plan.mentionedSkills.filter((i) => i.include).map((i) => i.value));
    lists[kind] = uniqueBy([...(base[kind] ?? []), ...additions], key);
    for (const v of additions) prov[`${kind}:${key(v)}`] = [resumeId];
    for (const v of plan.lists[kind].alreadyHave) note(`${kind}:${key(v)}`);
  }

  const extras = [...(base.extras ?? [])].map((x) => ({ ...x, items: [...x.items] }));
  for (const x of plan.extras) {
    const items = x.items.filter((i) => i.include).map((i) => i.value);
    if (!items.length) continue;
    const mine = extras.find((y) => textKey(y.heading) === textKey(x.heading));
    if (mine) mine.items = uniqueBy([...mine.items, ...items], textKey);
    else extras.push({ heading: x.heading, items });
  }

  return {
    ...base,
    basics,
    experience: mergeAll('experience', base.experience, plan.experience, 'exp'),
    education: mergeAll('education', base.education, plan.education, 'edu'),
    projects: mergeAll('projects', base.projects, plan.projects, 'proj'),
    ...lists,
    extras,
    provenance: prov,
  };
}

/* ----------------------------------------------------------------------------
 * Résumé versions
 * ------------------------------------------------------------------------- */

/** "Jordan_Avery_Resume (3).pdf" and "jordan-avery-resume-v2.docx" have the same stem. */
export function fileStem(name: string): string {
  return textKey(
    name
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/\(\d+\)|\bcopy\b|\bfinal\b|\bupdated?\b|\bnew\b|\blatest\b|\bv\d+\b|\b(19|20)\d{2}([-_.]\d{1,2}){0,2}\b/gi, ' ')
      .replace(/[_-]+/g, ' '),
  );
}

/**
 * The uploaded résumé this one is a new version of: same file name stem, or
 * the same person with mostly the same roles. Undefined for a different résumé.
 */
export function findFamily(originals: ResumeVersion[], fileName: string | undefined, incoming: ResumeContent): ResumeVersion | undefined {
  const stem = fileName ? fileStem(fileName) : '';
  const byName = stem ? originals.find((o) => o.sourceFileName && fileStem(o.sourceFileName) === stem) : undefined;
  if (byName) return byName;
  const person = textKey(incoming.basics.name);
  if (!person) return undefined;
  return originals.find((o) => {
    if (textKey(o.content.basics.name) !== person || !incoming.experience.length) return false;
    const pairs = pairUp(incoming.experience, o.content.experience, experienceMatch);
    const same = [...pairs.values()].filter((p) => p.existingId).length;
    return same / Math.max(incoming.experience.length, o.content.experience.length) >= 0.5;
  });
}

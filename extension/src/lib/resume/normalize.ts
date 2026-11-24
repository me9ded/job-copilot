import { findSkillDef } from '../matching/taxonomy';
import type { Education, Experience, Project, ResumeContent } from '../types';
import { normalizeForCompare } from '../util';

/**
 * Candidate profile normalizer: tidies what the parser found (capitalisation,
 * duplicates, link spelling, skill aliases) without changing its meaning.
 * Bullets keep their exact wording.
 */

const PARTICLES = new Set(['de', 'del', 'della', 'di', 'da', 'du', 'des', 'van', 'von', 'der', 'den', 'le', 'la', 'bin', 'ibn', 'al', 'el', 'y']);

/** "JORDAN AVERY" → "Jordan Avery". Names already in mixed case are left alone. */
export function tidyName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || (n !== n.toUpperCase() && n !== n.toLowerCase())) return n;
  return n
    .toLowerCase()
    .split(' ')
    .map((w, i) => (i > 0 && PARTICLES.has(w) ? w : w.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase())))
    .join(' ');
}

export function normalizeEmail(email: string): string {
  return email.trim().replace(/^mailto:/i, '').toLowerCase();
}

/** Digits of a phone number, without a leading North American "1" country code, for comparisons. */
export function phoneDigits(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/** A link without scheme, "www." and trailing slash, lower-cased host: for comparisons only. */
export function linkKey(url: string): string {
  const u = url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/[/#?]+$/, '');
  const slash = u.indexOf('/');
  return slash < 0 ? u.toLowerCase() : u.slice(0, slash).toLowerCase() + u.slice(slash).replace(/\/+$/, '').toLowerCase();
}

export type LinkKind = 'linkedin' | 'github' | 'gitlab' | 'portfolio';

export function linkKind(url: string): LinkKind {
  const host = linkKey(url).split('/')[0]!;
  if (/(^|\.)linkedin\.com$/.test(host)) return 'linkedin';
  if (/(^|\.)github\.com$/.test(host)) return 'github';
  if (/(^|\.)gitlab\.com$/.test(host)) return 'gitlab';
  return 'portfolio';
}

/** The comparison key of a skill: its canonical taxonomy name ("JS" and "JavaScript" are the same skill). */
export function skillKey(skill: string): string {
  return (findSkillDef(skill)?.name ?? skill).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** "reactjs" → "React"; unknown skills keep their spelling. */
export function canonicalSkillName(skill: string): string {
  const s = skill.replace(/\s+/g, ' ').trim();
  return findSkillDef(s)?.name ?? s;
}

/** Text key for list items (certifications, awards, bullets). */
export const textKey = (s: string): string => normalizeForCompare(s);

export function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((x) => {
    const k = key(x);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const tidyList = (items: string[] | undefined, key: (s: string) => string = textKey) =>
  uniqueBy(
    (items ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean),
    key,
  );

const tidySkills = (items: string[] | undefined) =>
  uniqueBy(
    (items ?? []).map(canonicalSkillName).filter((s) => s && s.length <= 60),
    skillKey,
  );

function tidyExperience(e: Experience): Experience {
  return {
    ...e,
    title: e.title.trim(),
    company: e.company.trim(),
    location: e.location.trim(),
    bullets: tidyList(e.bullets),
    skills: tidySkills(e.skills),
  };
}

function tidyEducation(e: Education): Education {
  const out: Education = { ...e, institution: e.institution.trim(), degree: e.degree.trim(), field: e.field.trim(), details: tidyList(e.details) };
  if (e.coursework) out.coursework = tidyList(e.coursework);
  return out;
}

function tidyProject(p: Project): Project {
  return { ...p, name: p.name.trim(), description: p.description.trim(), url: p.url.trim(), bullets: tidyList(p.bullets), skills: tidySkills(p.skills) };
}

/** Same role listed twice in one résumé (e.g. repeated after a page break): merge the bullets. */
function dedupeRoles(list: Experience[]): Experience[] {
  const out: Experience[] = [];
  for (const e of list) {
    const twin = out.find((x) => textKey(x.title) === textKey(e.title) && textKey(x.company) === textKey(e.company) && x.start === e.start && x.end === e.end);
    if (twin) {
      twin.bullets = tidyList([...twin.bullets, ...e.bullets]);
      twin.skills = tidySkills([...(twin.skills ?? []), ...(e.skills ?? [])]);
    } else out.push(e);
  }
  return out;
}

export function normalizeContent(c: ResumeContent): ResumeContent {
  return {
    ...c,
    basics: {
      ...c.basics,
      name: tidyName(c.basics.name),
      headline: c.basics.headline.trim(),
      email: normalizeEmail(c.basics.email),
      phone: c.basics.phone.replace(/\s+/g, ' ').trim(),
      location: c.basics.location.replace(/\s+/g, ' ').trim(),
      summary: c.basics.summary.replace(/\s+/g, ' ').trim(),
      links: uniqueBy(c.basics.links.map((l) => l.trim().replace(/[.,;]+$/, '')).filter(Boolean), linkKey),
    },
    skills: tidySkills(c.skills),
    experience: dedupeRoles(c.experience.map(tidyExperience)),
    education: c.education.map(tidyEducation),
    projects: uniqueBy(c.projects.map(tidyProject), (p) => textKey(p.name) || p.id),
    certifications: tidyList(c.certifications),
    languages: tidyList(c.languages),
    awards: tidyList(c.awards),
    extras: (c.extras ?? []).map((x) => ({ heading: x.heading.trim(), items: tidyList(x.items) })).filter((x) => x.items.length),
  };
}

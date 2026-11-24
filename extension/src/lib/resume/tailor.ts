import { totalYears } from '../matching/analysis';
import { extractSkills, getBaseMatchers } from '../matching/skills';
import type { ExtractedJob, MatchResult, ResumeContent } from '../types';
import { normalizeForCompare } from '../util';

/**
 * Deterministic tailoring: selects, orders and trims existing content only.
 * It never adds skills, employers, dates, numbers or claims.
 */

export interface TailorOptions {
  maxBulletsPerRole: number;
  excludedExperience: string[];
  excludedProjects: string[];
  maxProjects: number;
  hideUnrelatedSkills: boolean;
}

export const DEFAULT_TAILOR_OPTIONS: TailorOptions = {
  maxBulletsPerRole: 5,
  excludedExperience: [],
  excludedProjects: [],
  maxProjects: 3,
  hideUnrelatedSkills: false,
};

export interface TailorResult {
  content: ResumeContent;
  changes: string[];
  missing: string[];
}

const STOP = new Set('with that this from have will your team work able strong experience including using skills years knowledge ability other within across about their them they into such well also more'.split(' '));

function keywords(job: ExtractedJob): Set<string> {
  const text = [...job.requiredQualifications, ...job.preferredQualifications, ...job.responsibilities].join(' ') || job.descriptionText.slice(0, 4000);
  return new Set(
    normalizeForCompare(text)
      .split(' ')
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

export function bulletRelevance(bullet: string, required: Set<string>, preferred: Set<string>, kw: Set<string>): number {
  let score = 0;
  for (const s of extractSkills(bullet, getBaseMatchers())) score += required.has(s) ? 3 : preferred.has(s) ? 1.5 : 0;
  for (const w of new Set(normalizeForCompare(bullet).split(' '))) if (kw.has(w)) score += 0.25;
  return score;
}

export function tailorResume(base: ResumeContent, job: ExtractedJob, match: MatchResult | null, opts: TailorOptions = DEFAULT_TAILOR_OPTIONS): TailorResult {
  const required = new Set([...(match?.requiredMatched.map((h) => h.skill) ?? []), ...(match?.requiredMissing ?? [])]);
  const preferred = new Set([...(match?.preferredMatched.map((h) => h.skill) ?? []), ...(match?.preferredMissing ?? [])]);
  const kw = keywords(job);
  const changes: string[] = [];

  const experience = base.experience
    .filter((e) => !opts.excludedExperience.includes(e.id))
    .map((e) => {
      const ranked = e.bullets.map((b, i) => ({ b, i, s: bulletRelevance(b, required, preferred, kw) }));
      const sorted = [...ranked].sort((a, b) => b.s - a.s || a.i - b.i);
      const keep = sorted.slice(0, Math.max(1, opts.maxBulletsPerRole));
      const reordered = keep.some((k, idx) => k.i !== idx);
      if (reordered) changes.push(`Reordered bullets for ${e.title || e.company} to lead with the most relevant work.`);
      if (keep.length < e.bullets.length) changes.push(`Trimmed ${e.bullets.length - keep.length} less relevant bullet(s) from ${e.title || e.company}.`);
      return { ...e, bullets: keep.map((k) => k.b) };
    });
  const removedRoles = base.experience.length - experience.length;
  if (removedRoles) changes.push(`Left out ${removedRoles} role(s) you deselected.`);

  const projects = base.projects
    .filter((p) => !opts.excludedProjects.includes(p.id))
    .map((p) => ({ p, s: bulletRelevance([p.name, p.description, p.skills.join(', '), ...p.bullets].join(' '), required, preferred, kw) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.maxProjects)
    .map((x) => x.p);
  if (projects.length && projects[0]?.id !== base.projects[0]?.id) changes.push('Moved the most relevant projects to the top.');
  if (projects.length < base.projects.length) changes.push(`Showing ${projects.length} of ${base.projects.length} projects.`);

  const matched = new Set([...(match?.requiredMatched ?? []), ...(match?.preferredMatched ?? [])].filter((h) => h.credit === 1).map((h) => h.skill.toLowerCase()));
  const canonicalOf = (raw: string) => (extractSkills(raw)[0] ?? raw).toLowerCase();
  const relevantSkills = base.skills.filter((s) => matched.has(canonicalOf(s)) || matched.has(s.toLowerCase()));
  const others = base.skills.filter((s) => !relevantSkills.includes(s));
  let skills = [...relevantSkills, ...others];
  if (opts.hideUnrelatedSkills) skills = [...relevantSkills, ...others.slice(0, Math.max(0, 8 - relevantSkills.length))];
  if (relevantSkills.length && base.skills[0] !== skills[0]) changes.push(`Listed matching skills first (${relevantSkills.slice(0, 4).join(', ')}${relevantSkills.length > 4 ? '…' : ''}).`);
  if (skills.length < base.skills.length) changes.push(`Hid ${base.skills.length - skills.length} skills unrelated to this posting.`);

  return {
    content: { ...base, experience, projects, skills },
    changes: Array.from(new Set(changes)),
    missing: match?.requiredMissing ?? [],
  };
}

/** A factual, template-based summary using only profile data and matched skills. */
export function suggestSummary(base: ResumeContent, match: MatchResult | null): string {
  const years = Math.floor(totalYears(base.experience));
  const role = base.basics.headline || base.experience[0]?.title || 'Professional';
  const skills = (match?.requiredMatched ?? []).filter((h) => h.credit === 1).map((h) => h.skill).slice(0, 4);
  const exp = years >= 1 ? ` with ${years}+ years of experience` : '';
  const focus = skills.length ? `, working with ${skills.length > 1 ? `${skills.slice(0, -1).join(', ')} and ${skills.at(-1)}` : skills[0]}` : '';
  const recent = base.experience[0];
  const recentLine = recent?.company ? ` Most recently ${recent.title ? `${recent.title} at ` : 'at '}${recent.company}.` : '';
  return `${role}${exp}${focus}.${recentLine}`;
}

export interface BulletIssue {
  code: 'weak_opener' | 'no_metric' | 'too_long' | 'first_person' | 'passive';
  message: string;
}

/** Suggestions only — the user decides how (and whether) to rewrite. */
export function lintBullet(bullet: string): BulletIssue[] {
  const issues: BulletIssue[] = [];
  if (/^(responsible for|helped|assisted( with)?|worked on|participated in|involved in|duties included|tasked with|in charge of)\b/i.test(bullet))
    issues.push({ code: 'weak_opener', message: 'Starts with a weak phrase — lead with what you did (e.g. “Built…”, “Led…”, “Reduced…”).' });
  if (!/\d/.test(bullet)) issues.push({ code: 'no_metric', message: 'No measurable result — add a real number (scale, time saved, %) if you have one.' });
  if (bullet.split(/\s+/).length > 32) issues.push({ code: 'too_long', message: 'Long — aim for one or two lines.' });
  if (/\b(I|my|me)\b/.test(bullet)) issues.push({ code: 'first_person', message: 'Avoid first-person pronouns in résumé bullets.' });
  if (/\b(was|were|been|being)\s+\w+ed\b/i.test(bullet)) issues.push({ code: 'passive', message: 'Passive voice — prefer an active verb.' });
  return issues;
}

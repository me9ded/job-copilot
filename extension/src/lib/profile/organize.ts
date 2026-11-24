import { monthIndex } from '../matching/analysis';
import { containsSkill, customMatchers, getBaseMatchers, type SkillMatcher } from '../matching/skills';
import { findSkillDef, type SkillCategory } from '../matching/taxonomy';
import type { Experience, Project, ResumeContent } from '../types';

/**
 * Derived, read-only views of the career profile. Nothing here is stored or
 * invented: it only groups and indexes what the user's résumé already says.
 */

export type SkillGroup = 'languages' | 'frameworks' | 'tools' | 'other';

export const SKILL_GROUP_LABEL: Record<SkillGroup, string> = {
  languages: 'Programming languages',
  frameworks: 'Frameworks & libraries',
  tools: 'Tools & platforms',
  other: 'Other skills',
};

const GROUP_OF: Partial<Record<SkillCategory, SkillGroup>> = {
  language: 'languages',
  frontend: 'frameworks',
  backend: 'frameworks',
  mobile: 'frameworks',
  ml: 'frameworks',
  data: 'frameworks',
  cloud: 'tools',
  devops: 'tools',
  database: 'tools',
  tool: 'tools',
  testing: 'tools',
  security: 'tools',
};

export function skillGroup(skill: string): SkillGroup {
  const def = findSkillDef(skill);
  return (def && GROUP_OF[def.category]) ?? 'other';
}

/** Skills grouped for display, keeping the user's order within each group. */
export function groupSkills(skills: string[]): Array<{ group: SkillGroup; label: string; skills: string[] }> {
  const by = new Map<SkillGroup, string[]>();
  for (const s of skills) {
    const g = skillGroup(s);
    by.set(g, [...(by.get(g) ?? []), s]);
  }
  return (['languages', 'frameworks', 'tools', 'other'] as const).filter((g) => by.has(g)).map((g) => ({ group: g, label: SKILL_GROUP_LABEL[g], skills: by.get(g)! }));
}

const METRIC_RE = /\d|%|\b\d+x\b|×/;
const RESULT_RE =
  /\b(increas|reduc|improv|cut|sav|grew|grow|boost|accelerat|won|award|recogni[sz]|launch|shipp|deliver|achiev|exceed|doubl|tripl|lower|decreas|eliminat|speed|sped|optimi[sz]|promot|rank|top \d|first place|patent|publish)/i;

export function isAchievement(bullet: string): boolean {
  return METRIC_RE.test(bullet) || RESULT_RE.test(bullet);
}

/** Splits bullets into achievements (measurable or result-oriented) and responsibilities. */
export function splitBullets(bullets: string[]): { achievements: string[]; responsibilities: string[] } {
  const achievements: string[] = [];
  const responsibilities: string[] = [];
  for (const b of bullets) (isAchievement(b) ? achievements : responsibilities).push(b);
  return { achievements, responsibilities };
}

const EMPLOYMENT_RULES: Array<[RegExp, Experience['employmentType']]> = [
  [/\bco-?op\b/i, 'co-op'],
  [/\bintern(ship)?\b/i, 'internship'],
  [/\bstudent\b|\btrainee\b|\bapprentice\b/i, 'internship'],
  [/\bcontract(or)?\b|\bfreelanc/i, 'contract'],
  [/\bpart[- ]time\b/i, 'part-time'],
  [/\bvolunteer\b/i, 'volunteer'],
];

/** A best guess from the title; the user can change it. Empty when nothing suggests a type. */
export function inferEmploymentType(title: string): Experience['employmentType'] {
  for (const [re, t] of EMPLOYMENT_RULES) if (re.test(title)) return t;
  return '';
}

export interface Evidence {
  kind: 'experience' | 'project';
  /** Id of the role or project. */
  id: string;
  /** "Software Test Student at BlackBerry QNX" or "Project: Kernel scheduler". */
  source: string;
  /** Exact bullet text from the profile (never rewritten). */
  text: string;
  title?: string;
  company?: string;
  projectName?: string;
  start: string;
  end: string;
  /** Skills mentioned in this bullet (canonical names). */
  skills: string[];
}

export function roleLabel(e: Pick<Experience, 'title' | 'company'>): string {
  return [e.title, e.company].filter(Boolean).join(' at ') || 'a previous role';
}

/** Every bullet of the profile as a piece of evidence, with its context. */
export function allEvidence(p: ResumeContent, matchers: SkillMatcher[] = profileMatchers(p)): Evidence[] {
  const out: Evidence[] = [];
  const skillsIn = (text: string) => matchers.filter((m) => containsSkill(text, m)).map((m) => m.name);
  for (const e of p.experience) {
    for (const b of e.bullets) {
      if (!b.trim()) continue;
      out.push({ kind: 'experience', id: e.id, source: roleLabel(e), text: b.trim(), title: e.title, company: e.company, start: e.start, end: e.end, skills: skillsIn(`${e.title}\n${b}`) });
    }
  }
  for (const pr of p.projects) {
    const lines = [pr.description, ...pr.bullets].filter((x) => x.trim());
    const techs = pr.skills.join(', ');
    for (const b of lines) {
      out.push({ kind: 'project', id: pr.id, source: `Project: ${pr.name || 'untitled'}`, text: b.trim(), projectName: pr.name, start: pr.start ?? '', end: pr.end ?? '', skills: skillsIn(`${pr.name}\n${b}\n${techs}`) });
    }
  }
  return out;
}

export function profileMatchers(p: ResumeContent): SkillMatcher[] {
  return [...getBaseMatchers(), ...customMatchers(p.skills)];
}

/** Roles and projects that mention a skill, newest first, plus the time span of the dated roles. */
export function skillEvidence(p: ResumeContent, skill: string): { evidence: Evidence[]; months: number; roles: Experience[]; projects: Project[] } {
  const matchers = profileMatchers(p);
  const m = matchers.find((x) => x.name.toLowerCase() === skill.toLowerCase()) ?? customMatchers([skill])[0];
  if (!m) return { evidence: [], months: 0, roles: [], projects: [] };
  const roles = p.experience.filter((e) => containsSkill([e.title, ...e.bullets].join('\n'), m));
  const projects = p.projects.filter((pr) => containsSkill([pr.name, pr.description, pr.skills.join(', '), ...pr.bullets].join('\n'), m));
  const evidence = allEvidence(p, matchers).filter((ev) => ev.skills.includes(m.name));
  return { evidence, months: spanMonths(roles), roles, projects };
}

/** Months covered by roles' date ranges, overlaps merged. Undated roles count as 0. */
export function spanMonths(roles: Array<Pick<Experience, 'start' | 'end'>>, now = new Date()): number {
  const nowIdx = now.getFullYear() * 12 + now.getMonth();
  const ranges: Array<[number, number]> = [];
  for (const r of roles) {
    const s = monthIndex(r.start);
    const e = r.end && r.end !== 'present' ? monthIndex(r.end) : nowIdx;
    if (s === null || e === null || e < s) continue;
    ranges.push([s, e + 1]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cur: [number, number] | null = null;
  for (const r of ranges) {
    if (!cur || r[0] > cur[1]) {
      if (cur) months += cur[1] - cur[0];
      cur = [r[0], r[1]];
    } else cur[1] = Math.max(cur[1], r[1]);
  }
  if (cur) months += cur[1] - cur[0];
  return months;
}

/** Sort key for recency: present roles first, then by end date. */
export function recency(e: Pick<Evidence, 'end' | 'start'>): number {
  if (e.end === 'present') return 1e7;
  return monthIndex(e.end) ?? monthIndex(e.start) ?? 0;
}

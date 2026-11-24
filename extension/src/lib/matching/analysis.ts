import type { ExtractedJob, ResumeContent, Seniority, WorkArrangement } from '../types';
import { hash } from '../util';
import { canonicalSkill, customMatchers, extractSkills, getBaseMatchers, type SkillMatcher } from './skills';
import { TAXONOMY_VERSION } from './taxonomy';

export const ANALYSIS_VERSION = `a2-t${TAXONOMY_VERSION}`;

export const SENIORITY_RANK: Record<Seniority, number> = {
  intern: 0,
  entry: 1,
  mid: 2,
  senior: 3,
  staff: 4,
  manager: 4,
};

export const SENIORITY_LABEL: Record<Seniority, string> = {
  intern: 'Intern',
  entry: 'Entry / junior',
  mid: 'Mid-level',
  senior: 'Senior',
  staff: 'Staff / principal / lead',
  manager: 'Manager / director',
};

export const EDUCATION_LABEL = ['None', 'Associate / diploma', "Bachelor's", "Master's", 'PhD'] as const;

export interface JobAnalysis {
  version: string;
  requiredSkills: string[];
  preferredSkills: string[];
  /** Required skills were inferred from the whole posting (no explicit requirements section). */
  inferredRequirements: boolean;
  minYears: number | null;
  seniority: Seniority | null;
  education: { level: number; orEquivalent: boolean } | null;
  arrangement: WorkArrangement;
  sponsorshipUnavailable: boolean;
  clearanceRequired: boolean;
  /** The posting contains text that looks like instructions aimed at an AI model. */
  injectionSuspected: boolean;
}

type JobInput = Pick<
  ExtractedJob,
  | 'title'
  | 'descriptionText'
  | 'requiredQualifications'
  | 'preferredQualifications'
  | 'responsibilities'
  | 'workArrangement'
  | 'location'
>;

const PREFERRED_CUE = /\b(nice[- ]to[- ]have|preferred|a plus|is a plus|are a plus|bonus|ideally|desirable|advantageous|not required|familiarity with)\b/i;

const YEARS_RE =
  /(\d{1,2})\s*\+?\s*(?:(?:-|–|to)\s*\d{1,2}\s*\+?\s*)?(?:years?|yrs?)\b(?:\s+of)?(?:[^.\n]{0,80}?)\b(?:experience|exp\b|background|industry)/gi;

export function parseMinYears(text: string): number | null {
  let max: number | null = null;
  for (const m of text.matchAll(YEARS_RE)) {
    const n = Number(m[1]);
    if (n > 0 && n <= 20) max = max === null ? n : Math.max(max, n);
  }
  return max;
}

const IC_MANAGER_TITLES = /\b(product|program|project|account|marketing|community|content|partner|success|office|case|data)\s+manager\b/i;

export function inferSeniority(title: string): Seniority | null {
  const t = title.toLowerCase();
  if (/\b(intern|internship|co-?op|apprentice(ship)?)\b/.test(t)) return 'intern';
  if (/\b(director|head of|vp|vice president|chief|cto|cio)\b/.test(t)) return 'manager';
  if (/\bmanager\b/.test(t) && !IC_MANAGER_TITLES.test(t)) return 'manager';
  if (/\b(staff|principal|distinguished|architect|lead)\b/.test(t)) return 'staff';
  if (/\b(senior|sr\.?)\b|\biii\b|\biv\b/.test(t)) return 'senior';
  if (/\b(junior|jr\.?|entry[- ]level|new grad(uate)?|graduate|early career)\b|\bi\b$/.test(t)) return 'entry';
  if (/\bii\b|\bmid[- ]level\b|\bintermediate\b/.test(t)) return 'mid';
  return null;
}

export function educationLevel(text: string): number {
  const t = text.toLowerCase();
  if (/\b(ph\.?\s?d|doctorate|doctoral)\b/.test(t)) return 4;
  if (/\b(master'?s?|m\.s\.?|msc|m\.sc|mba|m\.eng|meng|ma in)\b/.test(t)) return 3;
  if (/\b(bachelor'?s?|b\.s\.?|b\.a\.?|bsc|b\.sc|b\.eng|beng|btech|b\.tech|undergraduate degree|(4|four)[- ]year degree|college degree|university degree|bs\/ms|ba\/bs|bs\/ba)\b/.test(t))
    return 2;
  if (/\b(associate'?s? degree|diploma|aas|a\.s\.)\b/.test(t)) return 1;
  return 0;
}

function parseJobEducation(text: string): JobAnalysis['education'] {
  const sentences = text.split(/[\n.;]/).filter((s) => /degree|bachelor|master|ph\.?d|b\.s|m\.s|bsc|msc|mba|diploma/i.test(s));
  if (!sentences.length) return null;
  let level = Infinity;
  for (const s of sentences) {
    const l = educationLevel(s);
    if (l > 0) level = Math.min(level, l);
  }
  if (level === Infinity) return null;
  const orEquivalent = /equivalent|or related (practical |work )?experience|in lieu of|or relevant experience/i.test(text);
  return { level, orEquivalent };
}

export function detectArrangement(text: string): WorkArrangement {
  const t = text.toLowerCase();
  if (/\bhybrid\b/.test(t)) return 'hybrid';
  if (/\b(fully remote|remote[- ]first|100% remote|work from home|wfh|remote\s*(-|–|,|\(|\/)|\bremote\b)/.test(t)) {
    if (/\b(not remote|no remote|non-remote)\b/.test(t)) return 'onsite';
    return 'remote';
  }
  if (/\b(on-?site|in[- ]office|in person|in-person)\b/.test(t)) return 'onsite';
  return 'unknown';
}

const SPONSORSHIP_RE =
  /\b(unable|not able|cannot|can't|will not|won't|do not|does not|are not able|is not able)\s+(to\s+)?(offer\s+|provide\s+)?(any\s+)?(visa\s+|immigration\s+)?sponsor|\bno\s+(visa\s+)?sponsorship\b|without\s+(the\s+)?(need\s+for\s+)?(current\s+or\s+future\s+|future\s+)?(visa\s+|employer\s+)?sponsorship|sponsorship\s+(is\s+)?not\s+(available|offered|provided)/i;
const CLEARANCE_RE = /\b(security clearance|secret clearance|ts\/sci|top secret|active clearance|clearance is required|obtain (and maintain )?a clearance)\b/i;
const INJECTION_RE =
  /(ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|prompts?)|disregard\s+(all\s+)?(the\s+)?(previous|prior|above)|you\s+are\s+now\s+(a|an|in)\b|system\s+prompt|<\/?\s*(system|assistant|instructions?)\s*>|if you are an? (ai|llm|language model)|as an ai language model|include the (word|phrase)\s+["'][^"']+["']\s+in your)/i;

export function detectInjection(text: string): boolean {
  return INJECTION_RE.test(text);
}

export function analyzeJob(job: JobInput, matchers: SkillMatcher[] = getBaseMatchers()): JobAnalysis {
  const reqLines = job.requiredQualifications ?? [];
  const prefLines = job.preferredQualifications ?? [];
  const inferred = reqLines.length === 0;

  // Classify sentence by sentence so "We use React. GraphQL is a plus." splits correctly.
  const preferredParts: string[] = [...prefLines];
  const strict: string[] = [];
  const source = inferred ? job.descriptionText.split('\n') : reqLines;
  for (const sentence of source.flatMap((l) => l.split(/(?<=[.;!?])\s+/))) (PREFERRED_CUE.test(sentence) ? preferredParts : strict).push(sentence);
  const requiredText = strict.join('\n');

  const required = extractSkills(requiredText, matchers);
  const requiredSet = new Set(required);
  const preferred = extractSkills(preferredParts.join('\n'), matchers).filter((s) => !requiredSet.has(s));
  // Stack mentioned only in responsibilities is useful signal but not a hard requirement.
  if (!inferred) {
    const prefSet = new Set(preferred);
    for (const s of extractSkills((job.responsibilities ?? []).join('\n'), matchers)) {
      if (!requiredSet.has(s) && !prefSet.has(s)) {
        preferred.push(s);
        prefSet.add(s);
      }
    }
  }

  const fullText = `${job.title}\n${job.descriptionText}`;
  const reqOrAll = inferred ? job.descriptionText : `${reqLines.join('\n')}`;
  const arrangement =
    job.workArrangement && job.workArrangement !== 'unknown'
      ? job.workArrangement
      : detectArrangement(`${job.location ?? ''}\n${job.title}\n${job.descriptionText.slice(0, 4000)}`);

  return {
    version: ANALYSIS_VERSION,
    requiredSkills: required,
    preferredSkills: preferred,
    inferredRequirements: inferred,
    minYears: parseMinYears(reqOrAll) ?? parseMinYears(job.descriptionText),
    seniority: inferSeniority(job.title),
    education: parseJobEducation(reqOrAll) ?? parseJobEducation(job.descriptionText),
    arrangement,
    sponsorshipUnavailable: SPONSORSHIP_RE.test(fullText),
    clearanceRequired: CLEARANCE_RE.test(fullText),
    injectionSuspected: detectInjection(fullText),
  };
}

/* ----------------------------------------------------------------------------
 * Profile analysis
 * ------------------------------------------------------------------------- */

export interface ProfileAnalysis {
  /** canonical skill → human-readable evidence ("Skills section", "Acme — Software Engineer"). */
  skills: Map<string, string[]>;
  declared: Set<string>;
  custom: SkillMatcher[];
  years: number;
  educationLevel: number;
  text: string;
}

export function monthIndex(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (!v) return null;
  if (/present|current|now|today/.test(v)) {
    const d = new Date();
    return d.getFullYear() * 12 + d.getMonth();
  }
  const m = v.match(/^(\d{4})(?:-(\d{1,2}))?/);
  if (!m) return null;
  return Number(m[1]) * 12 + (m[2] ? Number(m[2]) - 1 : 0);
}

/** Total years of experience with overlapping roles merged (no double counting). */
export function totalYears(experience: ResumeContent['experience']): number {
  const ranges: Array<[number, number]> = [];
  for (const e of experience) {
    const start = monthIndex(e.start);
    const end = monthIndex(e.end || 'present');
    if (start === null || end === null || end < start) continue;
    ranges.push([start, end + 1]);
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
  return Math.round((months / 12) * 10) / 10;
}

export function profileText(p: ResumeContent): string {
  return [
    p.basics.headline,
    p.basics.summary,
    p.skills.join(', '),
    ...p.experience.flatMap((e) => [e.title, e.company, ...e.bullets]),
    ...p.projects.flatMap((pr) => [pr.name, pr.description, pr.skills.join(', '), ...pr.bullets]),
    ...p.education.flatMap((ed) => [ed.degree, ed.field, ed.institution, ...ed.details]),
    ...p.certifications,
  ]
    .filter(Boolean)
    .join('\n');
}

const profileCache = new Map<string, ProfileAnalysis>();

export function analyzeProfile(p: ResumeContent): ProfileAnalysis {
  const key = hash(JSON.stringify([p.skills, p.experience, p.projects, p.education, p.basics.summary, p.basics.headline, p.certifications]));
  const cached = profileCache.get(key);
  if (cached) return cached;

  const custom = customMatchers(p.skills);
  const matchers = [...getBaseMatchers(), ...custom];
  const skills = new Map<string, string[]>();
  const add = (skill: string, where: string) => {
    const list = skills.get(skill) ?? [];
    if (!list.includes(where)) list.push(where);
    skills.set(skill, list);
  };

  const declared = new Set<string>();
  for (const raw of p.skills) {
    const names = extractSkills(raw, matchers);
    const resolved = names.length ? names : [canonicalSkill(raw)];
    for (const n of resolved) {
      declared.add(n);
      add(n, 'Skills section');
    }
  }
  for (const e of p.experience) {
    const label = [e.title, e.company].filter(Boolean).join(' — ') || 'Experience';
    for (const n of extractSkills([e.title, ...e.bullets].join('\n'), matchers)) add(n, label);
  }
  for (const pr of p.projects) {
    const label = pr.name ? `Project: ${pr.name}` : 'Project';
    for (const n of extractSkills([pr.name, pr.description, pr.skills.join(', '), ...pr.bullets].join('\n'), matchers)) add(n, label);
  }
  for (const n of extractSkills([p.basics.summary, p.basics.headline, ...p.certifications].join('\n'), matchers)) add(n, 'Summary');

  const result: ProfileAnalysis = {
    skills,
    declared,
    custom,
    years: totalYears(p.experience),
    educationLevel: Math.max(0, ...p.education.map((e) => educationLevel(`${e.degree} ${e.field}`))),
    text: profileText(p),
  };
  if (profileCache.size > 20) profileCache.clear();
  profileCache.set(key, result);
  return result;
}

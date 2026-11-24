import { analyzeJob, totalYears } from '../matching/analysis';
import { extractSkills } from '../matching/skills';
import { allEvidence, isAchievement, profileMatchers, recency, roleLabel, skillEvidence, spanMonths, type Evidence } from '../profile/organize';
import type { ExtractedJob, ResumeContent } from '../types';

/**
 * Drafts answers to open-ended application questions from the user's own
 * profile. Every factual statement is a bullet from the résumé, quoted with
 * its role; nothing is invented. Where only the user can answer (why this
 * company), the draft contains a [bracketed slot] and can't be filled until
 * the user replaces it. Runs in the extension page, never in the web page.
 */

export type QuestionType = 'years_of' | 'cover_letter' | 'motivation' | 'fit' | 'skill_experience' | 'project' | 'strength' | 'work_experience' | 'other';

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  years_of: 'Years of experience',
  cover_letter: 'Cover letter',
  motivation: 'Motivation',
  fit: 'Why you',
  skill_experience: 'Skill experience',
  project: 'Project',
  strength: 'Strengths',
  work_experience: 'Work experience',
  other: 'Other',
};

export interface QuestionInfo {
  type: QuestionType;
  /** Skills the question asks about (canonical names). */
  skills: string[];
}

const lower = (s: string) => s.toLowerCase().replace(/[’‘]/g, "'");

const YEARS_RE = /\bhow many years\b|\b(number|#) of years\b|\byears of (professional |relevant |hands-on )?(experience|exp)\b|\byears (have you|of using|working with)\b/;
const COVER_RE = /cover ?letter|motivation letter|letter of (interest|motivation)/;
const MOTIVATION_RE =
  /\bwhy (do you want|are you (interested|applying)|would you (like|want)|this (company|role|position|job|team)|us\b|join|work (here|at|for))|\bwhat (interests|excites|attracts|draws|motivates) you\b|\binterest(ed)? in (this|the|our|working)\b|\bmotivat/;
const FIT_RE =
  /\bwhy should we (hire|choose|pick)\b|\b(good|great|strong|ideal) (fit|candidate|match)\b|\bwhat makes you\b|\bwhy (are )?you (the|a) \b|\bwhat (would|will|can) you bring\b|\bstand out\b|\bqualif(ies|y|ied) you\b|\bwhat sets you apart\b/;
const PROJECT_RE = /\bproject\b|\bchalleng|\bproblem (you|that you) (solved|faced)|\bproud of\b|\bsomething you (built|made|created)\b|\bdifficult (bug|problem|technical)/;
const STRENGTH_RE = /\bstrength|\bbest (skill|quality)|\bwhat are you (good|best) at\b|\bsuperpower\b/;
const SKILL_CUE_RE = /\bexperience\b|\bfamiliar|\bproficien|\bworked with\b|\bused\b|\btell us\b|\bdescribe\b|\bknowledge\b|\bbackground\b|\blevel\b|\bcomfortable\b|\bexpertise\b|\bskills?\b/;
const WORK_RE =
  /\bwork experience\b|\bprevious (role|job|experience|position|employer)|\bprofessional (experience|background)\b|\bemployment\b|\brelevant experience\b|\bdescribe your experience\b|\btell us about (yourself|you)\b|\babout yourself\b|\byour (background|experience)\b/;

export function classifyQuestion(label: string, profile?: ResumeContent): QuestionInfo {
  const q = lower(label);
  const skills = extractSkills(label, profile ? profileMatchers(profile) : undefined);
  const type: QuestionType = YEARS_RE.test(q)
    ? 'years_of'
    : COVER_RE.test(q)
      ? 'cover_letter'
      : MOTIVATION_RE.test(q)
        ? 'motivation'
        : FIT_RE.test(q)
          ? 'fit'
          : skills.length && SKILL_CUE_RE.test(q)
            ? 'skill_experience'
            : PROJECT_RE.test(q)
              ? 'project'
              : STRENGTH_RE.test(q)
                ? 'strength'
                : WORK_RE.test(q)
                  ? 'work_experience'
                  : skills.length
                    ? 'skill_experience'
                    : 'other';
  return { type, skills };
}

export interface Draft {
  type: QuestionType;
  /** The suggested answer. Empty when there is nothing truthful to say. */
  text: string;
  /** Résumé bullets the answer is built from. */
  evidence: Evidence[];
  /** Explains how the answer was put together, or why there is none. */
  note?: string;
  /** Skills the question asks about that the profile doesn't mention. */
  missingSkills: string[];
}

/** "[add your personal reason]" slots the user must replace before filling. */
export const SLOT_RE = /\[(add|describe|what|name|explain|your)[^\]]*\]/i;
export const hasSlot = (text: string) => SLOT_RE.test(text);

const PAST_VERBS = new Set(
  'built led wrote ran made drove set cut won taught began grew saw put kept got held oversaw rewrote undertook spoke chose brought sought thought found gave took shipped'.split(' '),
);
const BASE_VERBS = new Set(
  'build develop design maintain create manage test write lead support implement automate own run analyze improve deliver collaborate work help coordinate review deploy monitor optimize debug document train mentor research configure integrate migrate'.split(' '),
);

/** Turns a résumé bullet ("Built X") into a clause that follows "I" ("built x"). Returns null when it doesn't start with a verb. */
function clause(bullet: string): { text: string; verb: boolean } {
  const b = bullet.trim().replace(/[.;]+$/, '');
  const [first = ''] = b.split(/\s+/);
  const w = first.toLowerCase().replace(/[^a-z]/g, '');
  const keepCase = /^[A-Z]{2}/.test(first); // "API", "AWS"
  const lc = keepCase ? b : b.charAt(0).toLowerCase() + b.slice(1);
  if (/^responsible for\b/i.test(b)) return { text: `was ${lc}`, verb: true };
  // "Built with Go and Grafana" describes the thing, not an action.
  if (/^(built|made|written|developed|implemented) (with|using|in|on)\b/i.test(b)) return { text: `it was ${lc}`, verb: false };
  if (PAST_VERBS.has(w) || BASE_VERBS.has(w) || /ed$/.test(w)) return { text: lc, verb: true };
  if (/ing$/.test(w) && w.length > 4) return { text: `worked on ${lc}`, verb: true };
  // Not an action ("Kafka lag dashboard", "Python scripts for…"): keep the user's own capitalisation.
  return { text: b, verb: false };
}

function fmtMonth(d: string): string {
  if (d === 'present') return 'present';
  const m = /^(\d{4})-(\d{2})$/.exec(d);
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m ? `${names[Number(m[2]) - 1]} ${m[1]}` : d;
}
const dateRange = (s: string, e: string) => [s, e].filter(Boolean).map(fmtMonth).join(' – ');

/** One sentence per piece of evidence, with its context the first time a source appears. */
function sentences(evidence: Evidence[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const ev of evidence) {
    const c = clause(ev.text);
    const first = !seen.has(ev.id);
    seen.add(ev.id);
    let s: string;
    if (ev.kind === 'experience') {
      const ctx = ev.title && ev.company ? `as ${article(ev.title)} ${ev.title} at ${ev.company}` : ev.company ? `at ${ev.company}` : `as ${article(ev.title ?? 'role')} ${ev.title}`;
      if (c.verb) s = first ? `${cap(ctx)}, I ${c.text}.` : `I also ${c.text}.`;
      else if (c.text.startsWith('it was ')) s = first ? `${cap(ctx)}, I worked on a system that was ${c.text.slice(7)}.` : `It was ${c.text.slice(7)}.`;
      else s = first ? `${cap(ctx)}, my work included ${c.text}.` : `My work there also included ${c.text}.`;
    } else {
      const name = ev.projectName ? `my project ${ev.projectName}` : 'a project';
      if (c.verb) s = first ? `In ${name}, I ${c.text}.` : `I also ${c.text}.`;
      else if (c.text.startsWith('it was ')) s = `${first ? `${cap(name)} was` : 'It was'} ${c.text.slice(7)}.`;
      else s = first && ev.projectName ? `${ev.projectName} is ${article(c.text)} ${c.text}.` : `${cap(c.text)}.`;
    }
    out.push(s);
  }
  return out;
}

/** "for 8 months", "for about a year", "for over 2 years" (rounded down, never up). */
function spanPhrase(months: number): string {
  if (months <= 0) return '';
  if (months < 12) return `for ${months} month${months === 1 ? '' : 's'}`;
  const y = Math.floor(months / 12);
  const unit = y === 1 ? 'a year' : `${y} years`;
  return months % 12 >= 3 ? `for over ${unit}` : `for about ${unit}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const article = (word: string) => (/^[aeiou]/i.test(word.trim()) && !/^(uni|use|eu)/i.test(word.trim()) ? 'an' : 'a');
const listJoin = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

const WORD_RE = /[a-z][a-z0-9+#.]{2,}/g;
const STOP = new Set('the and for you your with what have has did does about this that from tell describe please experience how any our are was were which when where who why would will can could role job position work company team'.split(' '));
const keywords = (s: string) => new Set((lower(s).match(WORD_RE) ?? []).filter((w) => !STOP.has(w)));

interface Ranked {
  ev: Evidence;
  score: number;
}

/** Ranks résumé evidence for a question: asked skills first, then the job's skills, wording, results and recency. */
export function rankEvidence(profile: ResumeContent, questionSkills: string[], question: string, job?: ExtractedJob | null): Ranked[] {
  const analysis = job ? analyzeJob(job, profileMatchers(profile)) : null;
  const required = new Set(analysis?.requiredSkills ?? []);
  const preferred = new Set(analysis?.preferredSkills ?? []);
  const asked = new Set(questionSkills);
  const words = keywords(question);
  const all = allEvidence(profile);
  const maxRecency = Math.max(1, ...all.map(recency));
  return all
    .map((ev) => {
      let score = 0;
      for (const s of ev.skills) {
        if (asked.has(s)) score += 3;
        else if (required.has(s)) score += 1.5;
        else if (preferred.has(s)) score += 0.75;
      }
      const evWords = keywords(ev.text);
      for (const w of words) if (evWords.has(w)) score += 0.5;
      if (isAchievement(ev.text)) score += 0.5;
      score += (recency(ev) / maxRecency) * 0.5;
      return { ev, score };
    })
    .sort((a, b) => b.score - a.score);
}

/** Keeps whole sentences within a length limit. */
export function fitLength(parts: string[], maxLength?: number): string {
  if (!maxLength) return parts.join(' ');
  const out: string[] = [];
  for (const p of parts) {
    const next = [...out, p].join(' ');
    if (next.length > maxLength) break;
    out.push(p);
  }
  if (out.length) return out.join(' ');
  const first = parts[0] ?? '';
  const cut = first.slice(0, Math.max(0, maxLength - 1)).replace(/\s+\S*$/, '');
  return cut ? `${cut}…` : '';
}

export interface ComposeOptions {
  maxLength?: number;
  /** A single-line input: keep it short. */
  short?: boolean;
  now?: Date;
}

function declared(profile: ResumeContent, skill: string): boolean {
  return extractSkills(profile.skills.join(', '), profileMatchers(profile)).includes(skill);
}

/** Drafts an answer to an application question from the profile (and the job, when known). */
export function composeAnswer(label: string, profile: ResumeContent, job?: ExtractedJob | null, opts: ComposeOptions = {}): Draft {
  const info = classifyQuestion(label, profile);
  const limit = opts.maxLength ?? (opts.short ? 250 : undefined);
  const base: Draft = { type: info.type, text: '', evidence: [], missingSkills: [] };
  const ranked = rankEvidence(profile, info.skills, label, job);
  const pick = (n: number, filter: (ev: Evidence) => boolean = () => true) => ranked.filter((r) => filter(r.ev) && r.score > 0.6).slice(0, n).map((r) => r.ev);
  const finish = (parts: string[], evidence: Evidence[], note?: string): Draft => ({ ...base, text: fitLength(parts, limit), evidence, note });
  const jobName = job?.title ? `the ${job.title} role${job.company ? ` at ${job.company}` : ''}` : 'this role';

  switch (info.type) {
    case 'years_of': {
      const skill = info.skills[0];
      if (!skill) {
        const years = Math.floor(totalYears(profile.experience));
        return { ...base, text: String(years), note: `Total professional experience from the dates in your résumé (${totalYears(profile.experience)} years, rounded down).` };
      }
      const { months, roles, projects } = skillEvidence(profile, skill);
      const years = Math.floor(spanMonths(roles, opts.now) / 12);
      const used = roles.map((r) => `${roleLabel(r)} (${dateRange(r.start, r.end) || 'no dates'})`);
      if (!roles.length && !projects.length && !declared(profile, skill)) return { ...base, text: '0', missingSkills: [skill], note: `Your résumé doesn't mention ${skill}. Change this if you have used it.` };
      const note = roles.length
        ? `Counted from roles that mention ${skill}: ${used.join('; ')} = ${months} months, rounded down.`
        : `No dated role mentions ${skill}${projects.length ? ' (only projects do)' : ''}, so this says 0. Change it if that's wrong.`;
      return { ...base, text: String(years), note };
    }

    case 'cover_letter':
      return { ...base, note: 'Cover letters are attached from Résumé Studio → Cover letter for this job, not written here.' };

    case 'skill_experience': {
      const asked = info.skills;
      const missing = asked.filter((s) => !skillEvidence(profile, s).evidence.length && !declared(profile, s));
      const known = asked.filter((s) => !missing.includes(s));
      if (!known.length)
        return { ...base, missingSkills: missing, note: `Your résumé doesn't mention ${listJoin(missing)}. Job Copilot won't claim experience you haven't listed: write this one yourself, or add it to your profile first.` };
      const ev = pick(opts.short ? 1 : 3, (e) => e.skills.some((s) => known.includes(s)));
      const { roles } = skillEvidence(profile, known[0]!);
      const months = spanMonths(roles, opts.now);
      const span = spanPhrase(months);
      const opener = ev.length
        ? `I have worked with ${listJoin(known)}${span ? ` ${span}` : ''}.`
        : `I have experience with ${listJoin(known)} [add an example of how you used it].`;
      const parts = [opener, ...sentences(ev)];
      const req = job ? analyzeJob(job, profileMatchers(profile)).requiredSkills : [];
      const relevant = known.filter((s) => req.includes(s));
      if (relevant.length && !opts.short) parts.push(`That maps directly to ${jobName}, which lists ${listJoin(relevant)} as a requirement.`);
      return {
        ...finish(parts, ev, ev.length ? undefined : `${listJoin(known)} is in your skills list, but no role or project describes it. Add an example before filling.`),
        missingSkills: missing,
      };
    }

    case 'project': {
      const projects = ranked.filter((r) => r.ev.kind === 'project');
      const bestProject = projects[0]?.ev;
      const ev = bestProject ? ranked.filter((r) => r.ev.id === bestProject.id).slice(0, 3).map((r) => r.ev) : pick(2, (e) => isAchievement(e.text));
      if (!ev.length) return { ...base, note: 'Your résumé has no projects or results to draw from. Add a project to your profile, or write this one yourself.' };
      const parts = sentences(ev);
      parts.push('The main challenge was [describe the challenge and how you solved it].');
      return finish(parts, ev);
    }

    case 'motivation': {
      const analysis = job ? analyzeJob(job, profileMatchers(profile)) : null;
      const have = new Set(allEvidence(profile).flatMap((e) => e.skills));
      const overlap = (analysis?.requiredSkills ?? []).filter((s) => have.has(s)).slice(0, 3);
      const ev = pick(1);
      const parts = [`I'm excited about ${jobName} because [add your personal reason for this company].`];
      if (overlap.length) parts.push(`The role's focus on ${listJoin(overlap)} matches what I've been doing.`);
      parts.push(...sentences(ev));
      return finish(parts, ev, 'Only you know why you want this job: replace the bracketed part before filling.');
    }

    case 'fit':
    case 'strength': {
      const analysis = job ? analyzeJob(job, profileMatchers(profile)) : null;
      const have = new Set(allEvidence(profile).flatMap((e) => e.skills));
      const matched = (analysis?.requiredSkills ?? []).filter((s) => have.has(s)).slice(0, 4);
      const top = matched.length ? matched : [...new Set(ranked.flatMap((r) => r.ev.skills))].slice(0, 3);
      const ev = pick(opts.short ? 1 : 2);
      if (!ev.length) return { ...base, note: 'Add roles or projects with bullets to your profile so there is something concrete to draw from.' };
      const opener = top.length ? `I'd bring hands-on experience with ${listJoin(top)}.` : 'I would bring the following experience.';
      return finish([opener, ...sentences(ev)], ev);
    }

    case 'work_experience': {
      // The two most relevant roles, each with its best one or two bullets.
      const byRole = new Map<string, Ranked[]>();
      for (const r of ranked) if (r.ev.kind === 'experience') byRole.set(r.ev.id, [...(byRole.get(r.ev.id) ?? []), r]);
      const roles = [...byRole.values()].sort((a, b) => b.slice(0, 2).reduce((s, x) => s + x.score, 0) - a.slice(0, 2).reduce((s, x) => s + x.score, 0)).slice(0, opts.short ? 1 : 2);
      const ev = roles.flatMap((r) => r.slice(0, 2).map((x) => x.ev));
      if (!ev.length) return { ...base, note: 'Your profile has no roles with bullets yet. Add your experience in the Profile tab.' };
      return finish(sentences(ev), ev);
    }

    default: {
      const ev = ranked.filter((r) => r.score >= 2).slice(0, 2).map((r) => r.ev);
      if (!ev.length) return { ...base, note: 'Nothing in your résumé clearly answers this. Write it yourself, and tick “Remember” to reuse it.' };
      return finish(sentences(ev), ev, 'Built from the résumé bullets closest to the question. Check it answers what was asked.');
    }
  }
}

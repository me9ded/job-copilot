import type {
  ComponentScore,
  DealBreaker,
  ExtractedJob,
  MatchResult,
  MatchWeights,
  Preferences,
  Profile,
  RelevantItem,
  Salary,
  Seniority,
  SkillHit,
} from '../types';
import { hash, normalizeForCompare, nowIso, uniq } from '../util';
import {
  analyzeJob,
  analyzeProfile,
  EDUCATION_LABEL,
  SENIORITY_LABEL,
  SENIORITY_RANK,
  type JobAnalysis,
  type ProfileAnalysis,
} from './analysis';
import { containsSkill, extractSkills, familyOf, getBaseMatchers } from './skills';
import { TAXONOMY_VERSION } from './taxonomy';

export interface MatchInput {
  job: ExtractedJob & { fingerprint: string };
  profile: Profile;
  weights: MatchWeights;
  dealBreakerCap: number;
  /** Precomputed analysis (cached per job fingerprint). Computed if omitted. */
  analysis?: JobAnalysis;
}

export const COMPONENT_LABELS: Record<keyof MatchWeights, string> = {
  requiredSkills: 'Required skills',
  preferredSkills: 'Preferred skills',
  experience: 'Years of experience',
  seniority: 'Seniority',
  location: 'Location & work arrangement',
  education: 'Education',
};

const RELATED_CREDIT = 0.4;

export function matchCacheKey(fingerprint: string, profileVersion: number, weights: MatchWeights, cap: number): string {
  return `${fingerprint}|p${profileVersion}|w${hash(JSON.stringify(weights) + cap)}|t${TAXONOMY_VERSION}`;
}

function hitFor(skill: string, pa: ProfileAnalysis, jobFamilies: Map<string, string[]>): SkillHit | null {
  const evidence = pa.skills.get(skill);
  if (evidence) return { skill, evidence, credit: 1 };
  const fam = familyOf(skill);
  if (fam) {
    const related = jobFamilies.get(fam)?.find((s) => s !== skill);
    if (related) return { skill, evidence: pa.skills.get(related) ?? [], credit: RELATED_CREDIT, relatedVia: related };
  }
  return null;
}

function familiesOf(pa: ProfileAnalysis): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const skill of pa.skills.keys()) {
    const fam = familyOf(skill);
    if (!fam) continue;
    map.set(fam, [...(map.get(fam) ?? []), skill]);
  }
  return map;
}

function annualize(amount: number, period: Salary['period']): number {
  switch (period) {
    case 'hour':
      return amount * 2080;
    case 'day':
      return amount * 260;
    case 'week':
      return amount * 52;
    case 'month':
      return amount * 12;
    default:
      return amount;
  }
}

function userSeniorityLevels(prefs: Preferences, years: number): Seniority[] {
  if (prefs.seniority.length) return prefs.seniority;
  if (years < 1) return ['intern', 'entry'];
  if (years < 3) return ['entry', 'mid'];
  if (years < 6) return ['mid', 'senior'];
  if (years < 9) return ['senior', 'staff'];
  return ['senior', 'staff'];
}

function locationMatches(jobLocation: string, prefs: string[]): boolean {
  const loc = normalizeForCompare(jobLocation);
  if (!loc) return false;
  return prefs.some((p) => {
    const n = normalizeForCompare(p);
    return n.length > 1 && (loc.includes(n) || n.includes(loc));
  });
}

export function computeMatch(input: MatchInput): MatchResult {
  const { job, profile, weights, dealBreakerCap } = input;
  const prefs = profile.preferences;
  const pa = analyzeProfile(profile);
  const ja = input.analysis ?? analyzeJob(job);

  // User-declared skills outside the taxonomy are searched for in the posting at match time.
  const extraRequired: string[] = [];
  const extraPreferred: string[] = [];
  if (pa.custom.length) {
    const reqText = ja.inferredRequirements ? job.descriptionText : job.requiredQualifications.join('\n');
    const prefText = [...job.preferredQualifications, ...job.responsibilities].join('\n');
    for (const m of pa.custom) {
      if (containsSkill(reqText, m)) extraRequired.push(m.name);
      else if (containsSkill(prefText, m)) extraPreferred.push(m.name);
    }
  }
  const required = uniq([...ja.requiredSkills, ...extraRequired]);
  const preferred = uniq([...ja.preferredSkills, ...extraPreferred]).filter((s) => !required.includes(s));

  const fams = familiesOf(pa);
  const requiredMatched: SkillHit[] = [];
  const requiredMissing: string[] = [];
  for (const s of required) {
    const hit = hitFor(s, pa, fams);
    if (hit) requiredMatched.push(hit);
    if (!hit || hit.credit < 1) requiredMissing.push(s);
  }
  const preferredMatched: SkillHit[] = [];
  const preferredMissing: string[] = [];
  for (const s of preferred) {
    const hit = hitFor(s, pa, fams);
    if (hit) preferredMatched.push(hit);
    if (!hit || hit.credit < 1) preferredMissing.push(s);
  }

  const credit = (hits: SkillHit[]) => hits.reduce((sum, h) => sum + h.credit, 0);
  const exactCount = (hits: SkillHit[]) => hits.filter((h) => h.credit === 1).length;

  const dealBreakers: DealBreaker[] = [];
  const components: ComponentScore[] = [];
  const push = (key: keyof MatchWeights, score: number | null, detail: string) =>
    components.push({ key, label: COMPONENT_LABELS[key], score, weight: weights[key], contribution: 0, detail });

  // Required skills
  push(
    'requiredSkills',
    required.length ? credit(requiredMatched) / required.length : null,
    required.length
      ? `${exactCount(requiredMatched)} of ${required.length} required skills found in your profile` +
          (requiredMatched.some((h) => h.credit < 1) ? ' (plus partial credit for related skills)' : '') +
          (ja.inferredRequirements ? '. No explicit requirements section was found, so skills were taken from the whole posting' : '')
      : 'No recognised required skills in the posting',
  );

  // Preferred skills (never a deal-breaker)
  push(
    'preferredSkills',
    preferred.length ? credit(preferredMatched) / preferred.length : null,
    preferred.length
      ? `${exactCount(preferredMatched)} of ${preferred.length} preferred / nice-to-have skills`
      : 'No preferred skills listed',
  );

  // Experience
  if (ja.minYears !== null) {
    const ratio = Math.min(1, pa.years / ja.minYears);
    push('experience', ratio, `Posting asks for ${ja.minYears}+ years; your profile shows about ${pa.years} years`);
    if (ja.minYears - pa.years >= 2)
      dealBreakers.push({
        code: 'experience_gap',
        severity: 'soft',
        message: `Asks for ${ja.minYears}+ years of experience; your listed roles add up to about ${pa.years}.`,
      });
  } else push('experience', null, 'No years-of-experience requirement found');

  // Seniority
  if (ja.seniority) {
    const levels = userSeniorityLevels(prefs, pa.years);
    const jobRank = SENIORITY_RANK[ja.seniority];
    let dist = Math.min(...levels.map((l) => Math.abs(SENIORITY_RANK[l] - jobRank)));
    if (ja.seniority === 'manager' && !levels.includes('manager')) dist = Math.max(dist, 2);
    const score = [1, 0.6, 0.25][dist] ?? 0;
    push(
      'seniority',
      score,
      `Role looks ${SENIORITY_LABEL[ja.seniority].toLowerCase()}; ${prefs.seniority.length ? 'your target' : 'estimated from your experience'}: ${levels.map((l) => SENIORITY_LABEL[l].toLowerCase()).join(', ')}`,
    );
    if (dist >= 2)
      dealBreakers.push({
        code: 'seniority',
        severity: 'soft',
        message: `Seniority (${SENIORITY_LABEL[ja.seniority]}) is well outside your target levels.`,
      });
  } else push('seniority', null, 'Seniority not stated in the title');

  // Location & work arrangement
  const hasLocPrefs = prefs.locations.length > 0 || prefs.workArrangements.length > 0;
  if (hasLocPrefs) {
    const parts: number[] = [];
    const notes: string[] = [];
    if (prefs.workArrangements.length) {
      if (ja.arrangement === 'unknown') {
        parts.push(0.6);
        notes.push('work arrangement not stated');
      } else if ((prefs.workArrangements as string[]).includes(ja.arrangement)) {
        parts.push(1);
        notes.push(`${ja.arrangement} matches your preference`);
      } else if (ja.arrangement === 'remote') {
        parts.push(0.7);
        notes.push('remote (you prefer ' + prefs.workArrangements.join('/') + ')');
      } else {
        parts.push(0);
        notes.push(`${ja.arrangement}, but you prefer ${prefs.workArrangements.join('/')}`);
        dealBreakers.push({
          code: 'arrangement',
          severity: 'hard',
          message: `Work arrangement is ${ja.arrangement}; you only want ${prefs.workArrangements.join(' or ')}.`,
        });
      }
    }
    if (prefs.locations.length && ja.arrangement !== 'remote') {
      if (!job.location) {
        parts.push(0.6);
        notes.push('location not stated');
      } else if (locationMatches(job.location, prefs.locations)) {
        parts.push(1);
        notes.push(`${job.location} is in your preferred locations`);
      } else {
        parts.push(prefs.willingToRelocate ? 0.6 : 0.2);
        notes.push(`${job.location} is outside your preferred locations`);
        dealBreakers.push({
          code: 'location',
          severity: 'soft',
          message: `Located in ${job.location}, outside your preferred locations${prefs.willingToRelocate ? ' (you are open to relocating)' : ''}.`,
        });
      }
    }
    push('location', parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null, notes.join('; ') || 'No location data');
  } else push('location', null, 'Set location and work-arrangement preferences to score this');

  // Education
  if (ja.education) {
    const have = pa.educationLevel;
    const need = ja.education.level;
    const score = have >= need ? 1 : ja.education.orEquivalent ? 0.6 : 0.2;
    push(
      'education',
      score,
      `Posting mentions ${EDUCATION_LABEL[need]}${ja.education.orEquivalent ? ' or equivalent experience' : ''}; your profile: ${EDUCATION_LABEL[have]}`,
    );
    if (have < need && !ja.education.orEquivalent)
      dealBreakers.push({ code: 'education', severity: 'soft', message: `Requires a ${EDUCATION_LABEL[need]} degree, which your profile does not list.` });
  } else push('education', null, 'No degree requirement found');

  // Hard constraints outside the weighted components
  if (ja.sponsorshipUnavailable && prefs.needsSponsorship)
    dealBreakers.push({ code: 'sponsorship', severity: 'hard', message: 'The posting says visa sponsorship is not available, and you need sponsorship.' });
  if (ja.clearanceRequired)
    dealBreakers.push({ code: 'clearance', severity: 'soft', message: 'The posting mentions a security clearance requirement.' });
  const haystack = `${job.title}\n${job.descriptionText}`.toLowerCase();
  for (const kw of prefs.excludedKeywords) {
    const k = kw.trim().toLowerCase();
    if (k.length > 1 && haystack.includes(k))
      dealBreakers.push({ code: `excluded:${k}`, severity: 'hard', message: `Contains your excluded keyword “${kw.trim()}”.` });
  }
  if (prefs.minSalary && job.salary) {
    const top = job.salary.max ?? job.salary.min;
    const sameCurrency = !job.salary.currency || !prefs.salaryCurrency || job.salary.currency.toUpperCase() === prefs.salaryCurrency.toUpperCase();
    if (top && sameCurrency && annualize(top, job.salary.period) < prefs.minSalary)
      dealBreakers.push({
        code: 'salary',
        severity: 'hard',
        message: `Listed pay tops out below your minimum of ${prefs.minSalary.toLocaleString()} ${prefs.salaryCurrency}.`,
      });
  }

  // Weighted total over applicable components (weights of n/a components are redistributed).
  const applicable = components.filter((c) => c.score !== null && c.weight > 0);
  const totalWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  for (const c of applicable) c.contribution = totalWeight ? ((c.score ?? 0) * c.weight * 100) / totalWeight : 0;
  const rawScore = Math.round(applicable.reduce((sum, c) => sum + c.contribution, 0));
  const hasHard = dealBreakers.some((d) => d.severity === 'hard');
  const score = hasHard ? Math.min(rawScore, dealBreakerCap) : rawScore;

  const relevant = rankRelevant(profile, [...required, ...preferred]);
  const suggestions = buildSuggestions(profile, pa, requiredMatched, requiredMissing, preferredMissing, ja, job.title);

  const result: MatchResult = {
    score,
    rawScore,
    capped: hasHard && rawScore > dealBreakerCap,
    components,
    requiredMatched,
    requiredMissing,
    preferredMatched,
    preferredMissing,
    dealBreakers,
    relevant,
    suggestions,
    inferredRequirements: ja.inferredRequirements,
    explanation: '',
    cacheKey: matchCacheKey(job.fingerprint, profile.version, weights, dealBreakerCap),
    computedAt: nowIso(),
  };
  result.explanation = explain(result, totalWeight);
  return result;
}

export function rankRelevant(profile: Profile, jobSkills: string[]): RelevantItem[] {
  if (!jobSkills.length) return [];
  const wanted = new Set(jobSkills);
  const items: RelevantItem[] = [];
  const matchers = getBaseMatchers();
  for (const e of profile.experience) {
    const matched = extractSkills([e.title, ...e.bullets].join('\n'), matchers).filter((s) => wanted.has(s));
    if (matched.length) items.push({ kind: 'experience', id: e.id, label: [e.title, e.company].filter(Boolean).join(' at '), matchedSkills: matched });
  }
  for (const p of profile.projects) {
    const matched = extractSkills([p.name, p.description, p.skills.join(', '), ...p.bullets].join('\n'), matchers).filter((s) => wanted.has(s));
    if (matched.length) items.push({ kind: 'project', id: p.id, label: p.name || 'Untitled project', matchedSkills: matched });
  }
  return items.sort((a, b) => b.matchedSkills.length - a.matchedSkills.length).slice(0, 5);
}

function buildSuggestions(
  profile: Profile,
  pa: ProfileAnalysis,
  matched: SkillHit[],
  missing: string[],
  preferredMissing: string[],
  ja: JobAnalysis,
  title: string,
): string[] {
  const out: string[] = [];
  const undeclared = matched.filter((h) => h.credit === 1 && !pa.declared.has(h.skill)).map((h) => h.skill);
  if (undeclared.length)
    out.push(`Add ${undeclared.slice(0, 5).join(', ')} to your skills section — your experience already mentions ${undeclared.length > 1 ? 'them' : 'it'}.`);
  const onlyListed = matched.filter((h) => h.credit === 1 && h.evidence.length === 1 && h.evidence[0] === 'Skills section').map((h) => h.skill);
  if (onlyListed.length)
    out.push(`Back up ${onlyListed.slice(0, 4).join(', ')} with a concrete bullet in an experience or project, if you have used ${onlyListed.length > 1 ? 'them' : 'it'} for real work.`);
  const related = matched.filter((h) => h.credit < 1 && h.relatedVia);
  for (const h of related.slice(0, 3))
    out.push(`The posting asks for ${h.skill}; you list ${h.relatedVia}. Mention transferable experience honestly rather than claiming ${h.skill}.`);
  const trulyMissing = missing.filter((s) => !related.some((r) => r.skill === s));
  if (trulyMissing.length)
    out.push(
      `Missing required: ${trulyMissing.slice(0, 6).join(', ')}. If you genuinely have this experience, add it; otherwise address the gap in your cover letter or a small project.`,
    );
  if (preferredMissing.length && !trulyMissing.length)
    out.push(`Nice-to-haves you could strengthen: ${preferredMissing.slice(0, 5).join(', ')}.`);
  const titleWords = normalizeForCompare(title).split(' ').filter((w) => w.length > 3);
  const headline = normalizeForCompare(`${profile.basics.headline} ${profile.basics.summary}`);
  if (titleWords.length && headline && !titleWords.some((w) => headline.includes(w)))
    out.push(`Your headline/summary doesn't reflect the “${title}” role. Consider a truthful, role-aligned summary.`);
  if (!profile.basics.summary) out.push('Add a short professional summary — the tailored résumé uses it as the opening section.');
  if (ja.injectionSuspected)
    out.push('This posting contains text that looks like instructions to AI tools. It is treated as data only and never followed.');
  return out;
}

function explain(r: MatchResult, totalWeight: number): string {
  if (!totalWeight) return 'Not enough information in the posting or your profile to compute a meaningful score.';
  const parts: string[] = [];
  const req = r.components.find((c) => c.key === 'requiredSkills');
  if (req?.score !== null && req) parts.push(req.detail);
  const pref = r.components.find((c) => c.key === 'preferredSkills');
  if (pref && pref.score !== null) parts.push(pref.detail);
  for (const key of ['experience', 'seniority', 'location', 'education'] as const) {
    const c = r.components.find((x) => x.key === key);
    if (c && c.score !== null && c.score < 1) parts.push(c.detail);
  }
  let text = `${r.score}/100. ${parts.join('. ')}.`;
  if (r.capped) text += ` Capped from ${r.rawScore} because of a deal-breaker.`;
  return text.replace(/\.\./g, '.');
}

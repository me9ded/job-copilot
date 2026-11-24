import { findSkillDef } from './matching/taxonomy';
import { bulletRelevance } from './resume/tailor';
import type { ExtractedJob, MatchResult, PrepItem, ResumeContent } from './types';
import { uid } from './util';

const TECH_TEMPLATES: Record<string, string[]> = {
  language: ['Walk me through a non-trivial piece of {s} code you wrote. What would you change now?', 'What {s} pitfalls have bitten you in production, and how did you fix them?'],
  frontend: ['How do you structure state and data fetching in a {s} application?', 'How do you diagnose and fix a slow {s} page?'],
  backend: ['Describe a service you built with {s}. How did you handle failures and retries?', 'How would you design an API for this team using {s}?'],
  database: ['How do you design a {s} schema for a new feature? How do you plan migrations?', 'Tell me about a slow {s} query you optimised.'],
  cloud: ['Which {s} services have you used in production, and how did you control cost and security?'],
  devops: ['How have you used {s} in a deployment pipeline? What broke and how did you recover?'],
  data: ['Describe an analysis or pipeline you built with {s}. How did you validate the results?'],
  ml: ['Walk me through a model or AI feature you shipped with {s}. How did you evaluate it?'],
  testing: ['How do you decide what to cover with {s}, and how do you keep tests reliable?'],
  security: ['How have you applied {s} in your work? Give a concrete example.'],
  design: ['Show me a project where {s} shaped the outcome. What trade-offs did you make?'],
  default: ['Tell me about a time you used {s}. What was the result?'],
};

const BEHAVIORAL: Array<[string, string]> = [
  ['Tell me about a time you disagreed with a teammate or stakeholder. What happened?', 'Shows collaboration and how you handle conflict.'],
  ['Describe a project that failed or slipped. What did you learn?', 'Shows ownership and reflection.'],
  ['Tell me about a time you had to deliver with unclear requirements.', 'Shows how you handle ambiguity.'],
  ['Give an example of prioritising competing deadlines.', 'Shows judgement under pressure.'],
  ['What accomplishment are you most proud of, and why?', 'Lets you lead with your strongest story.'],
];

const ASK_THEM = [
  'What does success look like in this role after six months?',
  'What are the biggest challenges the team is facing right now?',
  'How does the team plan, review and ship work?',
  'How is feedback given, and what does growth look like here?',
  'What is the interview process from here, and what is the timeline?',
];

function evidenceFor(profile: ResumeContent, skills: string[], text = ''): string[] {
  const req = new Set(skills);
  const kw = new Set(text.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
  return profile.experience
    .flatMap((e) => e.bullets.map((b) => ({ b: `${e.title || e.company}: ${b}`, s: bulletRelevance(b, req, new Set(), kw) })))
    .concat(profile.projects.flatMap((p) => p.bullets.map((b) => ({ b: `${p.name}: ${b}`, s: bulletRelevance(b, req, new Set(), kw) }))))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 2)
    .map((x) => x.b);
}

/** Deterministic interview prep built from the posting and the user's own experience. */
export function buildPrep(job: ExtractedJob, profile: ResumeContent, match: MatchResult | null): PrepItem[] {
  const items: PrepItem[] = [];
  const add = (category: PrepItem['category'], question: string, why: string, suggestedEvidence: string[] = []) =>
    items.push({ id: uid('q'), category, question, why, suggestedEvidence, notes: '', practiced: false, source: 'template' });

  const matched = (match?.requiredMatched ?? []).filter((h) => h.credit === 1).map((h) => h.skill);
  for (const skill of matched.slice(0, 6)) {
    const cat = findSkillDef(skill)?.category ?? 'default';
    const templates = TECH_TEMPLATES[cat] ?? TECH_TEMPLATES.default!;
    add('technical', templates[0]!.replace('{s}', skill), `${skill} is a stated requirement and appears in your profile.`, evidenceFor(profile, [skill]));
  }

  for (const r of job.responsibilities.slice(0, 5)) {
    const clean = r.replace(/[.;]+$/, '');
    const lc = /^[A-Z][a-z]/.test(clean) ? clean[0]!.toLowerCase() + clean.slice(1) : clean;
    add('role', `Tell me about a time you had to ${lc.replace(/^(you will|you'll|will)\s+/i, '')}.`, 'Taken from the responsibilities in the posting.', evidenceFor(profile, [], r));
  }

  const gaps = (match?.requiredMissing ?? []).slice(0, 4);
  for (const g of gaps)
    add('gap', `The role asks for ${g}. How would you get productive with it quickly?`, 'A likely probe on a requirement your profile does not show. Answer honestly and point to related experience.', evidenceFor(profile, match?.requiredMatched.filter((h) => h.relatedVia && h.skill === g).map((h) => h.relatedVia!) ?? []));

  for (const [q, why] of BEHAVIORAL) add('behavioral', q, `${why} Structure it as Situation, Task, Action, Result.`, evidenceFor(profile, matched));
  for (const q of ASK_THEM) add('ask', q, 'A question for you to ask the interviewer.');
  add('research', `Research ${job.company || 'the company'}: product, customers, recent news and competitors.`, 'Preparation checklist.');
  add('research', `Re-read the posting for “${job.title}” and map each requirement to a story from your experience.`, 'Preparation checklist.');
  return items;
}

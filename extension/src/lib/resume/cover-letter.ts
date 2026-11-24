import { totalYears } from '../matching/analysis';
import type { ExtractedJob, MatchResult, ResumeContent } from '../types';
import { bulletRelevance } from './tailor';

export interface CoverLetterOptions {
  /** Mention missing requirements candidly (off by default). */
  addressGaps: boolean;
  tone: 'warm' | 'concise';
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function asClause(bullet: string): string {
  const b = bullet.trim().replace(/[.;]+$/, '');
  // "Built X" → "built X"; leave acronyms ("AWS migration…") untouched.
  return /^[A-Z][a-z]/.test(b) ? b[0]!.toLowerCase() + b.slice(1) : b;
}

/**
 * Template-based cover letter. Every factual statement is copied from the
 * profile (titles, employers, bullets, matched skills); the job only supplies
 * the company, title and the list of skills to compare against.
 */
export function draftCoverLetter(profile: ResumeContent, job: ExtractedJob, match: MatchResult | null, opts: CoverLetterOptions = { addressGaps: false, tone: 'warm' }): string {
  const company = job.company || 'your team';
  const title = job.title || 'this role';
  const years = Math.floor(totalYears(profile.experience));
  const matched = (match?.requiredMatched ?? []).filter((h) => h.credit === 1).map((h) => h.skill);
  const required = new Set([...(match?.requiredMatched.map((h) => h.skill) ?? []), ...(match?.requiredMissing ?? [])]);
  const preferred = new Set(match?.preferredMatched.map((h) => h.skill) ?? []);

  const evidence = profile.experience
    .flatMap((e) => e.bullets.map((b) => ({ e, b, s: bulletRelevance(b, required, preferred, new Set()) })))
    .sort((a, b) => b.s - a.s)
    .slice(0, 2);

  const paragraphs: string[] = [];
  paragraphs.push(`Dear ${company === 'your team' ? 'Hiring Team' : `${company} Hiring Team`},`);

  const intro = profile.basics.headline
    ? `I'm a ${profile.basics.headline.replace(/^(a|an)\s+/i, '')}${years >= 1 ? ` with ${years}+ years of experience` : ''}`
    : years >= 1
      ? `I bring ${years}+ years of professional experience`
      : 'I am excited to bring my experience';
  paragraphs.push(
    opts.tone === 'concise'
      ? `I'm applying for the ${title} role at ${company}. ${intro}.`
      : `I'm writing to apply for the ${title} position at ${company}. ${intro}, and the work described in this posting lines up closely with what I've been doing.`,
  );

  if (evidence.length) {
    const sentences = evidence.map(({ e, b }, i) => {
      const where = [e.title, e.company].filter(Boolean).join(' at ');
      return i === 0 ? `As ${where}, I ${asClause(b)}.` : `I also ${asClause(b)}${e.company && e.company !== evidence[0]!.e.company ? ` at ${e.company}` : ''}.`;
    });
    paragraphs.push(sentences.join(' '));
  }

  if (matched.length) paragraphs.push(`My background includes ${list(matched.slice(0, 6))}, which ${matched.length > 1 ? 'are' : 'is'} central to this role.`);

  const project = profile.projects[0];
  if (project?.name && opts.tone === 'warm') {
    const detail = project.bullets[0] ? `, where I ${asClause(project.bullets[0])}` : '';
    paragraphs.push(`Outside of my day-to-day work, I built ${project.name}${detail}.`);
  }

  const gaps = match?.requiredMissing.filter((s) => !match.requiredMatched.some((h) => h.skill === s)) ?? [];
  if (opts.addressGaps && gaps.length)
    paragraphs.push(`I don't yet have direct professional experience with ${list(gaps.slice(0, 3))}, and I'm ready to ramp up on ${gaps.length > 1 ? 'them' : 'it'} quickly.`);

  paragraphs.push(
    opts.tone === 'concise'
      ? 'Thank you for your consideration. I would welcome the chance to talk.'
      : `Thank you for considering my application. I'd welcome the opportunity to discuss how I could contribute to ${company}.`,
  );
  paragraphs.push(`Sincerely,\n${profile.basics.name || '[Your name]'}`);
  return paragraphs.join('\n\n');
}

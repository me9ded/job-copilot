import type { MatchResult } from '../types';

/**
 * Plain-language "reasons to consider applying" and "potential weaknesses",
 * derived only from the deterministic match. It describes how the posting's
 * stated requirements line up with the profile; it is not a hiring forecast.
 */
export interface FitSummary {
  reasons: string[];
  weaknesses: string[];
}

const list = (xs: string[], n = 4) => {
  const shown = xs.slice(0, n);
  const more = xs.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
};

export function fitSummary(match: MatchResult): FitSummary {
  const reasons: string[] = [];
  const weaknesses: string[] = [];
  const comp = (key: string) => match.components.find((c) => c.key === key);

  const exact = match.requiredMatched.filter((h) => h.credit >= 1).map((h) => h.skill);
  const related = match.requiredMatched.filter((h) => h.credit < 1);
  const reqTotal = match.requiredMatched.length + match.requiredMissing.length;
  if (reqTotal > 0) {
    const covered = match.requiredMatched.length;
    if (covered / reqTotal >= 0.6) reasons.push(`You have ${covered} of the ${reqTotal} required skills${exact.length ? `: ${list(exact)}` : ''}.`);
    else if (exact.length) reasons.push(`You already have ${list(exact)} from the required skills.`);
  }
  for (const r of related.slice(0, 2)) reasons.push(`${r.skill} is required; your ${r.relatedVia ?? 'related'} experience is transferable.`);
  if (match.preferredMatched.length) reasons.push(`Nice-to-haves you cover: ${list(match.preferredMatched.map((h) => h.skill))}.`);
  const top = match.relevant[0];
  if (top) reasons.push(`Most relevant on your résumé: ${top.label}${top.matchedSkills.length ? ` (${list(top.matchedSkills, 3)})` : ''}.`);
  const exp = comp('experience');
  if (exp?.score !== null && exp?.score !== undefined && exp.score >= 0.99) reasons.push(exp.detail);
  const loc = comp('location');
  if (loc?.score !== null && loc?.score !== undefined && loc.score >= 0.99 && loc.detail) reasons.push(loc.detail);

  if (match.requiredMissing.length) weaknesses.push(`Required skills not on your résumé: ${list(match.requiredMissing, 6)}.`);
  for (const d of match.dealBreakers) weaknesses.push(d.message);
  if (match.preferredMissing.length && !match.requiredMissing.length) weaknesses.push(`Nice-to-haves you don't list: ${list(match.preferredMissing)}.`);
  if (match.inferredRequirements) weaknesses.push('The posting has no clear requirements list, so skills were read from the whole description. Check it yourself.');

  return { reasons: dedupe(reasons), weaknesses: dedupe(weaknesses) };
}

const dedupe = (xs: string[]) => [...new Set(xs.filter(Boolean))];

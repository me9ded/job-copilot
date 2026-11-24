/**
 * Splits plain-text job descriptions into responsibilities / required /
 * preferred lists using heading cues. Pure string logic so it can run in the
 * content script, the service worker (discovery) and tests.
 */

type SectionKind = 'responsibilities' | 'required' | 'preferred' | 'other';

const HEADINGS: Array<[SectionKind, RegExp]> = [
  ['preferred', /\b(preferred|nice[- ]to[- ]haves?|bonus( points)?|pluses|plus if|good to have|desired|desirable|extra credit|it would be great if|you might also have|even better|stand out)\b/i],
  [
    'required',
    /\b(requirements?|qualifications?|what you('ll)? (need|bring)|what you have|what we('re| are) looking for|who you are|about you|you have|you should have|must[- ]haves?|skills( and| &) experience|your (skills|background|experience)|minimum|basic qualifications|you('ll)? bring|we('d| would) love|ideal candidate|experience (and|&) skills|key skills|skills required)\b/i,
  ],
  [
    'responsibilities',
    /\b(responsibilities|what you('ll)? do|what you will do|the role|your role|in this role|your impact|day[- ]to[- ]day|duties|key accomplishments|you will|you'll|what you('ll)? work on|the opportunity|your mission|job description)\b/i,
  ],
  ['other', /\b(benefits|perks|about (us|the company|the team)|compensation|salary|pay( range| transparency)?|base pay|equal opportunity|eeo|why join|our (values|culture)|how to apply|interview process|location|accommodations?|privacy)\b/i],
];

const BULLET = /^\s*(?:[•●▪◦‣∙·\-–*]|\d{1,2}[.)])\s+/;

const STOPWORDS = new Set(
  'a an the and & of our your you we what who to in for this with will are is be about at on some any -– — / + if'.split(' '),
);

/**
 * A line is a heading when it is short and either ends with ":" or consists
 * mostly (≥70%) of heading vocabulary — so "What You'll Do" is a heading but
 * "You will design APIs" is not.
 */
function isHeading(line: string): SectionKind | null {
  const l = line.trim();
  if (!l || l.length > 80) return null;
  if (/[.!?]$/.test(l) && !/:$/.test(l)) return null;
  if (BULLET.test(l)) return null;
  const words = Array.from(l.matchAll(/[^\s:]+/g));
  if (words.length > 10) return null;

  let kind: SectionKind | null = null;
  const covered: Array<[number, number]> = [];
  for (const [k, re] of HEADINGS) {
    for (const m of l.matchAll(new RegExp(re.source, 'gi'))) {
      covered.push([m.index, m.index + m[0].length]);
      kind ??= k;
    }
  }
  if (!kind) return null;
  if (l.endsWith(':')) return kind;
  const coveredWords = words.filter(
    (w) => STOPWORDS.has(w[0].toLowerCase()) || covered.some(([a, b]) => w.index < b && w.index + w[0].length > a),
  ).length;
  return coveredWords / words.length >= 0.7 ? kind : null;
}

export interface Sections {
  responsibilities: string[];
  required: string[];
  preferred: string[];
  /** True when at least one recognised heading was found. */
  structured: boolean;
}

function cleanItem(line: string): string {
  return line.replace(BULLET, '').trim();
}

export function splitSections(text: string): Sections {
  const out: Sections = { responsibilities: [], required: [], preferred: [], structured: false };
  let current: SectionKind | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    // "Requirements: 5+ years of Go" — a heading followed by inline content.
    const colon = line.indexOf(':');
    const lead = colon > 0 && colon < 60 ? line.slice(0, colon + 1) : line;
    const heading = isHeading(lead);
    if (heading) {
      current = heading;
      out.structured = true;
      const inline = lead === line ? '' : line.slice(colon + 1).trim();
      if (inline.length > 1 && current !== 'other') out[current].push(inline);
      continue;
    }
    if (!current || current === 'other') continue;
    const item = cleanItem(line);
    if (item.length < 2) continue;
    // Within a requirements list, explicitly optional items are preferred.
    if (current === 'required' && /\b(nice[- ]to[- ]have|preferred|a plus|bonus|ideally)\b/i.test(item)) out.preferred.push(item);
    else out[current].push(item);
  }
  for (const k of ['responsibilities', 'required', 'preferred'] as const) out[k] = out[k].slice(0, 80);
  return out;
}

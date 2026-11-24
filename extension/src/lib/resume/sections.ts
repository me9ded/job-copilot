/**
 * Résumé section detector: finds headings ("EXPERIENCE", "Work History:",
 * "E D U C A T I O N", "Relevant Coursework") and splits the text into
 * sections. Lines before the first heading are the preamble (name, contact).
 */

export type SectionKey =
  | 'summary'
  | 'experience'
  | 'volunteer'
  | 'education'
  | 'projects'
  | 'skills'
  | 'certifications'
  | 'languages'
  | 'awards'
  | 'coursework'
  | 'publications'
  | 'activities'
  | 'interests'
  | 'references';

export interface ResumeSection {
  key: SectionKey | 'preamble';
  /** The heading as written. */
  heading: string;
  lines: string[];
}

const PATTERNS: Array<[SectionKey, RegExp]> = [
  ['summary', /^(summary|professional summary|career summary|executive summary|summary of qualifications|qualifications summary|profile|professional profile|personal profile|career profile|profile summary|about( me)?|objective|career objective|professional objective|overview|introduction|personal statement)$/],
  ['volunteer', /^(volunteer(ing)?( (experience|work|activities))?|community (involvement|service|engagement)|volunteer (and|&) (leadership|community)( experience)?)$/],
  [
    'experience',
    /^((work|professional|relevant|industry|technical|engineering|research|teaching|internship|career|employment|related|software|selected|other) )*(experience|experiences)$|^(employment( history)?|work history|career history|professional background|positions held|internships?|research|work( (and|&) (leadership|research|volunteer))? experience|experience (and|&) (leadership|internships))$/,
  ],
  ['education', /^(education( (and|&) (training|certifications?|qualifications))?|academic (background|history|qualifications|credentials)|academics|educational (background|history|qualifications)|formal education)$/],
  ['coursework', /^((relevant|selected|key|related) )?(coursework|course work|courses taken)$|^relevant courses$/],
  [
    'projects',
    /^((personal|selected|academic|side|key|technical|course|school|university|class|software|engineering|independent|capstone|notable|relevant|research|open[- ]source|other) )*projects?( (and|&) (research|publications|hackathons))?$|^capstone( project)?$/,
  ],
  [
    'skills',
    /^((technical|core|key|relevant|computer|it|professional|soft|hard|additional|other|programming|software|transferable|digital) )?(skills|competencies|proficiencies|expertise|abilities)( (and|&) (abilities|expertise|qualifications|tools|technologies|interests|competencies|certifications))?$|^(skills summary|summary of skills|areas of expertise|core competencies|technologies|tech stack|technical stack|tools( (and|&) technologies)?|toolbox|technical (summary|expertise|proficiency)|skill set|skillset)$/,
  ],
  ['certifications', /^(certifications?|licen[sc]es( (and|&) certifications?)?|certificates?|certifications? (and|&) (licen[sc]es|training|courses|awards)|professional (development|certifications?|training)|courses|training( (and|&) certifications?)?|online courses)$/],
  ['languages', /^(languages?|language skills|spoken languages|language proficiency)$/],
  [
    'awards',
    /^(awards?( (and|&) (honou?rs|achievements|recognitions?|scholarships|certifications))?|honou?rs( (and|&) (awards|achievements))?|achievements|accomplishments|key achievements|recognitions?|scholarships?( (and|&) awards)?|distinctions|competitions)$/,
  ],
  ['publications', /^(publications?|papers|research( (and|&) publications)?|patents?|presentations|conferences?)$/],
  [
    'activities',
    /^(extra-?curricular( activities)?|activities|leadership( (and|&) (activities|involvement|service))?|leadership( experience)?|involvement|campus involvement|affiliations|memberships?|professional (affiliations|memberships)|clubs( (and|&) organi[sz]ations)?|organi[sz]ations)$/,
  ],
  ['interests', /^(interests|hobbies( (and|&) interests)?|personal interests|interests (and|&) hobbies)$/],
  ['references', /^(references?( available( up)?on request)?)$/],
];

/** The same patterns with spaces removed, for headings written in spaced capitals ("W O R K  E X P E R I E N C E"). */
const SQUASHED = PATTERNS.map(([k, re]) => [k, new RegExp(re.source.replace(/ /g, ''))] as const);

/** Strips decoration around a possible heading. */
export function cleanHeading(line: string): string {
  return line
    .replace(/\s*\((?:cont(?:inued|'d|’d)?\.?)\)\s*$|\s+cont(?:inued|'d|’d|\.)\s*$/i, '')
    .replace(/^[^\p{L}]+/u, '')
    .replace(/[\s:|_•·\-–—=*#.]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function headingKey(line: string): SectionKey | null {
  const clean = cleanHeading(line);
  if (!clean || clean.length > 50) return null;
  const lower = clean.toLowerCase();
  // "W O R K E X P E R I E N C E": single letters separated by spaces.
  if (/^(\p{L} )+\p{L}$/u.test(clean)) {
    const squashed = lower.replace(/ /g, '');
    for (const [key, re] of SQUASHED) if (re.test(squashed)) return key;
    return null;
  }
  if (clean.split(' ').length > 6) return null;
  for (const [key, re] of PATTERNS) if (re.test(lower)) return key;
  return null;
}

/** "Languages: English, French" → the label's section and the content after it. */
function inlineHeading(line: string): { key: SectionKey; heading: string; rest: string } | null {
  const m = line.match(/^([\p{L}][\p{L} &/]{1,38}?)\s*[:：]\s*(.+)$/u);
  if (!m) return null;
  const key = headingKey(m[1]!);
  return key ? { key, heading: m[1]!.trim(), rest: m[2]!.trim() } : null;
}

/** List-like sections whose labelled lines ("Languages: …") are moved out of the header, summary or skills. */
const ROUTABLE = new Set<SectionKey>(['skills', 'languages', 'certifications', 'awards', 'interests', 'coursework']);

export function splitSections(lines: string[]): ResumeSection[] {
  const out: ResumeSection[] = [{ key: 'preamble', heading: '', lines: [] }];
  let current = out[0]!;
  for (const line of lines) {
    const key = headingKey(line);
    if (key) {
      current = { key, heading: cleanHeading(line), lines: [] };
      out.push(current);
      continue;
    }
    // A labelled line in the header, summary or skills ("Skills: Python, Go", "Languages: English, French").
    if (current.key === 'preamble' || current.key === 'summary' || current.key === 'skills') {
      const inline = inlineHeading(line);
      if (inline && inline.key !== current.key && ROUTABLE.has(inline.key)) {
        out.push({ key: inline.key, heading: inline.heading, lines: [inline.rest] });
        // Later skills lines continue after the routed one, keeping document order.
        if (current.key === 'skills') {
          current = { key: 'skills', heading: current.heading, lines: [] };
          out.push(current);
        }
        continue;
      }
    }
    current.lines.push(line);
  }
  return out.filter((s) => s.key === 'preamble' || s.lines.length || s.heading);
}

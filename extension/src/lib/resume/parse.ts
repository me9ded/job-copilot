import { ResumeContent, type Education, type Experience, type Project } from '../types';
import { normalizeWhitespace, uid, uniq } from '../util';
import { inferEmploymentType } from '../profile/organize';

/**
 * Heuristic résumé text → structured profile. Output is always shown to the
 * user for review; nothing is invented — every field comes from the text.
 */

type SectionKey = 'summary' | 'experience' | 'education' | 'projects' | 'skills' | 'certifications' | 'other';

const SECTION_PATTERNS: Array<[SectionKey, RegExp]> = [
  ['summary', /^(summary|professional summary|career summary|profile|professional profile|about( me)?|objective|career objective)$/i],
  ['experience', /^((work|professional|relevant|industry) )?(experience|employment( history)?|work history|career history)$/i],
  ['education', /^(education|academic background|education (and|&) training|academics)$/i],
  ['projects', /^((personal|selected|academic|side|key|technical|course|school|university|class|software|engineering|independent|capstone) )?projects?$|^capstone( project)?$/i],
  ['skills', /^((technical|core|key|relevant) )?(skills|competencies)( (and|&) (tools|technologies|interests))?$|^(technologies|tech stack|tools|toolbox)$/i],
  ['certifications', /^(certifications?|licen[sc]es( (and|&) certifications)?|certificates|courses)$/i],
  ['other', /^(extra-?curricular( activities)?|awards|honou?rs|publications|volunteer(ing)?( experience)?|languages|interests|activities|references|leadership( experience)?|achievements)$/i],
];

const BULLET_RE = /^\s*(?:[•●▪◦‣∙·\-–*]|\d{1,2}[.)])\s+/;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
const DATE = `(?:${MONTH}\\s+\\d{4}|\\d{1,2}\\/\\d{4}|\\d{4})`;
const RANGE_RE = new RegExp(`(${DATE})\\s*(?:-|–|—|to|until)\\s*(${DATE}|present|current|now|today)`, 'i');
const SINGLE_DATE_RE = new RegExp(`\\b(${MONTH}\\s+\\d{4}|\\d{1,2}\\/\\d{4}|(?:19|20)\\d{2})\\b`, 'i');
const TITLE_WORDS =
  /\b(engineer|developer|programmer|manager|analyst|designer|intern|lead|consultant|specialist|scientist|director|coordinator|associate|administrator|architect|officer|assistant|technician|researcher|teacher|tutor|accountant|representative|strategist|writer|editor|founder|owner|head|vp|president|advisor|instructor|nurse|clerk|operator|co-?op|student|trainee|apprentice|fellow|ambassador|volunteer|tester|mentor)\b/i;
const COMPANY_WORDS =
  /\b(inc|ltd|llc|llp|corp|corporation|company|group|technologies|labs?|systems|solutions|bank|agency|gmbh|plc|limited|partners|consulting|ventures|university|college|hospital)\b/i;
const INSTITUTION_WORDS = /\b(university|college|institute|school|academy|polytechnic|université|universidad|conservatory|cégep|cegep|bootcamp)\b/i;
const DEGREE_WORDS =
  /\b(bachelor|master|b\.?\s?sc|m\.?\s?sc|b\.?s\.?|m\.?s\.?|b\.?a\.?|m\.?a\.?|b\.?eng|m\.?eng|mba|ph\.?d|doctorate|diploma|associate|certificate|advanced diploma|high school|degree|btech|mtech)\b/i;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function normalizeDate(raw: string | undefined): string {
  if (!raw) return '';
  const v = raw.trim().toLowerCase();
  if (/present|current|now|today/.test(v)) return 'present';
  let m = v.match(/^([a-z]{3})[a-z]*\.?\s+(\d{4})$/);
  if (m && MONTHS[m[1]!]) return `${m[2]}-${String(MONTHS[m[1]!]).padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[2]}-${m[1]!.padStart(2, '0')}`;
  m = v.match(/^(\d{4})$/);
  return m ? m[1]! : '';
}

function headingKey(line: string): SectionKey | null {
  const clean = line.replace(/[:|_•\-–—]+$/g, '').replace(/^[^A-Za-z]+/, '').trim();
  if (!clean || clean.length > 45 || clean.split(/\s+/).length > 5) return null;
  for (const [key, re] of SECTION_PATTERNS) if (re.test(clean)) return key;
  return null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/;
const URL_RE = /\b(?:https?:\/\/)?(?:www\.)?(?:linkedin\.com\/in\/[\w-]+|github\.com\/[\w-]+|gitlab\.com\/[\w-]+|[\w-]+\.(?:dev|io|me|com|ca|net|org)\/?[\w/-]*)\b/gi;

interface Block {
  header: string[];
  bullets: string[];
}

/** Groups lines into entries: header lines followed by bullet lines (with wrapped-line repair). */
function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (BULLET_RE.test(line)) {
      cur ??= { header: [], bullets: [] };
      if (!blocks.includes(cur)) blocks.push(cur);
      cur.bullets.push(line.replace(BULLET_RE, '').trim());
      continue;
    }
    const prevBullet = cur?.bullets[cur.bullets.length - 1];
    const next = lines[i + 1] ?? '';
    const looksLikeContinuation =
      prevBullet !== undefined &&
      !RANGE_RE.test(line) &&
      (/^[a-z(]/.test(line) || (!/[.!?]$/.test(prevBullet) && !RANGE_RE.test(next) && !TITLE_WORDS.test(line) && line.length < 90));
    if (looksLikeContinuation && cur) {
      cur.bullets[cur.bullets.length - 1] = `${prevBullet} ${line}`;
      continue;
    }
    if (!cur || cur.bullets.length) {
      cur = { header: [], bullets: [] };
      blocks.push(cur);
    }
    cur.header.push(line);
  }
  return blocks.filter((b) => b.header.length || b.bullets.length);
}

function splitHeader(text: string): string[] {
  return text
    .split(/\s+[|•·]\s+|\s+[–—-]\s+|\s+at\s+|\s{3,}|\t/)
    .map((s) => s.replace(/^[,;\s]+|[,;\s]+$/g, ''))
    .filter(Boolean);
}

/** Removes the first date range. `dateLine` is the index in `rest` of the text that shared a line with it (-1 if none). */
function takeDates(lines: string[]): { start: string; end: string; rest: string[]; dateLine: number } {
  let start = '';
  let end = '';
  let dateLine = -1;
  const rest: string[] = [];
  for (const line of lines) {
    const m = line.match(RANGE_RE);
    if (m && !start) {
      start = normalizeDate(m[1]);
      end = normalizeDate(m[2]);
      const stripped = line
        .replace(m[0], '')
        .replace(/\(\s*\)/g, '')
        .replace(/[(|,–—-]\s*$/g, '')
        .replace(/^\s*[|,–—-]/, '')
        .trim();
      if (stripped) {
        dateLine = rest.length;
        rest.push(stripped);
      }
    } else rest.push(line);
  }
  return { start, end, rest, dateLine };
}

const LOCATION_RE = /^(remote|hybrid|[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2,}[a-zA-Z ]*)$/;

interface HeaderPart {
  text: string;
  line: number;
  /** The whole "Title, Team" text this part was split from, if any. */
  whole?: string;
}

/** Splits header lines into parts, remembering which line each came from. */
function headerParts(rest: string[], extraSplit?: RegExp): HeaderPart[] {
  return rest.flatMap((line, i) =>
    splitHeader(line)
      .flatMap((p) => (extraSplit ? p.split(extraSplit).map((x) => x.trim()).filter(Boolean) : [p]))
      .map((text) => ({ text, line: i })),
  );
}

function parseExperience(lines: string[]): Experience[] {
  const out: Experience[] = [];
  // True while the current employer was written on its own line ("Company | City" above "Title | Dates"),
  // so a following block with only "Title | Dates" is another role at the same employer.
  let employerLine = false;
  for (const b of toBlocks(lines)) {
    if (!b.header.length) continue;
    const { start, end, rest, dateLine } = takeDates(b.header);
    const prev = out[out.length - 1];
    if (prev?.company && employerLine && start && rest.length === 1) {
      const only = headerParts(rest).filter((p) => !LOCATION_RE.test(p.text)).map((p) => p.text).join(', ');
      const lead = only.split(', ')[0] ?? '';
      if (TITLE_WORDS.test(lead) && !COMPANY_WORDS.test(only)) {
        out.push({ id: uid('exp'), title: only, company: prev.company, location: prev.location, start, end, employmentType: inferEmploymentType(only), bullets: b.bullets });
        continue;
      }
    }
    employerLine = rest.length > 1;
    // "Software Engineer, Globex" → title + company (but keep "Toronto, ON" intact).
    const parts = headerParts(rest).flatMap((p): HeaderPart[] => {
      const i = p.text.indexOf(', ');
      if (i < 0 || LOCATION_RE.test(p.text)) return [p];
      const left = p.text.slice(0, i);
      const right = p.text.slice(i + 2);
      return TITLE_WORDS.test(left) && !TITLE_WORDS.test(right) ? [{ ...p, text: left, whole: p.text }, { ...p, text: right, whole: p.text }] : [p];
    });
    const loc = parts.find((p) => LOCATION_RE.test(p.text) && !TITLE_WORDS.test(p.text));
    const candidates = parts.filter((p) => p !== loc);
    // Title-ness: title words, company words, and layout. In two-line headers the
    // title usually shares a line with the dates and the company with the location
    // ("Title ⇥ Dates / Company ⇥ City, ST" or "Company ⇥ City, ST / Title ⇥ Dates").
    const titleness = (p: HeaderPart) =>
      (TITLE_WORDS.test(p.text) ? 2 : 0) -
      (COMPANY_WORDS.test(p.text) ? 2 : 0) +
      (rest.length > 1 && p.line === dateLine ? 1 : 0) -
      (rest.length > 1 && loc && p.line === loc.line ? 1 : 0);
    let title = '';
    let company = '';
    if (candidates.length === 1) {
      const only = candidates[0]!.text;
      if (TITLE_WORDS.test(only) && !COMPANY_WORDS.test(only)) title = only;
      else company = only;
    } else if (candidates.length > 1) {
      // On a tie, the later part is the title ("Globex | Platform team" stays company-first).
      const t = candidates.reduce((best, p) => (titleness(p) >= titleness(best) ? p : best));
      const c = candidates.filter((p) => p !== t).reduce((best, p) => (titleness(p) < titleness(best) ? p : best));
      // "Co-op Student, Platform Team" above "Company | City": the team stays part of the title.
      title = t.whole && c.whole !== t.whole ? t.whole : t.text;
      company = c.text;
    }
    if (title || company || b.bullets.length) {
      out.push({ id: uid('exp'), title, company, location: loc?.text ?? '', start, end, employmentType: inferEmploymentType(title), bullets: b.bullets });
    }
  }
  return out;
}

function parseEducation(lines: string[]): Education[] {
  return toBlocks(lines)
    .filter((b) => b.header.length)
    .map((b) => {
      const { start, end, rest } = takeDates(b.header);
      let institution = '';
      let degree = '';
      let field = '';
      const details: string[] = [];
      const unassigned: string[] = [];
      for (const { text: p } of headerParts(rest, /;\s+|,\s+(?=(?:c?gpa|grade)\b)/i)) {
        if (/\b(gpa|cgpa|grade|honou?rs? list|dean'?s list)\b/i.test(p)) details.push(p);
        else if (LOCATION_RE.test(p)) continue;
        else if (!institution && INSTITUTION_WORDS.test(p)) institution = p;
        else if (!degree && DEGREE_WORDS.test(p)) {
          const m = p.match(/^(.*?)\s+(?:in|of)\s+(.+)$/i);
          if (m) {
            degree = m[1]!.trim();
            field = m[2]!.trim();
          } else {
            const [d, ...f] = p.split(',');
            degree = d!.trim();
            field = f.join(',').trim();
          }
        } else unassigned.push(p);
      }
      // Unlabelled programs ("Computer Engineering Technology – Computing Science").
      if (!institution) institution = unassigned.shift() ?? '';
      if (!degree) degree = unassigned.shift() ?? '';
      if (!field && unassigned.length) field = unassigned.shift()!;
      let endDate = end;
      if (!start && !endDate) {
        const single = b.header.join(' ').match(SINGLE_DATE_RE);
        if (single) endDate = normalizeDate(single[1]);
      }
      return { id: uid('edu'), institution, degree, field, start, end: endDate, details: [...details, ...b.bullets] };
    })
    .filter((e) => e.institution || e.degree);
}

/** Marks where a projects heading said what kind of projects follow ("Academic Projects"). */
const KIND_MARK = '\u0000kind:';
const ACADEMIC_RE = /\b(course(work)?|capstone|thesis|dissertation|university|college|semester|class project|school project|final[- ]year|senior design|lab assignment|academic)\b/i;

function headingProjectKind(heading: string): Project['kind'] {
  if (/academic|course|school|university|class|capstone/i.test(heading)) return 'academic';
  if (/personal|side|independent/i.test(heading)) return 'personal';
  return '';
}

function parseProjects(lines: string[]): Project[] {
  const out: Project[] = [];
  let kind: Project['kind'] = '';
  let chunk: string[] = [];
  const flush = () => {
    for (const b of toBlocks(chunk)) {
      const { start, end, rest } = takeDates(b.header);
      const headerText = rest.join(' | ');
      const [name = '', ...others] = headerText.split(/\s+[|–—-]\s+|:\s+/);
      const isContext = (o: string) => /\bproject\b|\bteam of\b|\b(solo|individual|hackathon)\b/i.test(o) && !/[\w-]+\.[a-z]{2,}\//i.test(o);
      const context = others.filter(isContext);
      const tech = others.filter((o) => !isContext(o)).join(', ');
      const urls = headerText.match(URL_RE) ?? [];
      const text = [headerText, ...b.bullets].join('\n');
      const p: Project = {
        id: uid('proj'),
        name: name.replace(URL_RE, '').trim(),
        description: context.join('; '),
        url: urls[0] ?? '',
        bullets: b.bullets,
        skills: tech ? splitSkills(tech) : [],
        kind: kind || (ACADEMIC_RE.test(text) ? 'academic' : ''),
        start,
        end,
      };
      if (p.name || p.bullets.length) out.push(p);
    }
    chunk = [];
  };
  for (const l of lines) {
    if (l.startsWith(KIND_MARK)) {
      flush();
      kind = l.slice(KIND_MARK.length) as Project['kind'];
    } else chunk.push(l);
  }
  flush();
  return out;
}

/** Splits a skills list, keeping "Assembly (x86-64, AArch64)" together. */
function splitSkills(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let from = 0;
  const parts: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if (depth === 0 && /[,;•·|]/.test(ch)) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  for (const part of parts) out.push(...(/[([]/.test(part) ? [part] : part.split(/\s{2,}|\band\b(?=\s)/)));
  return out.map((s) => s.replace(BULLET_RE, '').trim()).filter((s) => s.length > 0 && s.length <= 50);
}

function parseSkills(lines: string[]): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(BULLET_RE, '');
    // "Languages: Python, Go" → drop the category label
    const body = /^[^:]{2,30}:\s*/.test(line) ? line.replace(/^[^:]{2,30}:\s*/, '') : line;
    out.push(...splitSkills(body));
  }
  return uniq(out);
}

export interface ParsedResume {
  content: ResumeContent;
  warnings: string[];
}

export function parseResumeText(text: string): ParsedResume {
  const lines = normalizeWhitespace(text)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const warnings: string[] = [];
  const sections: Record<SectionKey | 'preamble', string[]> = {
    preamble: [],
    summary: [],
    experience: [],
    education: [],
    projects: [],
    skills: [],
    certifications: [],
    other: [],
  };
  let current: SectionKey | 'preamble' = 'preamble';
  for (const line of lines) {
    const key = headingKey(line);
    if (key) {
      current = key;
      if (key === 'projects') sections.projects.push(KIND_MARK + headingProjectKind(line));
    } else sections[current].push(line);
  }

  const joined = lines.join('\n');
  const email = joined.match(EMAIL_RE)?.[0] ?? '';
  const phone = sections.preamble.join(' ').match(PHONE_RE)?.[0] ?? '';
  const links = uniq((sections.preamble.join(' ').match(URL_RE) ?? []).filter((u) => !u.includes('@') && !email.endsWith(u)));

  const isContact = (l: string) => EMAIL_RE.test(l) || PHONE_RE.test(l) || (l.match(URL_RE)?.join('').length ?? 0) > l.length * 0.5;
  const pre = sections.preamble.filter((l) => !isContact(l));
  const nameLine = pre.find((l) => l.split(/\s+/).length <= 5 && /^[\p{L}][\p{L} .'-]+$/u.test(l));
  const afterName = pre.filter((l) => l !== nameLine);
  const headline = afterName.find((l) => l.length <= 90 && !/[.]$/.test(l)) ?? '';
  const locationLine = sections.preamble.find((l) => /\b[A-Z][a-z]+,\s*[A-Z]{2}\b/.test(l));
  const location = locationLine?.match(/\b[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2}\b/)?.[0] ?? '';
  const summary = sections.summary.join(' ') || afterName.filter((l) => l !== headline && l.length > 90).join(' ');

  const content = ResumeContent.parse({
    basics: { name: nameLine ?? '', headline, email, phone, location, links, summary },
    skills: parseSkills(sections.skills),
    experience: parseExperience(sections.experience),
    education: parseEducation(sections.education),
    projects: parseProjects(sections.projects),
    certifications: sections.certifications.map((l) => l.replace(BULLET_RE, '').trim()).filter(Boolean),
  });

  if (!nameLine) warnings.push('Could not find your name — please add it.');
  if (!sections.experience.length) warnings.push('No “Experience” section was recognised. Add your roles manually or check the headings in your file.');
  if (!sections.skills.length) warnings.push('No “Skills” section was recognised.');
  if (content.experience.some((e) => !e.start)) warnings.push('Some roles have no dates; years of experience will be undercounted until you add them.');
  return { content, warnings };
}

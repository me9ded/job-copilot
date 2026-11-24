import { parseLocation } from '../geo';
import { extractSkills } from '../matching/skills';
import { findSkillDef } from '../matching/taxonomy';
import { inferEmploymentType } from '../profile/organize';
import { ResumeContent, type Education, type Experience, type Project } from '../types';
import { normalizeWhitespace, uid, uniq } from '../util';
import { headingKey, splitSections, type ResumeSection, type SectionKey } from './sections';

/**
 * Résumé parser: heuristic text → structured profile. The output is always
 * shown for review before anything is saved. Nothing is invented: every value
 * comes from the text, and bullets keep the résumé's own wording.
 */

const BULLET_RE = /^\s*(?:[•●▪◦‣∙·\-–*►▸➢✓✔]|\d{1,2}[.)])\s+/;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const SEASON = '(?:spring|summer|fall|autumn|winter)';
const YEAR = '(?:19|20)\\d{2}';
const DATE = `(?:\\b${MONTH}\\.?,?\\s*(?:${YEAR}|['’]\\d{2})\\b|\\b${SEASON},?\\s+${YEAR}\\b|\\b${YEAR}[-/.](?:0?[1-9]|1[0-2])\\b|\\b(?:0?[1-9]|1[0-2])[-/.]${YEAR}\\b|\\b${YEAR}\\b)`;
const NOW = '(?:present|current(?:ly)?|now|today|ongoing|date)\\b';
const RANGE_RE = new RegExp(`(${DATE})\\s*(?:-|–|—|‒|―|\\bto\\b|\\buntil\\b|\\btill\\b|\\bthrough\\b|\\bthru\\b|→|~)\\s*(${DATE}|${NOW})`, 'i');
const SINGLE_DATE_RE = new RegExp(`(${DATE})`, 'i');
const TITLE_WORDS =
  /\b(engineer|developer|programmer|manager|analyst|designer|intern|lead|consultant|specialist|scientist|director|coordinator|associate|administrator|architect|officer|assistant|technician|researcher|teacher|tutor|accountant|representative|strategist|writer|editor|founder|owner|head|vp|president|advisor|instructor|nurse|clerk|operator|co-?op|student|trainee|apprentice|fellow|ambassador|volunteer|tester|mentor|cashier|server|supervisor|agent|counsel(?:l?or)?|professor|lecturer|chef|driver|auditor|economist|recruiter|planner|paralegal|pharmacist|therapist|electrician|mechanic|machinist|welder|bookkeeper)\b/i;
const COMPANY_WORDS =
  /\b(inc|ltd|llc|llp|corp|corporation|company|group|technologies|labs?|systems|solutions|bank|agency|gmbh|plc|limited|partners|consulting|ventures|university|college|hospital|s\.?a\.?r?\.?l?|studio|studios|foundation|institute|ministry|government|department)\b/i;
const INSTITUTION_WORDS = /\b(university|college|institute|school|academy|polytechnic|université|universidad|universität|conservatory|cégep|cegep|bootcamp|faculty|école|ecole|lycée|lycee)\b/i;
const DEGREE_WORDS =
  /\b(bachelor'?s?|master'?s?|b\.?\s?sc|m\.?\s?sc|b\.?s\.?|m\.?s\.?|b\.?a\.?|m\.?a\.?|b\.?eng|m\.?eng|b\.?a\.?sc|mba|ph\.?d|doctorate|diploma|associate'?s?|certificate|advanced diploma|high school|degree|btech|mtech|b\.?tech|m\.?tech|licen[cs]e|licence|baccalaur[ée]at|ing[ée]nieur|engineering degree|dec|aec|ged)\b/i;

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SEASONS: Record<string, number> = { winter: 1, spring: 4, summer: 6, fall: 9, autumn: 9 };
const pad = (n: number) => String(n).padStart(2, '0');

function fullYear(y: string): string {
  if (/^\d{4}$/.test(y)) return y;
  const yy = Number(y.replace(/\D/g, ''));
  const cutoff = (new Date().getFullYear() % 100) + 5;
  return String(yy <= cutoff ? 2000 + yy : 1900 + yy);
}

/** "Jan 2020", "Summer 2021", "03/2019", "2019-03", "’21", "2020", "Present" → YYYY-MM, YYYY or "present". */
export function normalizeDate(raw: string | undefined): string {
  if (!raw) return '';
  const v = raw
    .trim()
    .toLowerCase()
    .replace(/^(expected|anticipated|est\.?|graduat(?:ed|ing|ion)|class of|since|from)\s*:?\s*/, '');
  if (/\b(present|current(ly)?|now|today|ongoing)\b|^date$/.test(v)) return 'present';
  let m = v.match(/^([a-z]{3})[a-z]*\.?,?\s*(\d{4}|['’]\d{2})$/);
  if (m && MONTHS[m[1]!]) return `${fullYear(m[2]!)}-${pad(MONTHS[m[1]!]!)}`;
  m = v.match(/^(spring|summer|fall|autumn|winter),?\s+(\d{4})$/);
  if (m) return `${m[2]}-${pad(SEASONS[m[1]!]!)}`;
  m = v.match(/^(\d{4})[-/.](\d{1,2})$/);
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${pad(Number(m[2]))}`;
  m = v.match(/^(\d{1,2})[-/.](\d{4})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${pad(Number(m[1]))}`;
  m = v.match(/^(\d{4})$/);
  return m ? m[1]! : '';
}

/* ----------------------------------------------------------------------------
 * Contact details
 * ------------------------------------------------------------------------- */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_LABEL_RE = /\b(tel|phone|mobile|cell|téléphone|telephone|whatsapp)\b|[☎📞📱]/i;
const PHONE_CANDIDATE_RE = /(?:\+\s?\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,4}/g;

/** The first phone number in `text`: international (+…), 10–11 digits, or a shorter local number next to a "Phone" label. */
export function findPhone(text: string): string {
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(PHONE_CANDIDATE_RE)) {
      const s = m[0].trim();
      const digits = s.replace(/\D/g, '');
      if (/^(?:19|20)\d{2}(?:\s*[-–.]\s*(?:19|20)\d{2})?$/.test(s)) continue;
      const intl = s.startsWith('+');
      if ((intl && digits.length >= 8 && digits.length <= 15) || (!intl && digits.length >= 10 && digits.length <= 12) || (digits.length >= 8 && digits.length <= 12 && PHONE_LABEL_RE.test(line))) return s;
    }
  }
  return '';
}

const URL_FIND_RE = /(?:https?:\/\/)?(?:www\.)?(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}(?:\/[^\s|,;()<>"'“”]*)?/gi;
const PROFILE_HOSTS =
  /(^|\.)(linkedin\.com|github\.com|gitlab\.com|bitbucket\.org|behance\.net|dribbble\.com|medium\.com|stackoverflow\.com|kaggle\.com|leetcode\.com|twitter\.com|x\.com|substack\.com|vercel\.app|netlify\.app|github\.io|gitlab\.io|notion\.site|wixsite\.com|carrd\.co|about\.me|codepen\.io|hashnode\.dev|dev\.to|scholar\.google\.com|orcid\.org|researchgate\.net|huggingface\.co|figma\.com|youtube\.com|artstation\.com)$/i;
const SITE_TLDS = /\.(com|ca|io|dev|me|net|org|co|ai|app|tech|site|page|design|xyz|info|uk|fr|de|tn|us|eu|codes|blog|online|space|one|pro|studio)$/i;

/** Web links in `text` (profiles, portfolios, personal sites). E-mail domains and "Node.js"-style names are skipped. */
export function findLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_FIND_RE)) {
    const at = m.index ?? 0;
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    if (text[at - 1] === '@' || text[at + m[0].length] === '@' || text[at - 1] === '.') continue;
    const host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0]!.toLowerCase();
    const explicit = /^(https?:\/\/|www\.)/i.test(raw);
    const known = PROFILE_HOSTS.test(host);
    if (!explicit && !known && (!SITE_TLDS.test(host) || findSkillDef(raw) || findSkillDef(host.split('.')[0]!))) continue;
    // A bare "github.com" or "linkedin.com" identifies nobody.
    if (/(^|\.)(linkedin|github|gitlab)\.com$/.test(host) && !raw.replace(/^https?:\/\//i, '').includes('/')) continue;
    out.push(raw);
  }
  return uniq(out);
}

const SPLIT_PARTS_RE = /\s+[|•·◦]\s+|\s{2,}|\t|\s+[–—]\s+/;

function isContactPart(p: string): boolean {
  return EMAIL_RE.test(p) || !!findPhone(p) || findLinks(p).join('').length > p.length * 0.5;
}

/** "Ottawa, ON" in the header lines, as written. */
function findLocation(lines: string[]): string {
  for (const line of lines) {
    for (const part of line.split(SPLIT_PARTS_RE)) {
      const p = part.replace(/^\s*(location|address|based in)\s*:\s*/i, '').replace(/^[📍⌂]\s*/u, '').trim();
      if (!p || p.length > 60 || p.split(/\s+/).length > 7 || isContactPart(p) || TITLE_WORDS.test(p)) continue;
      const loc = parseLocation(p);
      if (loc.region || (loc.country && (loc.city || /^[\p{L} .'-]+$/u.test(p)))) return p;
    }
  }
  return '';
}

// Short credentials ("MA", "MD") only after a comma, so surnames like "Ma" stay.
const CREDENTIALS_RE =
  /(?:,\s*(?:ph\.?\s?d|mba|m\.?\s?sc|b\.?\s?sc|m\.?\s?eng|b\.?\s?eng|p\.?\s?eng|eit|cpa|cfa|pmp|rn|md|msw|cissp|ccna|m\.?a|b\.?a|b\.?s|m\.?s|mfa|jd|llb|llm|ing)|\s+(?:ph\.?\s?d|mba|p\.?\s?eng|cpa|cfa|pmp|cissp))\.?\s*$/i;

/** The candidate's name: an early header line (or its first part) made of letters, without contact details. */
function findName(pre: string[]): { name: string; line?: string; rest: string[] } {
  const candidates: Array<{ name: string; line: string; rest: string[] }> = [];
  for (const line of pre.slice(0, 5)) {
    const [first = '', ...rest] = line.split(SPLIT_PARTS_RE).map((s) => s.trim());
    let name = first.replace(/^(name\s*:\s*)/i, '');
    for (let i = 0; i < 3 && CREDENTIALS_RE.test(name); i++) name = name.replace(CREDENTIALS_RE, '').trim();
    name = name.replace(/,$/, '').trim();
    const words = name.split(/\s+/).length;
    if (!name || isContactPart(name) || /\d/.test(name) || words > 5) continue;
    if (!/^[\p{L}][\p{L} .'’-]+$/u.test(name) || headingKey(name) || /^(r[ée]sum[ée]|curriculum vitae|cv)$/i.test(name)) continue;
    candidates.push({ name, line, rest });
  }
  const best = candidates.find((c) => c.name.split(/\s+/).length >= 2 && !TITLE_WORDS.test(c.name)) ?? candidates.find((c) => !TITLE_WORDS.test(c.name)) ?? candidates[0];
  return best ?? { name: '', rest: [] };
}

/* ----------------------------------------------------------------------------
 * Entries (roles, schools, projects)
 * ------------------------------------------------------------------------- */

interface Block {
  header: string[];
  bullets: string[];
  /** Explicit "Tech: …" lists. */
  tech: string[];
  /** Explicit "Relevant coursework: …" lists. */
  coursework: string[];
}

const TECH_MARK = '\u0000tech:';
const COURSE_MARK = '\u0000course:';
const KIND_MARK = '\u0000kind:';

const TECH_LINE_RE = /^(?:tech(?:nolog(?:y|ies))?(?: used| stack)?|stack|tools?(?: used)?|(?:technical )?environment|skills(?: used)?|built with|languages?(?: used)?)\s*(?:[:：]|[–—-](?=\s))\s*(.+)$/i;
const LABEL_LINE_RE = /^(?:key )?(?:achievements?|accomplishments|responsibilities|duties|highlights|key contributions|impact|results)\s*(?:[:：]\s*(.+)|[:：]?)$/i;
const COURSE_LINE_RE = /^(?:relevant |selected |key |related )?(?:coursework|course work|courses(?: taken)?)\s*(?:[:：]|[–—-](?=\s))\s*(.+)$/i;

/** Turns "Tech: …" and "Responsibilities:" lines inside a role into markers the block reader understands. */
function prepareEntryLines(lines: string[]): string[] {
  return lines.flatMap((raw) => {
    const line = raw.replace(BULLET_RE, '').trim();
    const tech = line.match(TECH_LINE_RE);
    if (tech) return [TECH_MARK + tech[1]!];
    const course = line.match(COURSE_LINE_RE);
    if (course) return [COURSE_MARK + course[1]!];
    const label = line.match(LABEL_LINE_RE);
    if (label) return label[1] ? [`• ${label[1]}`] : [];
    return [raw];
  });
}

/** Groups lines into entries: header lines followed by bullet lines (with wrapped-line repair). */
function toBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const open = () => {
    cur ??= { header: [], bullets: [], tech: [], coursework: [] };
    if (!blocks.includes(cur)) blocks.push(cur);
    return cur;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith(TECH_MARK)) {
      open().tech.push(...splitList(line.slice(TECH_MARK.length)));
      continue;
    }
    if (line.startsWith(COURSE_MARK)) {
      open().coursework.push(...splitList(line.slice(COURSE_MARK.length)));
      continue;
    }
    if (BULLET_RE.test(line)) {
      open().bullets.push(line.replace(BULLET_RE, '').trim());
      continue;
    }
    const c = cur as Block | null;
    const prevBullet = c?.bullets[c.bullets.length - 1];
    const next = lines[i + 1] ?? '';
    const isRange = RANGE_RE.test(line);
    const nextIsRange = RANGE_RE.test(next) && !next.startsWith(TECH_MARK) && !BULLET_RE.test(next);
    const looksLikeContinuation =
      prevBullet !== undefined &&
      !isRange &&
      (/^[a-z(]/.test(line) || (!/[.!?]$/.test(prevBullet) && !nextIsRange && !TITLE_WORDS.test(line) && line.length < 90));
    if (looksLikeContinuation && c) {
      c.bullets[c.bullets.length - 1] = `${prevBullet} ${line}`;
      continue;
    }
    const dated = !!c && c.header.some((h) => RANGE_RE.test(h));
    // Résumés without bullet characters: in a dated entry, a sentence that doesn't start the next entry is a description line.
    if (c && dated && !isRange && !nextIsRange && isSentence(line)) {
      c.bullets.push(line);
      continue;
    }
    // A second dated header (or the line just above one) starts the next entry.
    if (!c || c.bullets.length || c.tech.length || c.coursework.length || (dated && (isRange || nextIsRange))) {
      cur = { header: [], bullets: [], tech: [], coursework: [] };
      blocks.push(cur);
    }
    cur!.header.push(line);
  }
  return blocks.filter((b) => b.header.length || b.bullets.length);
}

/** A description line rather than a header: a sentence, not "Title | Company" or a place. */
function isSentence(line: string): boolean {
  if (/\s[|•·]\s/.test(line) || isPlace(line)) return false;
  const words = line.split(/\s+/).length;
  return line.length > 60 || /[.!?;]$/.test(line) || (words >= 4 && !(TITLE_WORDS.test(line) && words <= 5) && !COMPANY_WORDS.test(line) && !INSTITUTION_WORDS.test(line) && !DEGREE_WORDS.test(line));
}

function splitHeader(text: string): string[] {
  return text
    .split(/\s+[|•·]\s+|\s+[–—-]\s+|\s+at\s+|\s+@\s+|\s{3,}|\t/)
    .map((s) => s.replace(/^[,;\s]+|[,;\s]+$/g, ''))
    .filter(Boolean);
}

/** Removes the first date range. `dateLine` is the index in `rest` of the text that shared a line with it (-1 if none). */
function takeDates(lines: string[]): { start: string; end: string; rest: string[]; dateLine: number } {
  let start = '';
  let end = '';
  let dateLine = -1;
  const rest: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\b(expected|anticipated)\s+(?=\S*\s*\d{2,4}\b)/gi, '');
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
    } else rest.push(raw);
  }
  return { start, end, rest, dateLine };
}

const LOCATION_RE = /^(remote|hybrid|on-?site|[A-Z][a-zA-Z .'-]+,\s*[A-Z]{2,}[a-zA-Z ]*)$/;
const isPlace = (s: string) => LOCATION_RE.test(s) || (!TITLE_WORDS.test(s) && !COMPANY_WORDS.test(s) && !!(parseLocation(s).region || (parseLocation(s).country && s.split(/\s+/).length <= 3)));

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

/** Technologies of an entry: the explicit lists first, then known skills its text mentions. */
function entrySkills(explicit: string[], text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of [...explicit.filter((x) => x.length <= 40), ...extractSkills(text)]) {
    const k = (findSkillDef(s)?.name ?? s).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

function parseExperience(lines: string[], forceType?: Experience['employmentType']): Experience[] {
  const out: Experience[] = [];
  const make = (title: string, company: string, location: string, start: string, end: string, b: Block): Experience => ({
    id: uid('exp'),
    title,
    company,
    location,
    start,
    end,
    employmentType: forceType ?? inferEmploymentType(title),
    bullets: b.bullets,
    skills: entrySkills(b.tech, [title, ...b.bullets].join('\n')),
  });
  // True while the current employer was written on its own line ("Company | City" above "Title | Dates"),
  // so a following block with only "Title | Dates" is another role at the same employer.
  let employerLine = false;
  for (const b of toBlocks(prepareEntryLines(lines))) {
    if (!b.header.length) {
      // Bullets before any header (or after a stray label) belong to the previous role.
      const prev = out[out.length - 1];
      if (prev) {
        prev.bullets.push(...b.bullets);
        prev.skills = entrySkills([...(prev.skills ?? []), ...b.tech], [prev.title, ...prev.bullets].join('\n'));
      }
      continue;
    }
    const { start, end, rest, dateLine } = takeDates(b.header);
    const prev = out[out.length - 1];
    if (prev?.company && employerLine && start && rest.length === 1) {
      const only = headerParts(rest).filter((p) => !isPlace(p.text)).map((p) => p.text).join(', ');
      const lead = only.split(', ')[0] ?? '';
      if (TITLE_WORDS.test(lead) && !COMPANY_WORDS.test(only)) {
        out.push(make(only, prev.company, prev.location, start, end, b));
        continue;
      }
    }
    employerLine = rest.length > 1;
    // "Software Engineer, Globex" → title + company (but keep "Toronto, ON" intact).
    const parts = headerParts(rest).flatMap((p): HeaderPart[] => {
      const i = p.text.indexOf(', ');
      if (i < 0 || isPlace(p.text)) return [p];
      const left = p.text.slice(0, i);
      const right = p.text.slice(i + 2);
      return TITLE_WORDS.test(left) && !TITLE_WORDS.test(right) ? [{ ...p, text: left, whole: p.text }, { ...p, text: right, whole: p.text }] : [p];
    });
    const loc = parts.find((p) => isPlace(p.text) && !TITLE_WORDS.test(p.text));
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
    if (title || company || b.bullets.length) out.push(make(title, company, loc?.text ?? '', start, end, b));
  }
  return out;
}

const DEGREE_ABBR = /^(b\.?\s?sc\.?|m\.?\s?sc\.?|b\.?\s?eng\.?|m\.?\s?eng\.?|b\.?\s?a\.?\s?sc\.?|b\.?a\.?|m\.?a\.?|b\.?s\.?|m\.?s\.?|ph\.?\s?d\.?|mba|bcs|bba|bcomm?|b\.?\s?tech|m\.?\s?tech)\s+(?:in\s+)?(.+)$/i;

/** "Bachelor of Science in Computer Science" → degree + field. Dates and "(BCS)"-style abbreviations are dropped from the field. */
export function splitDegree(text: string): { degree: string; field: string } {
  const clean = text.replace(new RegExp(SINGLE_DATE_RE.source, 'gi'), '').replace(/[\s,(–—-]+\)?\s*$/, '').trim();
  const tidy = (f: string) => f.replace(/^[\s,:–—-]+/, '').replace(/^\([^)]*\)[\s,:–—-]*/, '').replace(/[\s,]+$/g, '').trim();
  let m = clean.match(/^(.*?)\s+in\s+(.+)$/i);
  if (m && DEGREE_WORDS.test(m[1]!)) return { degree: m[1]!.trim(), field: tidy(m[2]!) };
  m = clean.match(/^((?:bachelor|master|doctor|associate)(?:'?s)?(?: degree)? of (?:science|arts|engineering|applied science|business administration|commerce|fine arts|education|laws|technology|philosophy))\b(.*)$/i);
  if (m) return { degree: m[1]!, field: tidy(m[2]!) };
  m = clean.match(/^(?:bachelor|master|doctor)(?:'?s)? of (.+)$/i);
  if (m) return { degree: clean, field: tidy(m[1]!) };
  m = clean.match(DEGREE_ABBR);
  if (m) return { degree: m[1]!.trim(), field: tidy(m[2]!) };
  const [d = '', ...f] = clean.split(/,|\s[–—-]\s/);
  return { degree: d.trim(), field: tidy(f.join(', ')) };
}

function parseEducation(lines: string[]): Education[] {
  return toBlocks(prepareEntryLines(lines))
    .filter((b) => b.header.length)
    .map((b) => {
      const { start, end, rest } = takeDates(b.header);
      let institution = '';
      let degree = '';
      let field = '';
      const details: string[] = [];
      const unassigned: string[] = [];
      const split = /;\s+|,\s+(?=(?:c?gpa|grade|average)\b)|,\s+(?=[^,]*\b(?:university|college|institute|school|academy|polytechnic|université|universidad|cégep|cegep)\b)/i;
      for (const { text: p } of headerParts(rest, split)) {
        if (/\b(gpa|cgpa|grade|average|honou?rs? list|dean'?s list|distinction|cum laude|with honou?rs)\b/i.test(p)) details.push(p);
        else if (isPlace(p) && !INSTITUTION_WORDS.test(p)) continue;
        else if (!institution && INSTITUTION_WORDS.test(p) && !DEGREE_WORDS.test(p.replace(INSTITUTION_WORDS, ''))) institution = p;
        else if (!degree && DEGREE_WORDS.test(p)) ({ degree, field } = splitDegree(p));
        else if (!institution && INSTITUTION_WORDS.test(p)) institution = p;
        else unassigned.push(p);
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
      const strip = (x: string) => x.replace(new RegExp(SINGLE_DATE_RE.source, 'gi'), '').replace(/[\s,(–—-]+\)?\s*$/, '').trim();
      const e: Education = { id: uid('edu'), institution: strip(institution), degree: strip(degree), field: strip(field), start, end: endDate, details: [...details, ...b.bullets] };
      if (b.coursework.length) e.coursework = uniq(b.coursework);
      return e;
    })
    .filter((e) => e.institution || e.degree);
}

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
    for (const b of toBlocks(prepareEntryLines(chunk))) {
      if (!b.header.length) {
        const prev = out[out.length - 1];
        if (prev) prev.bullets.push(...b.bullets);
        continue;
      }
      const { start, end, rest } = takeDates(b.header);
      const headerText = rest.join(' | ');
      const [name = '', ...others] = headerText.split(/\s+[|–—-]\s+|:\s+/);
      const isContext = (o: string) => /\bproject\b|\bteam of\b|\b(solo|individual|hackathon)\b/i.test(o) && !/[\w-]+\.[a-z]{2,}\//i.test(o);
      const context = others.filter(isContext);
      const tech = others.filter((o) => !isContext(o) && !findLinks(o).length).join(', ');
      const urls = findLinks(headerText);
      const text = [headerText, ...b.bullets].join('\n');
      const cleanName = urls.reduce((n, u) => n.replace(u, ''), name).replace(/\s*[|(]\s*\)?$/, '').trim();
      const p: Project = {
        id: uid('proj'),
        name: cleanName,
        description: context.join('; '),
        url: urls[0] ?? '',
        bullets: b.bullets,
        skills: entrySkills([...(tech ? splitList(tech) : []), ...b.tech], [cleanName, ...b.bullets].join('\n')),
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

/* ----------------------------------------------------------------------------
 * Lists (skills, languages, certifications, awards, …)
 * ------------------------------------------------------------------------- */

/** Splits a comma / bullet separated list, keeping "Assembly (x86-64, AArch64)" together. */
export function splitList(text: string): string[] {
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
  for (const part of parts) out.push(...(/[([]/.test(part) ? [part] : part.split(/\s{2,}|\band\b(?=\s)|\s&\s/)));
  return out.map((s) => s.replace(BULLET_RE, '').replace(/\.$/, '').trim()).filter((s) => s.length > 0 && s.length <= 60);
}

const HUMAN_LANGUAGES = new Set(
  'english french spanish german italian portuguese arabic mandarin chinese cantonese japanese korean hindi urdu bengali punjabi tamil telugu marathi gujarati kannada malayalam russian ukrainian polish dutch swedish norwegian danish finnish greek turkish persian farsi dari pashto hebrew vietnamese thai indonesian malay tagalog filipino swahili amharic somali yoruba igbo hausa romanian hungarian czech slovak serbian croatian bosnian bulgarian albanian armenian georgian kurdish nepali sinhala khmer lao burmese catalan basque galician irish welsh icelandic latvian lithuanian estonian maltese berber tamazight creole haitian latin français francais español espanol deutsch italiano português portugues العربية'.split(
    ' ',
  ),
);

/** "French (professional)", "Arabic – native", "Bilingual English/French" → true. */
export function isHumanLanguage(item: string): boolean {
  const head = item
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/\s[-–—:].*$/, '')
    .replace(/\b(native|fluent|bilingual|professional|working|proficiency|proficient|conversational|intermediate|basic|elementary|beginner|advanced|limited|full|mother tongue|first language|sign language|[abc][12])\b/g, ' ')
    .trim();
  const words = head.split(/[\s/]+/).filter(Boolean);
  return words.length > 0 && words.length <= 3 && words.every((w) => HUMAN_LANGUAGES.has(w) || w === 'american' || w === 'asl');
}

/** Items of a list section: bullets (with wrapped lines joined) or one item per line. */
function listItems(lines: string[]): string[] {
  const out: string[] = [];
  const bullets = lines.some((l) => BULLET_RE.test(l));
  for (const l of lines) {
    const isBullet = BULLET_RE.test(l);
    const text = l.replace(BULLET_RE, '').trim();
    if (!text) continue;
    if (bullets && !isBullet && out.length && /^[a-z(]/.test(text)) out[out.length - 1] += ` ${text}`;
    else out.push(text);
  }
  return out;
}

interface ListOut {
  skills: string[];
  languages: string[];
  certifications: string[];
  awards: string[];
  interests: string[];
  coursework: string[];
}

const emptyLists = (): ListOut => ({ skills: [], languages: [], certifications: [], awards: [], interests: [], coursework: [] });

/** Skills lines, routing labelled lines ("Languages: English, French", "Certifications: …") to their own list. */
function parseSkillLines(lines: string[], into: ListOut): void {
  for (const raw of lines) {
    const line = raw.replace(BULLET_RE, '');
    const m = line.match(/^([^:]{2,32}):\s*(.*)$/);
    const label = m ? m[1]!.trim().toLowerCase() : '';
    const items = splitList(m ? m[2]! : line);
    if (/certif|licen/.test(label)) into.certifications.push(...items);
    else if (/award|honou?r/.test(label)) into.awards.push(...items);
    else if (/interest|hobb/.test(label)) into.interests.push(...items);
    else if (/course/.test(label)) into.coursework.push(...items);
    else if (/^(spoken |human )?languages?( spoken)?$/.test(label) && items.filter(isHumanLanguage).length > items.length / 2) into.languages.push(...items);
    else for (const item of items) (isHumanLanguage(item) && !findSkillDef(item) ? into.languages : into.skills).push(item);
  }
}

/** A "Languages" section: spoken languages, with programming languages sent to skills. */
function parseLanguageLines(lines: string[], into: ListOut): void {
  for (const raw of lines) {
    for (const item of splitList(raw.replace(BULLET_RE, '').replace(/^[^:]{2,32}:\s*/, ''))) {
      if (isHumanLanguage(item)) into.languages.push(item);
      else if (!/^(frameworks?|librar(y|ies)|tools?|databases?|platforms?|other|technologies|programming|scripting)$/i.test(item)) into.skills.push(item);
    }
  }
}

/* ----------------------------------------------------------------------------
 * Whole résumé
 * ------------------------------------------------------------------------- */

export interface ParseIssue {
  /** "basics.email", "experience:<id>", "skills", … */
  path: string;
  /** Not found at all, or found but possibly wrong. */
  level: 'missing' | 'uncertain';
  message: string;
}

export interface ParsedResume {
  content: ResumeContent;
  /** Short notes for the user (also shown when nothing else is). */
  warnings: string[];
  /** What couldn't be found or might be wrong, tied to a field or entry. */
  issues: ParseIssue[];
  /** Text that wasn't imported anywhere, by section, so nothing disappears silently. */
  unrecognized: Array<{ heading: string; lines: string[] }>;
}

const EXTRA_HEADINGS: Partial<Record<SectionKey, string>> = { publications: 'Publications', activities: 'Leadership & activities', interests: 'Interests' };

const dedupe = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter((s) => {
    const k = (findSkillDef(s)?.name ?? s).toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export function parseResumeText(text: string): ParsedResume {
  const all = normalizeWhitespace(text)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^page \d+( of \d+)?$/i.test(l));
  const sections = splitSections(all);
  const preamble = sections.find((s) => s.key === 'preamble')?.lines ?? [];
  const nameInfo = findName(preamble);
  // Page headers repeat the name or contact line at the top of later pages.
  const repeated = new Set([nameInfo.line, ...preamble.filter(isContactLine)].filter((x): x is string => !!x));
  const byKey = (key: SectionKey) => sections.filter((s) => s.key === key).flatMap((s) => s.lines.filter((l) => !repeated.has(l)));
  const of = (key: SectionKey): ResumeSection[] => sections.filter((s) => s.key === key);

  const contactText = [...preamble, ...all.filter((l) => PHONE_LABEL_RE.test(l) || EMAIL_RE.test(l))].join('\n');
  const email = (contactText.match(EMAIL_RE) ?? all.join('\n').match(EMAIL_RE))?.[0] ?? '';
  const phone = findPhone(contactText);
  const links = findLinks(preamble.join('\n')).filter((u) => !email.toLowerCase().endsWith(u.toLowerCase()));
  const location = findLocation(preamble);

  // Header lines not used for the name or contact details: a headline, then a summary.
  const used = new Set<string>();
  const others = preamble.filter((l) => l !== nameInfo.line && !isContactLine(l) && !(location && l.trim() === location));
  const titlePart = nameInfo.rest.find((p) => TITLE_WORDS.test(p) && !isContactPart(p));
  // A headline names a role ("Backend Developer | Cloud"); other short header lines are listed as unrecognised.
  const headline = titlePart ?? others.find((l) => l.length <= 90 && !/[.]$/.test(l) && TITLE_WORDS.test(l) && !l.split(SPLIT_PARTS_RE).every((p) => isContactPart(p) || p.trim() === location)) ?? '';
  if (headline && !titlePart) used.add(headline);
  const summaryLines = byKey('summary');
  const longLines = others.filter((l) => !used.has(l) && l.length > 90);
  const summary = (summaryLines.length ? summaryLines : longLines).join(' ').replace(/\s+/g, ' ').trim();
  for (const l of longLines) used.add(l);

  // List sections are read in document order, so "Languages: …" routed out of Skills keeps its place.
  const lists = emptyLists();
  for (const sec of sections) {
    const lines = sec.lines.filter((l) => !repeated.has(l));
    if (sec.key === 'skills') parseSkillLines(lines, lists);
    else if (sec.key === 'languages') parseLanguageLines(lines, lists);
    else if (sec.key === 'certifications') lists.certifications.push(...listItems(lines));
    else if (sec.key === 'awards') lists.awards.push(...listItems(lines));
    else if (sec.key === 'interests') lists.interests.push(...lines.flatMap((l) => splitList(l)));
    else if (sec.key === 'coursework') lists.coursework.push(...lines.flatMap((l) => splitList(l)));
  }

  const projectLines = of('projects').flatMap((s) => [KIND_MARK + headingProjectKind(s.heading), ...s.lines.filter((l) => !repeated.has(l))]);
  const experience = [...parseExperience(byKey('experience')), ...parseExperience(byKey('volunteer'), 'volunteer')];
  const education = parseEducation(byKey('education'));
  const issues: ParseIssue[] = [];
  if (lists.coursework.length) {
    if (education[0]) education[0].coursework = uniq([...(education[0].coursework ?? []), ...lists.coursework]);
    else issues.push({ path: 'education', level: 'uncertain', message: `Coursework was listed (${lists.coursework.slice(0, 3).join(', ')}…) but no school was found to attach it to.` });
  }

  const extras = (['publications', 'activities', 'interests'] as const).flatMap((key) => {
    const items = key === 'interests' ? lists.interests : listItems(byKey(key));
    return items.length ? [{ heading: of(key)[0]?.heading || EXTRA_HEADINGS[key]!, items }] : [];
  });

  const content = ResumeContent.parse({
    basics: { name: nameInfo.name, headline, email, phone, location, links, summary },
    skills: dedupe(lists.skills),
    experience,
    education,
    projects: parseProjects(projectLines),
    certifications: dedupe(lists.certifications),
    languages: dedupe(lists.languages),
    awards: dedupe(lists.awards),
    extras,
  });

  const warnings: string[] = [];
  if (!nameInfo.name) warnings.push('Could not find your name — please add it.');
  if (!byKey('experience').length) warnings.push('No “Experience” section was recognised. Add your roles manually or check the headings in your file.');
  if (!byKey('skills').length && !content.skills.length) warnings.push('No “Skills” section was recognised.');
  if (content.experience.some((e) => !e.start)) warnings.push('Some roles have no dates; years of experience will be undercounted until you add them.');

  if (!nameInfo.name) issues.push({ path: 'basics.name', level: 'missing', message: 'Name not found.' });
  else if (nameInfo.name.split(/\s+/).length < 2) issues.push({ path: 'basics.name', level: 'uncertain', message: 'Only one word was found for your name; check it.' });
  if (!email) issues.push({ path: 'basics.email', level: 'missing', message: 'Email address not found.' });
  if (!phone) issues.push({ path: 'basics.phone', level: 'missing', message: 'Phone number not found.' });
  if (!location) issues.push({ path: 'basics.location', level: 'missing', message: 'Location (city, province or state) not found.' });
  if (!content.experience.length) issues.push({ path: 'experience', level: 'missing', message: 'No work experience was recognised.' });
  if (!content.education.length) issues.push({ path: 'education', level: 'missing', message: 'No education was recognised.' });
  if (!content.skills.length) issues.push({ path: 'skills', level: 'missing', message: 'No skills were recognised.' });
  for (const e of content.experience) {
    const path = `experience:${e.id}`;
    if (!e.title || !e.company) issues.push({ path, level: 'uncertain', message: `${e.title || e.company || 'A role'}: ${!e.title ? 'job title' : 'company'} not found.` });
    else if (!TITLE_WORDS.test(e.title) && !COMPANY_WORDS.test(e.company)) issues.push({ path, level: 'uncertain', message: `“${e.title}” at “${e.company}”: check that the job title and company aren’t swapped.` });
    if (!e.start) issues.push({ path, level: 'uncertain', message: `${e.title || e.company || 'A role'}: no dates found.` });
    else if (e.end && e.end !== 'present' && e.end < e.start) issues.push({ path, level: 'uncertain', message: `${e.title || e.company}: the end date is before the start date.` });
  }
  for (const e of content.education) {
    const path = `education:${e.id}`;
    if (!e.institution) issues.push({ path, level: 'uncertain', message: `${e.degree}: school not found.` });
    if (!e.degree) issues.push({ path, level: 'uncertain', message: `${e.institution}: degree not found.` });
  }
  for (const p of content.projects) if (!p.name) issues.push({ path: `projects:${p.id}`, level: 'uncertain', message: 'A project has no name.' });

  const unrecognized: ParsedResume['unrecognized'] = [];
  const leftover = others.filter((l) => !used.has(l) && l !== headline && l !== location);
  if (leftover.length) unrecognized.push({ heading: 'Top of the résumé', lines: leftover });
  for (const s of sections) if (s.key === 'references' && s.lines.length) unrecognized.push({ heading: s.heading, lines: s.lines });
  return { content, warnings, issues, unrecognized };
}

/** A header line made only of contact details (email, phone, links, location). */
function isContactLine(line: string): boolean {
  const parts = line.split(SPLIT_PARTS_RE).map((p) => p.trim()).filter(Boolean);
  return parts.length > 0 && parts.some(isContactPart) && parts.every((p) => isContactPart(p) || !!parseLocation(p).region || !!parseLocation(p).country);
}

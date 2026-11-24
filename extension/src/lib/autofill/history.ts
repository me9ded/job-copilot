import { applyAnswer } from './engine/controls';
import { scopedQuestions } from './engine/detect';
import { findQuestions, type Question } from './engine/discover';
import { press } from './engine/interact';
import { degreeValues } from './engine/match';
import { claimed, highlightTarget, mark, ours } from './engine/mark';
import { settle, waitForDom } from './engine/observe';
import { visibleButtons } from './engine/steps';
import { normalize, textOf } from './engine/text';
import { hasValue } from './engine/verify';
import type { FailedField } from './engine/report';
import type { EducationEntry, FillReport, FillRequest, HistoryEntry } from './fill';

/**
 * Repeatable "Work experience" / "Education" sections (Workday, Greenhouse,
 * SmartRecruiters and similar): fills each entry from the profile, pressing
 * the section's "Add" button for more entries, the way a person would. Only
 * values from the user's résumé are used.
 */

type Kind = 'experience' | 'education';
type Role = 'title' | 'company' | 'location' | 'current' | 'description' | 'school' | 'degree' | 'field' | 'start' | 'end';

const MAX_ENTRIES = 8;

const ROLE_RULES: Record<Kind, Array<[Exclude<Role, 'start' | 'end'>, RegExp, RegExp?]>> = {
  experience: [
    ['current', /currently (work|employed)|i (currently )?work here|current (role|job|position|employer)|still work/],
    ['title', /job title|^title$|\btitle\b|position( title)?|role title/, /company|employer|reference/],
    ['company', /company|employer|organi[sz]ation/, /title|description|website|industry/],
    ['location', /location|\bcity\b/],
    ['description', /description|responsibilit|duties|summary|achievements|what did you do/],
  ],
  education: [
    ['school', /school|university|college|institution/, /high school diploma/],
    ['degree', /\bdegree\b|qualification|level of education/, /field|year|date/],
    ['field', /field of study|discipline|\bmajors?\b|area of study|program|specialization/],
  ],
};

const START_RE = /\b(from|start(ed)?|begin)\b/;
const END_RE = /\b(to|end(ed)?|until|graduat\w*|completion|finish)\b/;

/** Nearby text of a control, closest first (labels of date groups sit a few levels up). */
function context(el: Element): string[] {
  const out: string[] = [];
  let n: Element | null = el.parentElement;
  for (let depth = 0; n && depth < 4; depth++, n = n.parentElement) out.push(normalize(textOf(n)).slice(0, 80));
  return out;
}

function roleOf(q: Question, kind: Kind): Role | null {
  const text = q.ds.join(' | ');
  if (q.kind !== 'checkbox') {
    const dateish = q.kind === 'date' || /\b(month|year|mm|yyyy|dates?)\b|date section|(^|\| )(from|to|start|end)( \||$)/.test(text);
    if (dateish) {
      // The closest text that says which end of the range this is ("From" / "To").
      for (const t of [text, ...context(q.el)]) {
        const s = START_RE.exec(t)?.index ?? Infinity;
        const e = END_RE.exec(t)?.index ?? Infinity;
        if (s === Infinity && e === Infinity) continue;
        return s <= e ? 'start' : 'end';
      }
      return null;
    }
  }
  for (const [role, re, not] of ROLE_RULES[kind]) if (q.ds.some((d) => re.test(d) && !not?.test(d))) return role;
  return null;
}

type DatePart = 'month' | 'year' | 'month-year' | 'full';
function datePart(q: Question): DatePart {
  const t = q.ds.join(' ');
  if (q.kind === 'date') return 'full';
  if (/\bmm ?\/ ?yyyy\b|month ?\/ ?year/.test(t)) return 'month-year';
  if (/\bmonth\b|\bmm\b/.test(t)) return 'month';
  if (/\byear\b|\byyyy\b/.test(t)) return 'year';
  // A lone "From" / "Start date" text box: month and year together.
  return 'month-year';
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Values to try for a date field, best first. Empty when the profile date lacks that part. */
function dateValues(value: string, q: Question): string[] {
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(value);
  if (!m) return [];
  const [, year, month] = m;
  switch (datePart(q)) {
    case 'year':
      return [year!];
    case 'month':
      return month ? (q.kind === 'text' ? [month] : [MONTH_NAMES[Number(month) - 1]!, month, String(Number(month))]) : [];
    case 'month-year':
      return month ? [`${month}/${year}`] : [year!];
    case 'full':
      return [month ? `${year}-${month}` : year!];
  }
}

/** Anchor fields that start an entry: a job title, or a school. */
const anchorRole = (kind: Kind): Role => (kind === 'experience' ? 'title' : 'school');

/** One container per entry, in page order. A container holds one anchor and at least two other recognised fields. */
export function findEntries(doc: Document, kind: Kind): Element[] {
  const anchors = scopedQuestions(doc).filter((q) => roleOf(q, kind) === anchorRole(kind));
  const containers: Element[] = [];
  for (const a of anchors) {
    let best: Element | null = null;
    for (let n: Element | null = a.el.parentElement, depth = 0; n && depth < 10; n = n.parentElement, depth++) {
      // Never the whole page: an entry is a part of the form.
      if (n.tagName === 'BODY' || n.tagName === 'HTML') break;
      if (anchors.some((o) => o !== a && n!.contains(o.el))) break;
      best = n;
    }
    if (!best) continue;
    const roles = new Set(findQuestions(best).map((q) => roleOf(q, kind)).filter(Boolean));
    if (roles.size >= 3) containers.push(best);
  }
  return containers;
}

const ADD_RE = /^(\+\s*)?add( another| more| new| an?)?( (work |job |professional )?(experience|history)| job| position| role| employment| education| school| degree)?$/;

/** The "Add" button of a section ("Add Work Experience", or a bare "Add" under a Work Experience heading). */
export function findAddButton(doc: Document, kind: Kind): HTMLElement | null {
  const want = kind === 'experience' ? /experience|employment|work history|job/ : /education|school|degree/;
  const other = kind === 'experience' ? /education|school|degree|language|certific|website/ : /experience|employment|language|certific|website/;
  for (const b of visibleButtons(doc)) {
    const t = normalize(b.textContent || b.getAttribute('aria-label') || '');
    if (!ADD_RE.test(t)) continue;
    const own = `${t} ${normalize(b.getAttribute('aria-label'))}`;
    if (want.test(own)) return b;
    if (other.test(own)) continue;
    // A bare "Add": decide from the nearest heading above it.
    for (let n: Element | null = b.parentElement, depth = 0; n && depth < 5; n = n.parentElement, depth++) {
      const h = n.querySelector('h1, h2, h3, h4, h5, h6, legend, [role=heading]');
      const ht = normalize(h?.textContent);
      if (!ht) continue;
      if (want.test(ht) && !other.test(ht)) return b;
      break;
    }
  }
  return null;
}

async function tryValues(q: Question, values: string[]): Promise<boolean> {
  for (const v of values) if (v && (await applyAnswer(q, v))) return true;
  return false;
}

async function fillEntry(container: Element, kind: Kind, item: HistoryEntry | EducationEntry, req: FillRequest, failed: FailedField[]): Promise<boolean> {
  // Only the entry's own fields are taken; anything else in the container is left to the main pass.
  const qs = findQuestions(container).filter((q) => roleOf(q, kind));
  qs.forEach((q) => {
    claimed.add(q.el);
    q.members.forEach((m) => claimed.add(m));
  });
  const exp = kind === 'experience' ? (item as HistoryEntry) : null;
  const edu = kind === 'education' ? (item as EducationEntry) : null;
  const current = exp?.end === 'present';
  let any = false;
  for (const q of qs) {
    const role = roleOf(q, kind);
    if (!role) continue;
    if (hasValue(q) && !ours.has(q.el) && !req.overwrite) continue;
    if (hasValue(q) && ours.has(q.el)) continue;
    let values: string[] = [];
    if (role === 'current') values = current ? ['yes'] : [];
    else if (role === 'start') values = dateValues(item.start, q);
    else if (role === 'end') values = current ? [] : dateValues(item.end, q);
    else if (role === 'degree') values = edu?.degree ? degreeValues(edu.degree) : [];
    else if (exp) values = [{ title: exp.title, company: exp.company, location: exp.location, description: exp.description }[role as 'title'] ?? ''];
    else if (edu) values = [{ school: edu.school, field: edu.field }[role as 'school'] ?? ''];
    values = values.filter((v) => v && v.trim());
    if (!values.length) continue;
    if (await tryValues(q, values)) {
      ours.add(q.el);
      mark(highlightTarget(q), 'filled');
      any = true;
      // Ticking "I currently work here" usually removes the end-date fields.
      if (role === 'current') await settle(container.ownerDocument, 120, 1200);
    } else {
      // Tried and not kept (or no matching option): said so, never dropped.
      mark(highlightTarget(q), 'failed');
      failed.push({ id: q.id, label: q.label, reason: `“${values[0]}” wasn’t accepted.`, kind: q.kind, required: q.required });
    }
  }
  return any;
}

async function fillSection(doc: Document, kind: Kind, items: Array<HistoryEntry | EducationEntry>, req: FillRequest, report: FillReport): Promise<void> {
  if (!items.length) return;
  let entries = findEntries(doc, kind);
  for (let i = 0; i < Math.min(items.length, MAX_ENTRIES); i++) {
    if (i >= entries.length) {
      const add = findAddButton(doc, kind);
      if (!add) break;
      const before = entries.length;
      press(add);
      await settle(doc, 200, 3000);
      entries = (await waitForDom(doc, () => {
        const e = findEntries(doc, kind);
        return e.length > before ? e : null;
      }, 2500)) ?? entries;
      if (entries.length <= i) break;
    }
    const item = items[i]!;
    const failed: FailedField[] = [];
    const ok = await fillEntry(entries[i]!, kind, item, req, failed);
    for (const f of failed) if (!report.failed!.some((x) => x.id === f.id)) report.failed!.push(f);
    if (ok) {
      const label =
        kind === 'experience'
          ? `Work experience ${i + 1}: ${[(item as HistoryEntry).title, (item as HistoryEntry).company].filter(Boolean).join(' at ')}`
          : `Education ${i + 1}: ${(item as EducationEntry).school}`;
      if (!report.filled.some((f) => f.label === label)) report.filled.push({ label, key: 'history' });
    }
  }
}

/** Fills the work-history and education sections on the current step, if it has any. */
export async function fillHistory(doc: Document, req: FillRequest, report: FillReport): Promise<void> {
  if (!req.history) return;
  await fillSection(doc, 'experience', req.history.experience, req, report);
  await fillSection(doc, 'education', req.history.education, req, report);
}

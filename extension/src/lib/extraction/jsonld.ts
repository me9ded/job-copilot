import type { Salary, WorkArrangement } from '../types';
import { htmlToText, unescapeHtml } from './dom';

type Json = Record<string, unknown>;

export interface JsonLdJob {
  title?: string;
  company?: string;
  location?: string;
  workArrangement?: WorkArrangement;
  employmentType?: string;
  salary?: Salary;
  descriptionHtml?: string;
  descriptionText?: string;
  datePosted?: string;
  validThrough?: string;
  url?: string;
  qualifications?: string;
  responsibilities?: string;
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined);

function isJobPosting(node: Json): boolean {
  const t = node['@type'];
  return t === 'JobPosting' || (Array.isArray(t) && t.includes('JobPosting'));
}

function* walk(node: unknown, depth = 0): Generator<Json> {
  if (depth > 6) return;
  if (Array.isArray(node)) for (const n of node) yield* walk(n, depth + 1);
  else if (isObj(node)) {
    yield node;
    if (node['@graph']) yield* walk(node['@graph'], depth + 1);
    if (isObj(node.mainEntity)) yield* walk(node.mainEntity, depth + 1);
  }
}

/** Finds the first schema.org JobPosting in the document. Malformed blocks are skipped. */
export function findJobPostingNode(doc: Document): Json | null {
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    const raw = script.textContent?.trim();
    if (!raw || raw.length > 2_000_000) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Some sites emit raw newlines inside strings; retry once with them escaped.
      try {
        parsed = JSON.parse(raw.replace(/[\n\r\t]+/g, ' '));
      } catch {
        continue;
      }
    }
    for (const node of walk(parsed)) if (isJobPosting(node)) return node;
  }
  return null;
}

function placeToString(place: unknown): string | undefined {
  if (typeof place === 'string') return place.trim() || undefined;
  if (!isObj(place)) return undefined;
  const addr = place.address;
  if (typeof addr === 'string') return addr.trim() || undefined;
  if (isObj(addr)) {
    const country = isObj(addr.addressCountry) ? str(addr.addressCountry.name) : str(addr.addressCountry);
    const parts = [str(addr.addressLocality), str(addr.addressRegion), country].filter(Boolean);
    return parts.length ? Array.from(new Set(parts)).join(', ') : undefined;
  }
  return str(place.name);
}

function salaryFrom(node: unknown): Salary | undefined {
  if (!isObj(node)) return undefined;
  const value = node.value;
  const currency = str(node.currency);
  const unitMap: Record<string, Salary['period']> = { HOUR: 'hour', DAY: 'day', WEEK: 'week', MONTH: 'month', YEAR: 'year' };
  if (isObj(value)) {
    const min = Number(value.minValue ?? value.value);
    const max = Number(value.maxValue ?? value.value);
    const unit = str(value.unitText)?.toUpperCase();
    if (Number.isFinite(min) || Number.isFinite(max))
      return {
        min: Number.isFinite(min) ? min : undefined,
        max: Number.isFinite(max) ? max : undefined,
        currency,
        period: unit ? unitMap[unit] : undefined,
      };
  } else if (typeof value === 'number') return { min: value, max: value, currency };
  return undefined;
}

export function parseJobPostingNode(node: Json, doc: Document): JsonLdJob {
  const org = node.hiringOrganization;
  const locations = Array.isArray(node.jobLocation) ? node.jobLocation : node.jobLocation ? [node.jobLocation] : [];
  const locText = locations.map(placeToString).filter(Boolean);
  const remote = str(node.jobLocationType)?.toUpperCase() === 'TELECOMMUTE';
  const applicantReqs = Array.isArray(node.applicantLocationRequirements) ? node.applicantLocationRequirements : [node.applicantLocationRequirements];
  const applicantText = applicantReqs.map((r) => (isObj(r) ? str(r.name) : undefined)).filter(Boolean);
  const location = locText.length ? Array.from(new Set(locText)).join(' · ') : remote && applicantText.length ? `Remote (${applicantText.join(', ')})` : remote ? 'Remote' : undefined;

  const descHtml = str(node.description);
  const html = descHtml ? unescapeHtml(descHtml, doc) : undefined;
  const employment = Array.isArray(node.employmentType) ? node.employmentType.map(str).filter(Boolean).join(', ') : str(node.employmentType);

  return {
    title: str(node.title),
    company: isObj(org) ? str(org.name) : str(org),
    location,
    workArrangement: remote ? 'remote' : undefined,
    employmentType: employment?.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
    salary: salaryFrom(node.baseSalary) ?? salaryFrom(node.estimatedSalary),
    descriptionHtml: html,
    descriptionText: html ? htmlToText(html, doc) : undefined,
    datePosted: str(node.datePosted),
    validThrough: str(node.validThrough),
    url: str(node.url),
    qualifications: str(node.qualifications) ?? str(node.experienceRequirements),
    responsibilities: str(node.responsibilities),
  };
}

/** Microdata fallback (itemtype=schema.org/JobPosting), used by some ATS such as SmartRecruiters. */
export function parseMicrodata(doc: Document): JsonLdJob | null {
  const root = doc.querySelector('[itemtype*="schema.org/JobPosting"]');
  if (!root) return null;
  const prop = (name: string) => root.querySelector(`[itemprop="${name}"]`);
  const val = (name: string) => {
    const el = prop(name);
    return (el?.getAttribute('content') ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim() || undefined;
  };
  const descEl = prop('description');
  return {
    title: val('title'),
    company: (() => {
      const org = prop('hiringOrganization');
      return (org?.querySelector('[itemprop="name"]')?.textContent ?? org?.getAttribute('content') ?? org?.textContent ?? '').trim() || undefined;
    })(),
    location: val('jobLocation') ?? val('addressLocality'),
    employmentType: val('employmentType'),
    datePosted: val('datePosted'),
    descriptionHtml: descEl?.innerHTML,
    descriptionText: descEl ? htmlToText(descEl.innerHTML, doc) : undefined,
  };
}

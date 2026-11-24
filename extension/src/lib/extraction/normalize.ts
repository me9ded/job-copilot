import { detectArrangement } from '../matching/analysis';
import type { ExtractedJob, WorkArrangement } from '../types';
import { canonicalizeUrl, normalizeWhitespace, truncate } from '../util';
import { findSalaryInText } from './salary';
import { splitSections } from './sections';

/* DOM-free: used by the content script, manual entry and service-worker discovery. */

export const MIN_DESCRIPTION = 200;

const FIELD_WEIGHTS: Record<string, number> = {
  title: 0.25,
  company: 0.2,
  description: 0.25,
  location: 0.1,
  requirements: 0.1,
  employmentType: 0.04,
  salary: 0.03,
  datePosted: 0.03,
};

export function computeCompleteness(job: Omit<ExtractedJob, 'completeness' | 'missingFields' | 'warnings' | 'adapter'>): {
  completeness: number;
  missingFields: string[];
} {
  const present: Record<string, boolean> = {
    title: !!job.title,
    company: !!job.company,
    description: job.descriptionText.length >= MIN_DESCRIPTION,
    location: !!job.location,
    requirements: job.requiredQualifications.length > 0,
    employmentType: !!job.employmentType,
    salary: !!job.salary,
    datePosted: !!job.datePosted,
  };
  let score = 0;
  const missing: string[] = [];
  for (const [field, w] of Object.entries(FIELD_WEIGHTS)) {
    if (present[field]) score += w;
    else missing.push(field);
  }
  return { completeness: Math.round(score * 100) / 100, missingFields: missing };
}

/**
 * Builds a normalised ExtractedJob from description text + metadata. Shared by
 * page extraction, manual entry and discovery so every path produces the same
 * shape and completeness signal.
 */
export function finalizeJob(input: {
  title?: string;
  company?: string;
  location?: string;
  employmentType?: string;
  arrangementHint?: string;
  workArrangement?: WorkArrangement;
  salary?: ExtractedJob['salary'];
  descriptionText: string;
  descriptionHtml?: string;
  datePosted?: string;
  validThrough?: string;
  url: string;
  applyUrl?: string;
  adapter: string;
  extraQualifications?: string;
  extraResponsibilities?: string;
  warnings?: string[];
}): ExtractedJob {
  const descriptionText = truncate(normalizeWhitespace(input.descriptionText), 100_000);
  const sections = splitSections(descriptionText);
  if (input.extraQualifications) sections.required.push(...splitSections(`Requirements\n${input.extraQualifications}`).required);
  if (input.extraResponsibilities)
    sections.responsibilities.push(...splitSections(`Responsibilities\n${input.extraResponsibilities}`).responsibilities);

  const arrangement =
    input.workArrangement && input.workArrangement !== 'unknown'
      ? input.workArrangement
      : detectArrangement([input.arrangementHint, input.location, input.title, descriptionText.slice(0, 3000)].filter(Boolean).join('\n'));

  const base = {
    title: truncate(normalizeWhitespace(input.title ?? ''), 500),
    company: truncate(normalizeWhitespace(input.company ?? ''), 300),
    location: input.location ? truncate(normalizeWhitespace(input.location), 500) : undefined,
    workArrangement: arrangement,
    employmentType: input.employmentType ? truncate(input.employmentType, 100) : undefined,
    salary: input.salary ?? findSalaryInText(descriptionText),
    descriptionText,
    descriptionHtml: input.descriptionHtml ? truncate(input.descriptionHtml, 200_000) : undefined,
    responsibilities: sections.responsibilities,
    requiredQualifications: sections.required,
    preferredQualifications: sections.preferred,
    datePosted: input.datePosted,
    validThrough: input.validThrough,
    url: canonicalizeUrl(input.url),
    applyUrl: input.applyUrl,
  };
  const { completeness, missingFields } = computeCompleteness(base);
  const warnings = [...(input.warnings ?? [])];
  if (!sections.structured && descriptionText.length >= MIN_DESCRIPTION)
    warnings.push('No requirement headings were recognised; required skills will be inferred from the full text.');
  return { ...base, adapter: input.adapter, completeness, missingFields, warnings };
}


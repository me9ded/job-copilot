import { sanitizeHtml } from '../sanitize';
import type { ExtractedJob } from '../types';
import { canonicalizeUrl } from '../util';
import { adapterFor, type AdapterResult } from './adapters';
import { elementToText, meta } from './dom';
import { findJobPostingNode, parseJobPostingNode, parseMicrodata, type JsonLdJob } from './jsonld';
import { finalizeJob, MIN_DESCRIPTION } from './normalize';
import { parseSalaryText } from './salary';
import { restrictedSiteLabel } from './sites';

export type ExtractionOutcome =
  | { status: 'ok'; job: ExtractedJob }
  | { status: 'not_job'; reason: string }
  | { status: 'restricted'; site: string };

function canonicalUrl(doc: Document, pageUrl: URL, ld: JsonLdJob | null): string {
  const candidates = [doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), meta(doc, 'og:url'), ld?.url];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const u = new URL(c, pageUrl);
      // Only trust canonical links on the same registrable host to avoid spoofed redirects.
      if (u.hostname.replace(/^www\./, '') === pageUrl.hostname.replace(/^www\./, '')) return canonicalizeUrl(u.toString());
    } catch {
      /* ignore malformed canonical */
    }
  }
  return canonicalizeUrl(pageUrl.toString());
}

/** Extracts a job posting from a live (or test) document. Never mutates the page. */
export function extractJobFromDocument(doc: Document, href: string): ExtractionOutcome {
  const restricted = restrictedSiteLabel(href);
  if (restricted) return { status: 'restricted', site: restricted };

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { status: 'not_job', reason: 'Invalid URL' };
  }

  const adapter = adapterFor(url.hostname);
  let dom: AdapterResult = {};
  try {
    dom = adapter.extract(doc, url);
  } catch {
    dom = {};
  }
  if (dom.isJobPage === false) return { status: 'not_job', reason: 'This page is a job list, not a single posting.' };

  const node = findJobPostingNode(doc);
  const ld = node ? parseJobPostingNode(node, doc) : parseMicrodata(doc);
  const warnings: string[] = [];

  const domText = elementToText(dom.descriptionEl);
  const ldText = ld?.descriptionText ?? '';
  // Prefer the richer of the two descriptions; DOM text keeps headings that JSON-LD sometimes flattens.
  const useDom = domText.length > ldText.length * 0.9 && domText.length >= MIN_DESCRIPTION;
  const descriptionText = useDom ? domText : ldText || domText;
  const descriptionHtml = useDom ? dom.descriptionEl?.innerHTML : ld?.descriptionHtml;

  // For non-ATS pages without structured data, require strong signals before claiming a job.
  if (adapter.id === 'generic' && !ld) {
    const looksLikeJob = /\b(responsibilities|requirements|qualifications|apply|what you('ll)? do|about the role)\b/i.test(descriptionText);
    if (!looksLikeJob || descriptionText.length < MIN_DESCRIPTION)
      return { status: 'not_job', reason: 'No job posting found on this page. You can paste the job description manually.' };
    warnings.push('No structured job data on this page; fields were inferred from the page layout. Please review them.');
  }
  if (!descriptionText) return { status: 'not_job', reason: 'Could not find a job description on this page.' };

  const title = ld?.title ?? dom.title;
  const company = ld?.company ?? dom.company ?? meta(doc, 'og:site_name');
  if (!company) warnings.push('Company name was not found. Please add it.');

  const job = finalizeJob({
    title,
    company,
    location: ld?.location ?? dom.location,
    employmentType: ld?.employmentType ?? dom.employmentType,
    arrangementHint: dom.workArrangementText,
    workArrangement: ld?.workArrangement,
    salary: ld?.salary ?? parseSalaryText(dom.salaryText),
    descriptionText,
    descriptionHtml: descriptionHtml ? sanitizeHtml(descriptionHtml) : undefined,
    datePosted: ld?.datePosted,
    validThrough: ld?.validThrough,
    url: canonicalUrl(doc, url, ld),
    applyUrl: dom.applyUrl,
    adapter: ld && adapter.id === 'generic' ? 'jsonld' : adapter.id,
    extraQualifications: ld?.qualifications,
    extraResponsibilities: ld?.responsibilities,
    warnings,
  });
  if (!job.title) return { status: 'not_job', reason: 'Could not identify a job title on this page.' };
  return { status: 'ok', job };
}

import { describe, expect, it } from 'vitest';
import { extractJobFromDocument } from '../../src/lib/extraction/extract';
import { findJobPostingNode } from '../../src/lib/extraction/jsonld';
import { splitSections } from '../../src/lib/extraction/sections';
import { parseSalaryText } from '../../src/lib/extraction/salary';
import { matchesPattern, toCustomSitePattern, restrictedSiteLabel } from '../../src/lib/extraction/sites';
import { fixture, loadDoc } from '../helpers';

describe('page extraction', () => {
  it('extracts a Greenhouse page from semantic DOM without JSON-LD', () => {
    const url = 'https://job-boards.greenhouse.io/acmerobotics/jobs/4001?gh_src=abc&utm_source=x';
    const out = extractJobFromDocument(loadDoc(fixture('greenhouse.html')), url);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const { job } = out;
    expect(job.adapter).toBe('greenhouse');
    expect(job.title).toBe('Senior Backend Engineer');
    expect(job.company).toBe('Acme Robotics');
    expect(job.location).toBe('Toronto, ON (Hybrid)');
    expect(job.workArrangement).toBe('hybrid');
    expect(job.url).toBe('https://job-boards.greenhouse.io/acmerobotics/jobs/4001');
    expect(job.salary).toMatchObject({ min: 150000, max: 180000, currency: 'CAD', period: 'year' });
    expect(job.responsibilities).toContain('Design and build APIs in Python and Go');
    expect(job.requiredQualifications).toContain('Strong Python and PostgreSQL skills');
    // "is a plus" inside requirements is moved to preferred
    expect(job.preferredQualifications).toEqual(expect.arrayContaining(['Kafka experience is a plus', 'Terraform']));
    expect(job.applyUrl).toContain('#app');
    expect(job.completeness).toBeGreaterThan(0.8);
  });

  it('prefers JSON-LD on Lever, decodes escaped HTML and sanitizes it', () => {
    const url = 'https://jobs.lever.co/northwind/1f2e3d4c-aaaa-bbbb-cccc-1234567890ab';
    const out = extractJobFromDocument(loadDoc(fixture('lever-jsonld.html')), url);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    const { job } = out;
    expect(job.company).toBe('Northwind Labs');
    expect(job.workArrangement).toBe('remote');
    expect(job.employmentType).toBe('Full Time');
    expect(job.salary).toMatchObject({ min: 110000, max: 135000, currency: 'CAD', period: 'year' });
    expect(job.validThrough).toBe('2026-12-31');
    expect(job.requiredQualifications[0]).toMatch(/React and TypeScript/);
    expect(job.preferredQualifications).toEqual(['Next.js', 'Playwright']);
    expect(job.descriptionHtml).toBeDefined();
    expect(job.descriptionHtml).not.toMatch(/<script|onerror|<img/i);
    expect(job.descriptionText).not.toMatch(/alert\(/);
    // canonical link with tracking param is stripped
    expect(job.url).toBe(url);
    expect(job.applyUrl).toBe(`${url}/apply`);
  });

  it('skips malformed JSON-LD blocks and finds a JobPosting inside @graph', () => {
    const doc = loadDoc(fixture('career-graph.html'));
    expect(findJobPostingNode(doc)?.title).toBe('Data Analyst');
    const out = extractJobFromDocument(doc, 'https://careers.contoso.example/jobs/42');
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.job.adapter).toBe('jsonld');
    expect(out.job.company).toBe('Contoso');
    expect(out.job.location).toBe('Montreal, QC, CA');
    expect(out.job.employmentType).toBe('Full Time, Contractor');
    expect(out.job.requiredQualifications).toContain('SQL and Excel');
  });

  it('reports not_job for ordinary pages', () => {
    const out = extractJobFromDocument(loadDoc(fixture('not-a-job.html')), 'https://fabrikam.example/blog/post');
    expect(out.status).toBe('not_job');
  });

  it('extracts generic pages heuristically but flags missing structured data', () => {
    const out = extractJobFromDocument(loadDoc(fixture('generic-nojsonld.html')), 'https://tailspin.example/careers/designer');
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.job.title).toBe('Product Designer');
    expect(out.job.company).toBe('Tailspin');
    expect(out.job.workArrangement).toBe('onsite');
    expect(out.job.warnings.join(' ')).toMatch(/No structured job data/);
    expect(out.job.missingFields).toContain('location');
  });

  it('treats Greenhouse board index pages as non-job pages', () => {
    const out = extractJobFromDocument(loadDoc('<html><body><h1>Open roles</h1></body></html>'), 'https://job-boards.greenhouse.io/acme');
    expect(out).toEqual({ status: 'not_job', reason: expect.stringMatching(/job list/) });
  });

  it('refuses restricted sites', () => {
    const out = extractJobFromDocument(loadDoc(fixture('lever-jsonld.html')), 'https://www.linkedin.com/jobs/view/123');
    expect(out).toEqual({ status: 'restricted', site: 'LinkedIn' });
    expect(restrictedSiteLabel('https://ca.indeed.com/viewjob?jk=1')).toBe('Indeed');
  });

  it('handles an empty or broken document without throwing', () => {
    expect(extractJobFromDocument(loadDoc(''), 'https://jobs.lever.co/x/1f2e3d4c-aaaa-bbbb-cccc-1234567890ab').status).toBe('not_job');
    expect(extractJobFromDocument(loadDoc('<html>'), 'not a url').status).toBe('not_job');
  });
});

describe('section splitting', () => {
  it('distinguishes headings from ordinary sentences', () => {
    const s = splitSections(['About the role', 'You will design APIs', 'Requirements:', '- Go', 'Preferred Qualifications', '- Rust'].join('\n'));
    expect(s.responsibilities).toEqual(['You will design APIs']);
    expect(s.required).toEqual(['Go']);
    expect(s.preferred).toEqual(['Rust']);
    expect(s.structured).toBe(true);
  });

  it('keeps inline content after a heading colon', () => {
    const s = splitSections('Requirements: 5+ years building distributed systems');
    expect(s.required).toEqual(['5+ years building distributed systems']);
  });
});

describe('salary parsing', () => {
  it.each([
    ['$120,000 - $150,000 per year', { min: 120000, max: 150000, currency: 'USD', period: 'year' }],
    ['€150K – €250K • Offers Equity', { min: 150000, max: 250000, currency: 'EUR' }],
    ['USD 60-75 per hour', { min: 60, max: 75, currency: 'USD', period: 'hour' }],
  ])('parses %s', (text, expected) => {
    expect(parseSalaryText(text)).toMatchObject(expected);
  });
  it('ignores non-salary ranges', () => {
    expect(parseSalaryText('3-5 years of experience')).toBeUndefined();
  });
});

describe('site patterns', () => {
  it('validates custom site input', () => {
    expect(toCustomSitePattern('careers.example.com/jobs/1')).toBe('https://careers.example.com/*');
    expect(toCustomSitePattern('http://insecure.example.com')).toBeNull();
    expect(toCustomSitePattern('www.linkedin.com')).toBeNull();
    expect(toCustomSitePattern('localhost')).toBeNull();
  });
  it('matches URLs against patterns', () => {
    expect(matchesPattern('https://jobs.lever.co/a/b', 'https://jobs.lever.co/*')).toBe(true);
    expect(matchesPattern('https://evil.example/jobs.lever.co', 'https://jobs.lever.co/*')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { applyUserEdits, createJobRecord, findDuplicate, jaccard, jobFreshness, mergeExtraction } from '../../src/lib/jobs';
import { canonicalizeUrl } from '../../src/lib/util';
import { makeJob } from '../helpers';

const longText = (extra = '') =>
  `We build logistics software for warehouses across North America and Europe. ${'Our platform routes orders, balances inventory and schedules robots in real time. '.repeat(6)}${extra}`;

describe('duplicate detection', () => {
  it('canonicalises tracking parameters, hashes and trailing slashes', () => {
    expect(canonicalizeUrl('https://www.Example.com/jobs/1/?utm_source=li&gh_src=x&b=2&a=1#apply')).toBe('https://example.com/jobs/1?a=1&b=2');
  });

  it('detects duplicates by URL, alias URL, source id, identity and content', () => {
    const a = createJobRecord(makeJob({ url: 'https://example.com/jobs/1', descriptionText: longText() }), 'page');
    const b = createJobRecord(makeJob({ title: 'Platform Engineer', url: 'https://example.com/jobs/2', descriptionText: 'Different' }), 'discovery', {
      sourceId: 'lever:acme',
      sourceJobId: 'abc',
      aliasUrls: ['https://jobs.example.com/abc'],
    });
    const pool = [a, b];
    expect(findDuplicate(makeJob({ url: 'https://example.com/jobs/1?utm_medium=email' }), pool)?.reason).toBe('url');
    expect(findDuplicate(makeJob({ url: 'https://jobs.example.com/abc' }), pool)?.job.id).toBe(b.id);
    expect(findDuplicate({ ...makeJob({ url: 'https://x.example/9', title: 'Renamed' }), sourceId: 'lever:acme', sourceJobId: 'abc' }, pool)?.reason).toBe('source');
    expect(findDuplicate(makeJob({ url: 'https://mirror.example/job' }), pool)?.reason).toBe('identity');
    // Same company, same title, near-identical text, different location string → content duplicate.
    expect(findDuplicate(makeJob({ url: 'https://other.example/1', location: 'Toronto (Hybrid)', descriptionText: longText(' Apply now.') }), pool)?.reason).toBe('content');
    expect(findDuplicate(makeJob({ company: 'Other Co', url: 'https://other.example/2', descriptionText: longText() }), pool)).toBeNull();
  });

  it('computes shingle similarity', () => {
    expect(jaccard(longText(), longText())).toBe(1);
    expect(jaccard(longText(), 'completely unrelated words here and there')).toBeLessThan(0.1);
  });
});

describe('merging and edits', () => {
  it('preserves user-edited fields when a page is re-extracted', () => {
    const original = createJobRecord(makeJob(), 'page');
    const edited = applyUserEdits(original, { company: 'Acme Inc. (corrected)', location: 'Remote' });
    expect(edited.userEditedFields).toEqual(expect.arrayContaining(['company', 'location']));
    const merged = mergeExtraction(edited, makeJob({ company: 'ACME', location: 'Toronto', title: 'Senior Backend Engineer II', url: 'https://example.com/jobs/1?ref=x' }));
    expect(merged.company).toBe('Acme Inc. (corrected)');
    expect(merged.location).toBe('Remote');
    expect(merged.title).toBe('Senior Backend Engineer II');
    expect(merged.lastVerifiedAt).toBeDefined();
  });

  it('records alternate URLs as aliases', () => {
    const job = createJobRecord(makeJob({ url: 'https://example.com/jobs/1' }), 'page');
    const merged = mergeExtraction(job, makeJob({ url: 'https://boards.example.com/acme/1' }));
    expect(merged.aliasUrls).toEqual(['https://boards.example.com/acme/1']);
  });
});

describe('freshness', () => {
  const now = new Date('2026-10-29T12:00:00Z');
  it('marks closed, stale and fresh listings', () => {
    const base = createJobRecord(makeJob(), 'page', { lastVerifiedAt: '2026-10-28T00:00:00Z' });
    expect(jobFreshness(base, 21, now).state).toBe('fresh');
    expect(jobFreshness({ ...base, validThrough: '2026-10-01' }, 21, now).state).toBe('expired');
    expect(jobFreshness({ ...base, lastVerifiedAt: '2026-09-01T00:00:00Z' }, 21, now)).toMatchObject({ state: 'stale' });
    expect(jobFreshness({ ...base, expired: true, expiredReason: 'No longer listed' }, 21, now)).toEqual({ state: 'expired', reason: 'No longer listed' });
  });
});

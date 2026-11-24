import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { runDiscovery } from '../../src/lib/discovery/run';
import { fetchSource, SOURCE_ADAPTERS, titleFilterMatches } from '../../src/lib/discovery/sources';
import { getSettings, listJobs, updateSettings } from '../../src/lib/storage/repo';
import type { DiscoverySource } from '../../src/lib/types';

const greenhouseBody = {
  jobs: [
    {
      id: 101,
      title: 'Backend Engineer',
      absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/101',
      location: { name: 'Remote, Canada' },
      company_name: 'Acme',
      first_published: '2026-10-01T00:00:00Z',
      content: '&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Python and Go&lt;/li&gt;&lt;/ul&gt;&lt;p&gt;Pay: $120,000 - $140,000 USD&lt;/p&gt;',
    },
    { id: 102, title: 'Account Executive', absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/102', content: '' },
    { title: 'missing id' },
  ],
};
const leverBody = [
  {
    id: 'aaa',
    text: 'Data Engineer',
    hostedUrl: 'https://jobs.lever.co/acme/aaa',
    applyUrl: 'https://jobs.lever.co/acme/aaa/apply',
    categories: { location: 'Berlin', commitment: 'Full-time' },
    workplaceType: 'hybrid',
    descriptionPlain: 'Join us.',
    lists: [{ text: 'What you need', content: '<li>Spark</li><li>Airflow</li>' }],
    salaryRange: { min: 70000, max: 90000, currency: 'EUR', interval: 'per-year-salary' },
    createdAt: 1790000000000,
  },
];
const ashbyBody = {
  jobs: [
    {
      id: 'x1',
      title: 'ML Engineer',
      jobUrl: 'https://jobs.ashbyhq.com/acme/x1',
      applyUrl: 'https://jobs.ashbyhq.com/acme/x1/application',
      employmentType: 'FullTime',
      location: 'Remote - US',
      isRemote: true,
      isListed: true,
      descriptionPlain: 'Requirements\nPyTorch',
      compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150000, maxValue: 200000 }] },
    },
    { id: 'x2', title: 'Hidden', jobUrl: 'https://jobs.ashbyhq.com/acme/x2', isListed: false },
  ],
};

const src = (kind: DiscoverySource['kind'], extra: Partial<DiscoverySource> = {}): DiscoverySource => ({
  id: `${kind}:acme`,
  kind,
  token: 'acme',
  label: 'Acme',
  titleFilter: '',
  enabled: true,
  ...extra,
});
const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('source adapters', () => {
  it('parses Greenhouse, skipping incomplete records', async () => {
    const jobs = await fetchSource(src('greenhouse'), respond(greenhouseBody) as never);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.job).toMatchObject({ title: 'Backend Engineer', company: 'Acme', workArrangement: 'remote', adapter: 'greenhouse-api' });
    expect(jobs[0]?.job.requiredQualifications).toEqual(['Python and Go']);
    expect(jobs[0]?.job.salary).toMatchObject({ min: 120000, max: 140000, currency: 'USD' });
  });

  it('parses Lever lists, workplace type and salary', async () => {
    const [d] = await fetchSource(src('lever'), respond(leverBody) as never);
    expect(d?.job).toMatchObject({ workArrangement: 'hybrid', employmentType: 'Full-time', salary: { min: 70000, max: 90000, currency: 'EUR', period: 'year' } });
    expect(d?.job.requiredQualifications).toEqual(['Spark', 'Airflow']);
  });

  it('parses Ashby and drops unlisted jobs', async () => {
    const jobs = await fetchSource(src('ashby'), respond(ashbyBody) as never);
    expect(jobs.map((j) => j.job.title)).toEqual(['ML Engineer']);
    expect(jobs[0]?.job.salary).toMatchObject({ min: 150000, max: 200000 });
  });

  it('applies include/exclude title filters', () => {
    expect(titleFilterMatches('Senior Backend Engineer', 'engineer, -manager')).toBe(true);
    expect(titleFilterMatches('Engineering Manager', 'engineer, -manager')).toBe(false);
    expect(titleFilterMatches('Account Executive', 'engineer')).toBe(false);
    expect(titleFilterMatches('Anything', '')).toBe(true);
  });

  it('reports HTTP errors, malformed bodies and timeouts clearly', async () => {
    await expect(fetchSource(src('lever'), respond({}, 404) as never)).rejects.toThrow(/No Lever board named “acme”/);
    await expect(fetchSource(src('lever'), respond({}, 429) as never)).rejects.toThrow(/rate limit/);
    await expect(fetchSource(src('greenhouse'), respond({ nope: true }) as never)).rejects.toThrow(/Unexpected Greenhouse/);
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))));
    await expect(fetchSource(src('ashby'), hang as never, 20)).rejects.toThrow(/did not respond/);
  });

  it('uses documented public endpoints', () => {
    expect(SOURCE_ADAPTERS.greenhouse.endpoint('acme')).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs?content=true');
    expect(SOURCE_ADAPTERS.lever.endpoint('acme')).toBe('https://api.lever.co/v0/postings/acme?mode=json');
    expect(SOURCE_ADAPTERS.ashby.endpoint('acme')).toBe('https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true');
  });
});

describe('discovery runs', () => {
  it('stores jobs, is idempotent, and expires jobs that disappear', async () => {
    fakeBrowser.permissions.contains = vi.fn(async () => true) as never;
    await updateSettings((s) => ({ ...s, discovery: { ...s.discovery, enabled: true, sources: [src('greenhouse')] } }));

    const first = await runDiscovery({ fetchImpl: respond(greenhouseBody) as never });
    expect(first).toMatchObject({ fetched: 2, created: 2, errors: [] });
    const second = await runDiscovery({ fetchImpl: respond(greenhouseBody) as never });
    expect(second).toMatchObject({ created: 0, updated: 2 });
    expect(await listJobs()).toHaveLength(2);

    const shrunk = { jobs: greenhouseBody.jobs.slice(0, 1) };
    const third = await runDiscovery({ fetchImpl: respond(shrunk) as never });
    expect(third.expired).toBe(1);
    const expired = (await listJobs()).find((j) => j.sourceJobId === '102');
    expect(expired?.expired).toBe(true);
    expect((await getSettings()).discovery.sources[0]?.lastCount).toBe(1);
  });

  it('records a clear error when host permission is missing and keeps other sources working', async () => {
    fakeBrowser.permissions.contains = vi.fn(async ({ origins }: { origins: string[] }) => !origins[0]!.includes('lever')) as never;
    await updateSettings((s) => ({ ...s, discovery: { ...s.discovery, enabled: true, sources: [src('lever'), src('ashby')] } }));
    const res = await runDiscovery({ fetchImpl: respond(ashbyBody) as never });
    expect(res.errors[0]).toMatch(/has not been granted/);
    expect(res.created).toBe(1);
    expect((await getSettings()).discovery.sources.find((s) => s.kind === 'lever')?.lastError).toMatch(/not been granted/);
  });
});

import { finalizeJob } from '../extraction/normalize';
import type { DiscoverySource, DiscoverySourceKind, ExtractedJob, Salary, WorkArrangement } from '../types';
import { decodeEntities, htmlToTextLite } from '../util';

/**
 * Adapters for documented, public, unauthenticated job-board APIs:
 *  - Greenhouse Job Board API: https://developers.greenhouse.io/job-board.html
 *  - Lever Postings API:       https://github.com/lever/postings-api
 *  - Ashby Job Postings API:   https://developers.ashbyhq.com/docs/public-job-posting-api
 * Each adapter is independent; a failing source never affects the others.
 */

export interface DiscoveredJob {
  sourceJobId: string;
  job: ExtractedJob;
}

export interface SourceAdapter {
  kind: DiscoverySourceKind;
  label: string;
  apiOrigin: string;
  endpoint(token: string): string;
  boardUrl(token: string): string;
  parse(body: unknown, source: DiscoverySource): DiscoveredJob[];
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function arrangementFrom(v: string | undefined, isRemote?: boolean): WorkArrangement {
  const t = (v ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (t === 'remote' || isRemote) return 'remote';
  if (t === 'hybrid') return 'hybrid';
  if (t === 'onsite' || t === 'inoffice') return 'onsite';
  return 'unknown';
}

const greenhouse: SourceAdapter = {
  kind: 'greenhouse',
  label: 'Greenhouse',
  apiOrigin: 'https://boards-api.greenhouse.io/*',
  endpoint: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`,
  boardUrl: (t) => `https://job-boards.greenhouse.io/${encodeURIComponent(t)}`,
  parse(body, source) {
    if (!isObj(body) || !Array.isArray(body.jobs)) throw new Error('Unexpected Greenhouse response');
    return body.jobs.filter(isObj).flatMap((j) => {
      const id = j.id !== undefined ? String(j.id) : undefined;
      const title = str(j.title);
      const url = str(j.absolute_url);
      if (!id || !title || !url) return [];
      const html = decodeEntities(str(j.content) ?? '');
      return [
        {
          sourceJobId: id,
          job: finalizeJob({
            title,
            company: str(j.company_name) ?? (source.label || source.token),
            location: isObj(j.location) ? str(j.location.name) : undefined,
            descriptionText: htmlToTextLite(html),
            descriptionHtml: html,
            datePosted: str(j.first_published) ?? str(j.updated_at),
            url,
            applyUrl: `${url}#app`,
            adapter: 'greenhouse-api',
          }),
        },
      ];
    });
  },
};

const lever: SourceAdapter = {
  kind: 'lever',
  label: 'Lever',
  apiOrigin: 'https://api.lever.co/*',
  endpoint: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
  boardUrl: (t) => `https://jobs.lever.co/${encodeURIComponent(t)}`,
  parse(body, source) {
    if (!Array.isArray(body)) throw new Error('Unexpected Lever response');
    return body.filter(isObj).flatMap((j) => {
      const id = str(j.id);
      const title = str(j.text);
      const url = str(j.hostedUrl);
      if (!id || !title || !url) return [];
      const cats = isObj(j.categories) ? j.categories : {};
      const lists = Array.isArray(j.lists) ? j.lists.filter(isObj) : [];
      const listText = lists.map((l) => `${str(l.text) ?? ''}\n${htmlToTextLite(`<ul>${str(l.content) ?? ''}</ul>`)}`).join('\n\n');
      const listHtml = lists.map((l) => `<h3>${str(l.text) ?? ''}</h3><ul>${str(l.content) ?? ''}</ul>`).join('');
      const range = isObj(j.salaryRange) ? j.salaryRange : undefined;
      const interval = str(range?.interval) ?? '';
      const salary: Salary | undefined =
        range && (num(range.min) || num(range.max))
          ? {
              min: num(range.min),
              max: num(range.max),
              currency: str(range.currency),
              period: /hour/.test(interval) ? 'hour' : /month/.test(interval) ? 'month' : 'year',
            }
          : undefined;
      const created = num(j.createdAt);
      return [
        {
          sourceJobId: id,
          job: finalizeJob({
            title,
            company: source.label || source.token,
            location: str(cats.location),
            employmentType: str(cats.commitment),
            workArrangement: arrangementFrom(str(j.workplaceType)),
            salary,
            descriptionText: [str(j.descriptionPlain) ?? htmlToTextLite(str(j.description) ?? ''), listText, str(j.additionalPlain) ?? ''].join('\n\n'),
            descriptionHtml: `${str(j.description) ?? ''}${listHtml}${str(j.additional) ?? ''}`,
            datePosted: created ? new Date(created).toISOString() : undefined,
            url,
            applyUrl: str(j.applyUrl),
            adapter: 'lever-api',
          }),
        },
      ];
    });
  },
};

const ashby: SourceAdapter = {
  kind: 'ashby',
  label: 'Ashby',
  apiOrigin: 'https://api.ashbyhq.com/*',
  endpoint: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}?includeCompensation=true`,
  boardUrl: (t) => `https://jobs.ashbyhq.com/${encodeURIComponent(t)}`,
  parse(body, source) {
    if (!isObj(body) || !Array.isArray(body.jobs)) throw new Error('Unexpected Ashby response');
    return body.jobs.filter(isObj).flatMap((j) => {
      if (j.isListed === false) return [];
      const id = str(j.id);
      const title = str(j.title);
      const url = str(j.jobUrl);
      if (!id || !title || !url) return [];
      const comp = isObj(j.compensation) ? j.compensation : undefined;
      const salaryPart = Array.isArray(comp?.summaryComponents)
        ? (comp.summaryComponents as unknown[]).filter(isObj).find((c) => c.compensationType === 'Salary')
        : undefined;
      const salary: Salary | undefined = salaryPart
        ? {
            min: num(salaryPart.minValue),
            max: num(salaryPart.maxValue),
            currency: str(salaryPart.currencyCode),
            period: /hour/i.test(str(salaryPart.interval) ?? '') ? 'hour' : 'year',
            text: str(comp?.compensationTierSummary),
          }
        : undefined;
      const employment = str(j.employmentType)?.replace(/([a-z])([A-Z])/g, '$1-$2');
      return [
        {
          sourceJobId: id,
          job: finalizeJob({
            title,
            company: source.label || source.token,
            location: str(j.location),
            employmentType: employment,
            workArrangement: arrangementFrom(str(j.workplaceType), j.isRemote === true),
            salary,
            descriptionText: str(j.descriptionPlain) ?? htmlToTextLite(str(j.descriptionHtml) ?? ''),
            descriptionHtml: str(j.descriptionHtml),
            datePosted: str(j.publishedAt),
            url,
            applyUrl: str(j.applyUrl),
            adapter: 'ashby-api',
          }),
        },
      ];
    });
  },
};

export const SOURCE_ADAPTERS: Record<DiscoverySourceKind, SourceAdapter> = { greenhouse, lever, ashby };

export function titleFilterMatches(title: string, filter: string): boolean {
  const terms = filter
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (!terms.length) return true;
  const t = title.toLowerCase();
  const include = terms.filter((x) => !x.startsWith('-'));
  const exclude = terms.filter((x) => x.startsWith('-')).map((x) => x.slice(1));
  if (exclude.some((x) => x && t.includes(x))) return false;
  return include.length === 0 || include.some((x) => t.includes(x));
}

export async function fetchSource(
  source: DiscoverySource,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<DiscoveredJob[]> {
  const adapter = SOURCE_ADAPTERS[source.kind];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(adapter.endpoint(source.token), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
      credentials: 'omit',
    });
    if (res.status === 404) throw new Error(`No ${adapter.label} board named “${source.token}”.`);
    if (res.status === 429) throw new Error(`${adapter.label} rate limit reached; try again later.`);
    if (!res.ok) throw new Error(`${adapter.label} returned HTTP ${res.status}.`);
    const body: unknown = await res.json();
    return adapter.parse(body, source).filter((d) => titleFilterMatches(d.job.title, source.titleFilter));
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error(`${adapter.label} did not respond within ${timeoutMs / 1000}s.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

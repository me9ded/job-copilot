import { firstEl, meta, textOf } from './dom';

/** Partial result an adapter can read from the DOM, in addition to JSON-LD. */
export interface AdapterResult {
  title?: string;
  company?: string;
  location?: string;
  employmentType?: string;
  workArrangementText?: string;
  salaryText?: string;
  descriptionEl?: Element | null;
  applyUrl?: string;
  /** False when the adapter recognises this as a non-job page (e.g. a board index). */
  isJobPage?: boolean;
}

export interface SiteAdapter {
  id: string;
  hosts: RegExp;
  extract(doc: Document, url: URL): AdapterResult;
}

const titleCompany = (doc: Document, re: RegExp): string | undefined => doc.title.match(re)?.[1]?.trim();

export const greenhouse: SiteAdapter = {
  id: 'greenhouse',
  hosts: /^(boards|job-boards)(\.eu)?\.greenhouse\.io$/,
  extract(doc, url) {
    const isJobPage = /\/jobs\/\d+/.test(url.pathname) || url.searchParams.has('gh_jid');
    return {
      isJobPage,
      title: textOf(doc, ['.job__title h1', 'h1.app-title', '.job-title', 'h1']),
      company:
        titleCompany(doc, /\bat\s+(.+?)\s*$/i) ??
        textOf(doc, ['.company-name', '[class*="company-name"]'])?.replace(/^at\s+/i, ''),
      location: textOf(doc, ['.job__location', '.location', '[class*="job__location"]']),
      salaryText: textOf(doc, ['.job__pay-ranges .pay-range', '.pay-range', '.job__pay-ranges']),
      descriptionEl: firstEl(doc, ['.job__description', '#content', '.job-post-content', 'main']),
      applyUrl: `${url.origin}${url.pathname}#app`,
    };
  },
};

export const lever: SiteAdapter = {
  id: 'lever',
  hosts: /^jobs(\.eu)?\.lever\.co$/,
  extract(doc, url) {
    const isJobPage = /^\/[^/]+\/[0-9a-f-]{20,}/i.test(url.pathname);
    const path = url.pathname.replace(/\/apply\/?$/, '');
    return {
      isJobPage,
      title: textOf(doc, ['.posting-headline h2', '.posting-header h2', 'h2']),
      company: titleCompany(doc, /^(.+?)\s+-\s+/),
      location: textOf(doc, ['.posting-categories .location', '.posting-category.location']),
      employmentType: textOf(doc, ['.posting-categories .commitment']),
      workArrangementText: textOf(doc, ['.posting-categories .workplaceTypes']),
      descriptionEl: firstEl(doc, ['[data-qa="job-description"]', '.content .section-wrapper.page-full-width', '.posting-page .content']),
      applyUrl: `${url.origin}${path}/apply`,
    };
  },
};

export const ashby: SiteAdapter = {
  id: 'ashby',
  hosts: /^jobs\.ashbyhq\.com$/,
  extract(doc, url) {
    const isJobPage = /^\/[^/]+\/[0-9a-f-]{20,}/i.test(url.pathname);
    const path = url.pathname.replace(/\/application\/?$/, '');
    return {
      isJobPage,
      title: textOf(doc, ['h1']),
      descriptionEl: firstEl(doc, ['[class*="descriptionText"]', '[class*="_description_"]', 'main']),
      applyUrl: `${url.origin}${path}/application`,
    };
  },
};

export const workable: SiteAdapter = {
  id: 'workable',
  hosts: /^apply\.workable\.com$/,
  extract(doc, url) {
    const isJobPage = /\/j\/[A-Z0-9]+/i.test(url.pathname);
    const desc = [doc.querySelector('[data-ui="job-description"]'), doc.querySelector('[data-ui="job-requirements"]')].filter(Boolean);
    let descriptionEl: Element | null = null;
    if (desc.length) {
      descriptionEl = doc.createElement('div');
      for (const d of desc) descriptionEl.appendChild(d!.cloneNode(true));
    }
    return {
      isJobPage,
      title: textOf(doc, ['[data-ui="job-title"]', 'h1']),
      location: textOf(doc, ['[data-ui="job-location"]']),
      employmentType: textOf(doc, ['[data-ui="job-type"]']),
      workArrangementText: textOf(doc, ['[data-ui="job-workplace"]', '[data-ui="job-remote"]']),
      descriptionEl,
      applyUrl: `${url.origin}${url.pathname.replace(/\/apply\/?$/, '').replace(/\/$/, '')}/apply/`,
    };
  },
};

export const smartrecruiters: SiteAdapter = {
  id: 'smartrecruiters',
  hosts: /^jobs\.smartrecruiters\.com$/,
  extract(doc, url) {
    return {
      isJobPage: /^\/[^/]+\/\d+/.test(url.pathname),
      title: textOf(doc, ['h1.job-title', '[itemprop="title"]', 'h1']),
      company: textOf(doc, ['[itemprop="hiringOrganization"] [itemprop="name"]']),
      location: textOf(doc, ['[itemprop="jobLocation"]', '.job-detail-location']),
      descriptionEl: firstEl(doc, ['.job-sections', '[itemprop="description"]', 'main']),
    };
  },
};

/** Generic fallback for company career pages: semantic HTML and Open Graph only. */
export const generic: SiteAdapter = {
  id: 'generic',
  hosts: /.*/,
  extract(doc) {
    const main = firstEl(doc, ['[itemprop="description"]', 'main article', 'article', '[role="main"]', 'main']);
    return {
      title: textOf(doc, ['h1']) ?? meta(doc, 'og:title'),
      company: meta(doc, 'og:site_name'),
      descriptionEl: main,
    };
  },
};

export const ADAPTERS: SiteAdapter[] = [greenhouse, lever, ashby, workable, smartrecruiters];

export function adapterFor(hostname: string): SiteAdapter {
  return ADAPTERS.find((a) => a.hosts.test(hostname)) ?? generic;
}

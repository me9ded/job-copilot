/**
 * Supported job sites. Each one is a public applicant-tracking-system job page
 * that renders without login. Host access is optional and only requested when
 * the user enables a site in Settings.
 */
export interface SupportedSite {
  id: string;
  label: string;
  origins: string[];
  example: string;
}

export const SUPPORTED_SITES: SupportedSite[] = [
  {
    id: 'greenhouse',
    label: 'Greenhouse',
    origins: ['https://boards.greenhouse.io/*', 'https://job-boards.greenhouse.io/*'],
    example: 'job-boards.greenhouse.io/company/jobs/123',
  },
  { id: 'lever', label: 'Lever', origins: ['https://jobs.lever.co/*'], example: 'jobs.lever.co/company/uuid' },
  { id: 'ashby', label: 'Ashby', origins: ['https://jobs.ashbyhq.com/*'], example: 'jobs.ashbyhq.com/company/uuid' },
  { id: 'workable', label: 'Workable', origins: ['https://apply.workable.com/*'], example: 'apply.workable.com/company/j/ABC123' },
  { id: 'workday', label: 'Workday', origins: ['https://*.myworkdayjobs.com/*'], example: 'company.wd5.myworkdayjobs.com/en-US/careers/job/…' },
  {
    id: 'smartrecruiters',
    label: 'SmartRecruiters',
    origins: ['https://jobs.smartrecruiters.com/*'],
    example: 'jobs.smartrecruiters.com/Company/123-title',
  },
];

/**
 * Sites whose terms prohibit automated extraction by browser add-ons. The
 * extension never injects into these; users can paste or select text instead.
 */
export const RESTRICTED_HOSTS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\.)linkedin\.com$/, label: 'LinkedIn' },
  { pattern: /(^|\.)indeed\.[a-z.]+$/, label: 'Indeed' },
  { pattern: /(^|\.)glassdoor\.[a-z.]+$/, label: 'Glassdoor' },
  { pattern: /(^|\.)ziprecruiter\.com$/, label: 'ZipRecruiter' },
];

export function restrictedSiteLabel(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return RESTRICTED_HOSTS.find((r) => r.pattern.test(host))?.label ?? null;
  } catch {
    return null;
  }
}

export function isInjectableUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.hostname === 'chromewebstore.google.com' || u.hostname === 'chrome.google.com') return false;
    return restrictedSiteLabel(url) === null;
  } catch {
    return false;
  }
}

/** Converts "https://careers.example.com/jobs/1" or "careers.example.com" into an origin pattern. */
export function toCustomSitePattern(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (u.protocol !== 'https:') return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return null;
    if (restrictedSiteLabel(u.toString())) return null;
    return `https://${u.hostname.toLowerCase()}/*`;
  } catch {
    return null;
  }
}

export function matchesPattern(url: string, pattern: string): boolean {
  const m = pattern.match(/^(https?|\*):\/\/([^/]+)\/(.*)$/);
  if (!m) return false;
  try {
    const u = new URL(url);
    const [, scheme, host, path] = m;
    if (scheme !== '*' && `${scheme}:` !== u.protocol) return false;
    const h = host!.replace(/:\*$/, '');
    if (h.startsWith('*.')) {
      const base = h.slice(2);
      if (u.hostname !== base && !u.hostname.endsWith(`.${base}`)) return false;
    } else if (h !== '*' && h !== u.hostname) return false;
    const re = new RegExp(`^/${path!.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return re.test(u.pathname);
  } catch {
    return false;
  }
}

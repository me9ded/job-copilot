/**
 * Site-specific hints for application forms. The generic engine works from
 * labels and roles; these only add selectors where an ATS uses stable markup
 * for its navigation, so the right button is found first. Nothing here
 * bypasses sign-in or anti-bot checks.
 */
export interface FormSite {
  id: string;
  label: string;
  host: RegExp;
  /** Buttons that move to the next step (never pressed when their text says Submit). */
  next?: string[];
  /** Buttons that open the application from the job page, in order of preference. */
  open?: string[];
  /** Markup that means "sign in or create an account first". */
  login?: string[];
}

export const FORM_SITES: FormSite[] = [
  {
    id: 'workday',
    label: 'Workday',
    host: /(^|\.)(myworkdayjobs|myworkdaysite|workday)\.com$/,
    next: ['[data-automation-id=bottom-navigation-next-button]', '[data-automation-id=pageFooterNextButton]'],
    // "Apply" opens a chooser; "Apply Manually" keeps the user's own data instead of Workday's résumé parser.
    open: ['[data-automation-id=applyManually]', '[data-automation-id=adventureButton]'],
    login: ['[data-automation-id=signInContent]', '[data-automation-id=createAccountContent]', '[data-automation-id=signInFormo]'],
  },
  { id: 'greenhouse', label: 'Greenhouse', host: /(^|\.)greenhouse\.io$/ },
  { id: 'lever', label: 'Lever', host: /(^|\.)lever\.co$/ },
  { id: 'ashby', label: 'Ashby', host: /(^|\.)ashbyhq\.com$/ },
  {
    id: 'smartrecruiters',
    label: 'SmartRecruiters',
    host: /(^|\.)smartrecruiters\.com$/,
    open: ['[data-test=footer-apply-button]', 'a[href*="/oneclick-ui/"]'],
  },
  { id: 'workable', label: 'Workable', host: /(^|\.)workable\.com$/ },
];

export function formSiteFor(url: string | undefined): FormSite | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).hostname;
    return FORM_SITES.find((s) => s.host.test(host));
  } catch {
    return undefined;
  }
}

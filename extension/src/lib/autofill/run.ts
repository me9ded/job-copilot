import { browser, type Browser } from 'wxt/browser';
import { friendlyInjectionError } from '../../background/analyze';
import type { AdvanceTicket, FillerApi, FrameProbe, FrameState } from '../../entrypoints/form-filler';
import { isInjectableUrl, restrictedSiteLabel } from '../extraction/sites';
import { findCountry, findRegion, parseLocation } from '../geo';
import { letterPdf, resumePdf, safeFilename } from '../resume/export';
import { getResumeFile } from '../storage/repo';
import { AUTOFILL_KEYS, type AutofillKey, type AutofillSettings, type CoverLetter, type JobRecord, type Profile, type ResumeContent, type ResumeVersion } from '../types';
import { bytesToBase64 } from '../util';
import { ATS_HOST_RE } from './engine/steps';
import { emptyReport, mergeInto, type AnswerBank, type AnswerOutcome, type FillData, type FillFile, type FillHistory, type FillLists, type FillReport, type FillRequest, type FrameNote, type StepOptions } from './fill';
import { runSteps, type AdvanceOutcome, type StepDriver, type StepFacts, type StepResult } from './progress';
import { FILLER_VERSION } from './version';

/** Runs in an extension page (popup / side panel), which holds the click's activeTab grant. */

export const FILLER_FILE = '/form-filler.js';

const isUrl = (s: string, host: RegExp) => host.test(s.replace(/^https?:\/\/(www\.)?/i, ''));
const withScheme = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

/** The most recent role: a current one if any, else the first listed (résumés are newest-first). */
function currentRole(p: ResumeContent) {
  return p.experience.find((e) => e.end === 'present') ?? p.experience[0];
}

/**
 * Values straight from the profile. Name splitting is a guess ("Ana María López" → "Ana María" / "López"),
 * and province / country come from the location ("Ottawa, ON" → Ontario, Canada); both are editable.
 */
export function profileFillValues(p: Profile): FillData {
  const name = p.basics.name.trim().replace(/\s+/g, ' ');
  const parts = name ? name.split(' ') : [];
  const links = p.basics.links;
  const linkedin = links.find((l) => isUrl(l, /^linkedin\.com\//i));
  const github = links.find((l) => isUrl(l, /^github\.com\//i));
  const website = links.find((l) => l !== linkedin && l !== github);
  const location = p.basics.location || p.preferences.locations[0] || '';
  const place = parseLocation(location);
  const region = findRegion(place.regionCode || place.region);
  const country = findCountry(place.countryCode || place.country) ?? (region ? findCountry(region.country) : undefined);
  const role = currentRole(p);
  const edu = p.education[0];
  return {
    fullName: name,
    firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] ?? ''),
    lastName: parts.length > 1 ? parts[parts.length - 1]! : '',
    email: p.basics.email,
    phone: p.basics.phone,
    location,
    // A street address is never guessed: it is typed by the user in "What Autofill types".
    address: '',
    city: place.city || (location.split(',')[0]?.trim() ?? ''),
    state: region?.name ?? place.region,
    postalCode: place.postalCode,
    country: country?.name ?? place.country,
    linkedin: linkedin ? withScheme(linkedin) : '',
    github: github ? withScheme(github) : '',
    website: website ? withScheme(website) : '',
    currentTitle: role?.title ?? '',
    currentCompany: role?.company ?? '',
    school: edu?.institution ?? '',
    degree: edu?.degree ?? '',
    discipline: edu?.field ?? '',
  };
}

/** Values derived rather than written in the profile (the report marks them "inferred"). */
const DERIVED: AutofillKey[] = ['firstName', 'lastName', 'city', 'state', 'country'];

export function inferredKeys(p: Profile, s: AutofillSettings): AutofillKey[] {
  const base = profileFillValues(p);
  return DERIVED.filter((k) => base[k] && !s.overrides[k]?.trim() && !(k === 'country' && /\b(canada|united states|usa)\b/i.test(p.basics.location)));
}

/** Work history and education for repeatable form sections, newest first as on the résumé. */
export function fillHistory(p: Profile): FillHistory {
  return {
    experience: p.experience
      .filter((e) => e.title || e.company)
      .map((e) => ({ title: e.title, company: e.company, location: e.location, start: e.start, end: e.end, description: e.bullets.map((b) => `• ${b}`).join('\n') })),
    education: p.education.filter((e) => e.institution).map((e) => ({ school: e.institution, degree: e.degree, field: e.field, start: e.start, end: e.end })),
  };
}

/** Skills, languages and certifications as written in the profile. */
export function fillLists(p: Profile): FillLists {
  return { skills: [...p.skills], languages: [...(p.languages ?? [])], certifications: [...p.certifications] };
}

export function fillValues(p: Profile, s: AutofillSettings): FillData {
  const base = profileFillValues(p);
  for (const k of AUTOFILL_KEYS) {
    const o = s.overrides[k];
    if (o !== undefined && o.trim()) base[k] = o.trim();
  }
  return base;
}

export interface ResumeChoice {
  value: string;
  label: string;
}

const originals = (versions: ResumeVersion[]) => versions.filter((v) => v.kind === 'original').sort((a, b) => b.createdAt.localeCompare(a.createdAt));

export function resumeChoices(versions: ResumeVersion[], filesFor: Set<string>): ResumeChoice[] {
  const out: ResumeChoice[] = [{ value: 'auto', label: 'Automatic: my uploaded file, else a PDF of my profile' }];
  for (const v of originals(versions)) if (filesFor.has(v.id)) out.push({ value: v.id, label: `Uploaded file: ${v.sourceFileName ?? v.name}` });
  out.push({ value: 'profile', label: 'PDF generated from my profile' });
  for (const v of versions) if (v.kind !== 'original') out.push({ value: v.id, label: `PDF of version: ${v.name}` });
  out.push({ value: 'none', label: "Don't attach a résumé" });
  return out;
}

/** Resolves the résumé file to attach. Uploaded originals are attached as-is; anything else is rendered to an ATS-friendly PDF. */
export async function resolveResume(attach: string, profile: Profile, versions: ResumeVersion[]): Promise<FillFile | undefined> {
  if (attach === 'none') return undefined;
  const generated = async (content: ResumeContent): Promise<FillFile> => ({
    name: `${safeFilename(`${content.basics.name || 'resume'} resume`)}.pdf`,
    type: 'application/pdf',
    base64: bytesToBase64(await resumePdf(content)),
  });
  if (attach === 'auto') {
    for (const v of originals(versions)) {
      const f = await getResumeFile(v.id);
      if (f) return { name: f.name, type: f.type, base64: f.base64 };
    }
    return generated(profile);
  }
  if (attach === 'profile') return generated(profile);
  const v = versions.find((x) => x.id === attach);
  if (!v) return generated(profile);
  const f = await getResumeFile(v.id);
  return f ? { name: f.name, type: f.type, base64: f.base64 } : generated(v.content);
}

/** The saved job an application page belongs to: same URL, its apply URL, or a page under it (Lever's /apply). */
export function jobForUrl(url: string | undefined, jobs: JobRecord[]): JobRecord | undefined {
  if (!url) return undefined;
  const clean = (u: string) => u.split('#')[0]!.split('?')[0]!.replace(/\/+$/, '');
  const u = clean(url);
  return (
    jobs.find((j) => [j.url, ...j.aliasUrls, j.applyUrl ?? ''].filter(Boolean).some((x) => clean(x) === u)) ??
    jobs.find((j) => [j.url, ...j.aliasUrls].some((x) => x && u.startsWith(`${clean(x)}/`)))
  );
}

/** Everything the form may be answered with: only what the user saved. */
export async function buildAnswers(s: AutofillSettings, letter?: CoverLetter, name = ''): Promise<AnswerBank> {
  const body = letter?.body.trim();
  return {
    standard: s.standardAnswers,
    saved: s.savedAnswers.map(({ question, answer }) => ({ question, answer })),
    coverLetter: body || undefined,
    coverLetterFile: body
      ? { name: `${safeFilename(`${name || 'cover'} cover letter`)}.pdf`, type: 'application/pdf', base64: bytesToBase64(await letterPdf(body, 'Cover letter')) }
      : undefined,
    tickConsent: s.tickConsent,
  };
}

export class AutofillError extends Error {
  override name = 'AutofillError';
}

/** Chrome hasn't given the extension access to this page (no toolbar click / right-click on it yet). */
export class NoAccessError extends AutofillError {
  override name = 'NoAccessError';
}

/* ----------------------------------------------------------------------------
 * Talking to the filler in each frame
 * ------------------------------------------------------------------------- */

type Api = { __jobCopilotFiller?: FillerApi };
type Method = 'probe' | 'fillStep' | 'advance' | 'state' | 'answer' | 'reveal' | 'toast';

interface FrameResult<T> {
  frameId: number;
  documentId?: string;
  result: T | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tabUrl(tabId: number): Promise<string | undefined> {
  try {
    return (await browser.tabs.get(tabId)).url;
  } catch {
    throw new AutofillError('That tab is no longer open.');
  }
}

async function checkTab(tabId: number): Promise<void> {
  const url = await tabUrl(tabId);
  const restricted = url ? restrictedSiteLabel(url) : null;
  if (restricted) throw new AutofillError(`Autofill is off on ${restricted}: its terms don’t allow add-ons to automate its pages. Fill the form yourself there.`);
  if (url && !isInjectableUrl(url)) throw new AutofillError('Browser and extension pages can’t be filled.');
}

const isAccessError = (err: unknown) => /cannot access|permission|host|must request/i.test(String(err instanceof Error ? err.message : err));

const lostAccess = (err: unknown) =>
  isAccessError(err)
    ? new NoAccessError('Chrome hasn’t let Job Copilot into this page yet. Click the Job Copilot icon in your browser toolbar (top right) while you’re on this page and press “Continue autofill”. Or right-click the page → “Autofill with Job Copilot”.')
    : new AutofillError(friendlyInjectionError(err).replace('analyzed', 'filled').replace('Analyze', 'Autofill'));

/** Injects this build's filler. With `frameIds`, only there; otherwise every frame Chrome lets the extension into. */
async function inject(tabId: number, frameIds?: number[]): Promise<void> {
  if (frameIds) {
    await browser.scripting.executeScript({ target: { tabId, frameIds }, files: [FILLER_FILE] });
    return;
  }
  try {
    await browser.scripting.executeScript({ target: { tabId, allFrames: true }, files: [FILLER_FILE] });
  } catch {
    // A frame we can't access (a third-party widget) can fail the whole call: the top frame alone, then.
    await browser.scripting.executeScript({ target: { tabId }, files: [FILLER_FILE] });
  }
}

/** Calls one filler function in the given frames (all reachable frames by default). */
async function callFiller<T>(tabId: number, method: Method, args: unknown[], frameIds?: number[]): Promise<Array<FrameResult<T>>> {
  const exec = (target: Browser.scripting.InjectionTarget) =>
    browser.scripting.executeScript({
      target,
      // Serialised into the page: it may only use its arguments.
      func: (m: string, a: unknown[], v: string) => {
        const api = (globalThis as unknown as Api).__jobCopilotFiller;
        if (!api || api.version !== v) return null;
        const fn = (api as unknown as Record<string, (...x: unknown[]) => unknown>)[m];
        return typeof fn === 'function' ? fn.apply(api, a) : null;
      },
      args: [method, args, FILLER_VERSION] as [string, unknown[], string],
    });
  let results: Awaited<ReturnType<typeof exec>>;
  if (frameIds) results = await exec({ tabId, frameIds });
  else {
    try {
      results = await exec({ tabId, allFrames: true });
    } catch {
      results = await exec({ tabId });
    }
  }
  return results.map((r) => ({ frameId: r.frameId, documentId: (r as { documentId?: string }).documentId, result: (r.result ?? null) as T | null }));
}

/** Third-party frames that are never the application (videos, maps, ads, chat, payments, CAPTCHAs). */
const NOT_A_FORM_FRAME = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare|youtube|vimeo|google\.[a-z.]+\/maps|maps\.google|doubleclick|googlesyndication|googletagmanager|facebook|twitter|x\.com|intercom|drift|zendesk|hotjar|hubspot|livechat|tawk|crisp|stripe|paypal|onetrust|cookie/i;

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
};

/** Visible iframes the extension couldn't reach (cross-origin, no permission), worth telling the user about. */
function inaccessibleFrames(top: FrameProbe | undefined, reached: FrameProbe[]): FrameNote[] {
  if (!top) return [];
  const origins = new Set(reached.map((p) => originOf(p.url)));
  const out: FrameNote[] = [];
  for (const f of top.iframes) {
    const origin = originOf(f.src);
    if (!origin || origins.has(origin) || NOT_A_FORM_FRAME.test(f.src) || f.width * f.height < 200 * 120) continue;
    if (!out.some((o) => originOf(o.url) === origin)) out.push({ host: new URL(f.src).hostname, url: f.src });
  }
  return out;
}

/**
 * The tab driver: fills each frame that holds the application, presses Next
 * / Apply in the frame that leads, and watches the tab for what happened
 * (the step changed, a new page loaded, a new tab opened, access was lost)
 * by polling snapshots, so no navigation can slip past an event listener.
 */
class TabDriver implements StepDriver {
  tabId: number;
  private lead = 0;
  private waitMs = 1500;
  private openers = new Set<number>();

  constructor(
    tabId: number,
    private req: FillRequest,
  ) {
    this.tabId = tabId;
  }

  async fill(): Promise<StepResult> {
    const tabId = this.tabId;
    try {
      await inject(tabId);
    } catch (err) {
      throw lostAccess(err);
    }
    let probes: Array<FrameResult<FrameProbe>>;
    try {
      probes = await callFiller<FrameProbe>(tabId, 'probe', []);
    } catch (err) {
      throw lostAccess(err);
    }
    const reached = probes.filter((p): p is FrameResult<FrameProbe> & { result: FrameProbe } => !!p.result);
    const restricted = reached.find((p) => p.result.restricted);
    if (restricted) throw new AutofillError(`Autofill is off on ${restricted.result.restricted}.`);
    if (!reached.length) throw new AutofillError('The page didn’t respond. Reload it and try again.');
    const top = reached.find((p) => p.result.top);
    const inaccessible = inaccessibleFrames(top?.result, reached.map((p) => p.result));
    // The frames holding the application, most questions first; else the top frame (it may have "Apply").
    let targets = reached.filter((p) => p.result.questions > 0).sort((a, b) => b.result.questions - a.result.questions);
    if (!targets.length) targets = [top ?? reached[0]!];
    let report = emptyReport(targets[0]!.result.url);
    const facts: StepFacts = { form: false, captcha: false, login: false, missing: 0, invalid: [] };
    for (const t of targets) {
      const opts: StepOptions = { frameId: t.frameId, waitMs: this.waitMs };
      let res: StepResult | { restricted: string } | null = null;
      try {
        res = (await callFiller<StepResult | { restricted: string }>(tabId, 'fillStep', [this.req, opts], [t.frameId]))[0]?.result ?? null;
      } catch (err) {
        // One frame failing never ends the run; it is reported.
        report.errors.push(`Part of the page (${hostName(t.result.url)}) couldn’t be filled: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!res) continue;
      if ('restricted' in res) throw new AutofillError(`Autofill is off on ${res.restricted}.`);
      report = mergeInto(report, res.report, t === targets[0]);
      const f = res.facts;
      facts.form ||= f.form;
      facts.captcha ||= f.captcha;
      facts.login ||= f.login;
      facts.missing += f.missing;
      facts.invalid.push(...f.invalid);
      facts.next ??= f.next;
      facts.submit ??= f.submit;
      facts.open ??= f.open;
    }
    this.lead = targets[0]!.frameId;
    this.waitMs = 0;
    report.frames = { inaccessible };
    report.tabId = tabId;
    // The application is inside a frame Job Copilot can't open (yet): say so instead of "no form".
    const blocked = !facts.form ? inaccessible[0] : undefined;
    if (blocked) {
      report.needsAccess = { host: blocked.host, origin: originOf(blocked.url), url: blocked.url };
      facts.open = undefined;
    }
    return { report, facts };
  }

  async advance(how: 'next' | 'open'): Promise<AdvanceOutcome> {
    const tabId = this.tabId;
    const lead = this.lead;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) throw new AutofillError('That tab is no longer open.');
    const beforeUrl = tab.url;
    this.openers = new Set((await browser.tabs.query({})).filter((t) => t.openerTabId === tabId && t.id !== undefined).map((t) => t.id!));
    const before = (await callFiller<FrameState>(tabId, 'state', [], [lead]))[0];
    if (how === 'open') await hookWindowOpen(tabId, lead);
    const ticket = (await callFiller<AdvanceTicket>(tabId, 'advance', [how], [lead]))[0]?.result;
    if (!ticket?.pressed) return { outcome: 'unchanged', errors: [] };
    return this.waitForChange(beforeUrl, before, how);
  }

  /** Polls the tab and the leading frame until the press visibly did something. */
  private async waitForChange(beforeUrl: string | undefined, before: FrameResult<FrameState> | undefined, how: 'next' | 'open'): Promise<AdvanceOutcome> {
    const tabId = this.tabId;
    const start = Date.now();
    const quietLimit = how === 'next' ? 6000 : 8000;
    let navigating = false;
    while (Date.now() - start < 25_000) {
      await sleep(200);
      // A new tab opened by the page (window.open that wasn't blocked).
      const opened = (await browser.tabs.query({})).find((t) => t.openerTabId === tabId && t.id !== undefined && !this.openers.has(t.id));
      if (opened?.id !== undefined) return this.followNewTab(opened.id);
      let tab: { url?: string; pendingUrl?: string; status?: string };
      try {
        tab = await browser.tabs.get(tabId);
      } catch {
        throw new AutofillError('That tab is no longer open.');
      }
      const url = tab.pendingUrl || tab.url;
      if ((url && url !== beforeUrl) || (!url && beforeUrl)) navigating = true;
      if (navigating) {
        if (tab.status !== 'complete' || tab.pendingUrl) continue;
        return this.afterLoad(url);
      }
      let state: FrameResult<FrameState> | undefined;
      try {
        state = (await callFiller<FrameState>(tabId, 'state', [], [this.lead]))[0];
      } catch (err) {
        if (isAccessError(err)) return this.noAccess(url);
        // The frame is gone or reloading.
        navigating = true;
        continue;
      }
      if (!state?.result || (before?.documentId && state.documentId && state.documentId !== before.documentId)) {
        // A new document in the frame: wait for it, then fill it.
        if (tab.status === 'complete') return this.afterLoad(url);
        navigating = true;
        continue;
      }
      if (state.result.opened && state.result.blocked) {
        // The page tried to open the form in a popup that Chrome blocked: follow it in this tab.
        await browser.tabs.update(tabId, { url: state.result.opened });
        navigating = true;
        continue;
      }
      if (before?.result && state.result.signature !== before.result.signature) {
        this.waitMs = 1500;
        return { outcome: 'moved' };
      }
      if (Date.now() - start > quietLimit) return { outcome: 'unchanged', errors: state.result.errors };
    }
    return { outcome: 'unchanged', errors: ['The page took too long to respond.'] };
  }

  private async afterLoad(url: string | undefined): Promise<AdvanceOutcome> {
    try {
      await inject(this.tabId);
      const probe = await callFiller<FrameProbe>(this.tabId, 'probe', [], [0]);
      if (!probe[0]?.result) throw new Error('no answer');
    } catch (err) {
      if (isAccessError(err) || !url) return this.noAccess(url);
      throw lostAccess(err);
    }
    this.lead = 0;
    this.waitMs = 4000;
    return { outcome: 'navigated' };
  }

  private async followNewTab(id: number): Promise<AdvanceOutcome> {
    for (let i = 0; i < 75; i++) {
      const t = await browser.tabs.get(id).catch(() => null);
      if (!t) return { outcome: 'unchanged', errors: ['A new tab opened and closed again.'] };
      if (t.status === 'complete' && !t.pendingUrl) break;
      await sleep(200);
    }
    try {
      await inject(id, [0]);
    } catch {
      const t = await browser.tabs.get(id).catch(() => null);
      const url = t?.url || t?.pendingUrl;
      return { outcome: 'no_access', host: url ? hostName(url) : 'the new tab', origin: url ? originOf(url) : '', url, newTab: id };
    }
    this.tabId = id;
    this.lead = 0;
    this.waitMs = 4000;
    return { outcome: 'new_tab', tabId: id };
  }

  private noAccess(url: string | undefined): AdvanceOutcome {
    return { outcome: 'no_access', host: url ? hostName(url) : 'the next page', origin: url ? originOf(url) : '', url };
  }
}

const hostName = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
};

/**
 * During Job Copilot's own "Apply" press only, notes a `window.open` URL in
 * the page (main world), so a form that opens in a popup can be followed in
 * this tab if Chrome blocks the popup. Removed a few seconds later.
 */
async function hookWindowOpen(tabId: number, frameId: number): Promise<void> {
  try {
    await browser.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        const w = window as unknown as { __jcOpen?: typeof window.open };
        if (w.__jcOpen) return;
        const orig = window.open;
        w.__jcOpen = orig;
        window.open = function (this: Window, ...args: Parameters<typeof window.open>) {
          try {
            document.documentElement.setAttribute('data-job-copilot-opened', new URL(String(args[0] ?? ''), location.href).href);
          } catch {
            /* not a URL */
          }
          const win = orig.apply(this, args);
          if (!win) document.documentElement.setAttribute('data-job-copilot-blocked', '');
          return win;
        } as typeof window.open;
        setTimeout(() => {
          window.open = orig;
          delete w.__jcOpen;
        }, 5000);
      },
    });
  } catch {
    // Best effort: without it, a popup simply opens (or is blocked) as it would for the user.
  }
}

function summary(r: FillReport): string {
  const n = r.filled.length;
  const needs = r.unanswered.length + (r.failed?.length ?? 0) + (r.unverified?.length ?? 0);
  const head = `Job Copilot filled ${n} field${n === 1 ? '' : 's'} (outlined in green)`;
  if (r.stop === 'submit_ready') return `${head}. Review them, then press “${r.submitLabel ?? 'Submit'}” yourself.`;
  return needs ? `${head}. ${needs} need${needs === 1 ? 's' : ''} you (outlined in red or amber); see the side panel.` : `${head}.`;
}

/**
 * Fills the application in a tab, step by step, following page loads and
 * new tabs. Stops before the final submit, which only the user presses.
 */
export async function autofillTab(tabId: number, req: FillRequest): Promise<FillReport> {
  await checkTab(tabId);
  const driver = new TabDriver(tabId, req);
  const report = await runSteps(driver, { advance: req.advance, maxSteps: req.maxSteps });
  report.tabId = driver.tabId;
  if (report.filled.length || report.unanswered.length || report.failed?.length) await callFiller(driver.tabId, 'toast', [summary(report)], [0]).catch(() => undefined);
  return report;
}

/** Answers one question (by id; by label for reports from older builds) with what the user typed in the side panel. */
export async function answerInTab(tabId: number, idOrLabel: string, value: string, frameId?: number): Promise<AnswerOutcome> {
  await checkTab(tabId);
  const frames = frameId !== undefined ? [frameId] : undefined;
  let results: Array<FrameResult<AnswerOutcome>>;
  try {
    await inject(tabId, frames);
    results = await callFiller<AnswerOutcome>(tabId, 'answer', [idOrLabel, value], frames);
  } catch (err) {
    throw lostAccess(err);
  }
  const outs = results.map((r) => r.result).filter((r): r is AnswerOutcome => !!r);
  return outs.find((o) => o.ok) ?? outs.find((o) => !o.ok && o.reason !== 'not_found') ?? outs[0] ?? { ok: false, reason: 'not_found', message: 'That question is no longer on the page.' };
}

/** Scrolls the page to a question and outlines it. */
export async function revealInTab(tabId: number, idOrLabel: string, frameId?: number): Promise<boolean> {
  const frames = frameId !== undefined ? [frameId] : undefined;
  try {
    await inject(tabId, frames);
    return (await callFiller<boolean>(tabId, 'reveal', [idOrLabel], frames)).some((r) => r.result === true);
  } catch {
    return false;
  }
}

/** Whether a host belongs to an applicant-tracking system (for the "allow access" prompt). */
export const isAtsHost = (host: string) => ATS_HOST_RE.test(host);

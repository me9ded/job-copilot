import { browser } from 'wxt/browser';
import { friendlyInjectionError } from '../../background/analyze';
import { isInjectableUrl, restrictedSiteLabel } from '../extraction/sites';
import { letterPdf, resumePdf, safeFilename } from '../resume/export';
import { getResumeFile } from '../storage/repo';
import { AUTOFILL_KEYS, type AutofillSettings, type CoverLetter, type JobRecord, type Profile, type ResumeContent, type ResumeVersion } from '../types';
import { bytesToBase64 } from '../util';
import type { FillerApi } from '../../entrypoints/form-filler';
import { moreImportant, type AnswerBank, type FillData, type FillFile, type FillHistory, type FillReport, type FillRequest, type SubmitOutcome } from './fill';

/** Runs in an extension page (popup / side panel), which holds the click's activeTab grant. */

export const FILLER_FILE = '/form-filler.js';

const isUrl = (s: string, host: RegExp) => host.test(s.replace(/^https?:\/\/(www\.)?/i, ''));
const withScheme = (s: string) => (/^https?:\/\//i.test(s) ? s : `https://${s}`);

/** The most recent role: a current one if any, else the first listed (résumés are newest-first). */
function currentRole(p: ResumeContent) {
  return p.experience.find((e) => e.end === 'present') ?? p.experience[0];
}

/** Values straight from the profile. Name splitting is a guess ("Ana María López" → "Ana María" / "López"), so it's editable. */
export function profileFillValues(p: Profile): FillData {
  const name = p.basics.name.trim().replace(/\s+/g, ' ');
  const parts = name ? name.split(' ') : [];
  const links = p.basics.links;
  const linkedin = links.find((l) => isUrl(l, /^linkedin\.com\//i));
  const github = links.find((l) => isUrl(l, /^github\.com\//i));
  const website = links.find((l) => l !== linkedin && l !== github);
  const location = p.basics.location || p.preferences.locations[0] || '';
  const role = currentRole(p);
  const edu = p.education[0];
  return {
    fullName: name,
    firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] ?? ''),
    lastName: parts.length > 1 ? parts[parts.length - 1]! : '',
    email: p.basics.email,
    phone: p.basics.phone,
    location,
    city: location.split(',')[0]?.trim() ?? '',
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

/** Work history and education for repeatable form sections, newest first as on the résumé. */
export function fillHistory(p: Profile): FillHistory {
  return {
    experience: p.experience
      .filter((e) => e.title || e.company)
      .map((e) => ({ title: e.title, company: e.company, location: e.location, start: e.start, end: e.end, description: e.bullets.map((b) => `• ${b}`).join('\n') })),
    education: p.education.filter((e) => e.institution).map((e) => ({ school: e.institution, degree: e.degree, field: e.field, start: e.start, end: e.end })),
  };
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

/** Merges per-frame reports (application forms are often embedded in an iframe). */
function merge(reports: FillReport[]): FillReport {
  const [first, ...rest] = reports;
  const out: FillReport = { ...first!, filled: [...first!.filled], kept: [...first!.kept], noValue: [...first!.noValue], unanswered: [...first!.unanswered], errors: [...first!.errors] };
  for (const r of rest) {
    out.filled.push(...r.filled);
    out.kept.push(...r.kept);
    out.noValue.push(...r.noValue);
    out.unanswered.push(...r.unanswered);
    out.errors.push(...r.errors);
    out.steps = Math.max(out.steps, r.steps);
    out.resumeInputFound ||= r.resumeInputFound;
    out.stop = moreImportant(out.stop, r.stop);
    out.submitLabel ??= r.submitLabel;
  }
  return out;
}

type Api = { __jobCopilotFiller?: FillerApi };

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

const lostAccess = (err: unknown) =>
  /cannot access|permission|host/i.test(String(err instanceof Error ? err.message : err))
    ? new NoAccessError('Chrome hasn’t let Job Copilot into this page yet. Click the Job Copilot icon in your browser toolbar (top right) while you’re on this page and press “Continue autofill”. Or right-click the page → “Autofill with Job Copilot”.')
    : new AutofillError(friendlyInjectionError(err).replace('analyzed', 'filled').replace('Analyze', 'Autofill'));

/** Injects the filler (idempotent) and calls one of its functions in every reachable frame. */
async function callFiller<T>(tabId: number, method: 'fill' | 'answer' | 'submit', arg: unknown): Promise<Array<T | null>> {
  const run = async (allFrames: boolean) => {
    await browser.scripting.executeScript({ target: { tabId, allFrames }, files: [FILLER_FILE] });
    return browser.scripting.executeScript({
      target: { tabId, allFrames },
      // Serialised into the page: it may only use its arguments.
      func: (m: string, a: unknown) => {
        const api = (globalThis as unknown as Api).__jobCopilotFiller;
        if (!api) return null;
        if (m === 'fill') return api.fill(a as FillRequest);
        if (m === 'answer') return api.answer((a as [string, string])[0], (a as [string, string])[1]);
        return api.submit();
      },
      args: [method, arg] as [string, unknown],
    });
  };
  let results: Awaited<ReturnType<typeof run>>;
  try {
    results = await run(true);
  } catch {
    // A frame we can't access (e.g. a third-party widget) can fail the whole call; retry the top frame only.
    try {
      results = await run(false);
    } catch (err) {
      throw lostAccess(err);
    }
  }
  return results.map((r) => (r.result ?? null) as T | null);
}

function waitForLoad(tabId: number, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      browser.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      // Give single-page apps a moment to render the form.
      setTimeout(resolve, 800);
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    browser.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Fills the application in a tab, following up to two page changes (an
 * "Apply" link that opens the form on its own page). Stops before the final
 * submit; see `submitInTab`.
 */
export async function autofillTab(tabId: number, req: FillRequest): Promise<FillReport> {
  await checkTab(tabId);
  let combined = null as FillReport | null;
  for (let hop = 0; hop < 3; hop++) {
    const results = await callFiller<FillReport & { restricted?: string }>(tabId, 'fill', req);
    const reports: FillReport[] = [];
    for (const v of results) {
      if (!v || typeof v !== 'object') continue;
      if (v.restricted) throw new AutofillError(`Autofill is off on ${v.restricted}.`);
      if (Array.isArray(v.filled)) reports.push(v);
    }
    if (!reports.length) throw new AutofillError('The page didn’t respond. Reload it and try again.');
    // The frame that filled the most leads (usually the one holding the form).
    const report = merge(reports.sort((a, b) => b.filled.length - a.filled.length));
    // Earlier pages' results are kept; the current page decides why filling stopped.
    combined = combined ? merge([report, { ...combined, stop: 'no_form' }]) : report;
    if (report.stop !== 'navigating') break;
    await waitForLoad(tabId);
    await checkTab(tabId);
  }
  return combined!;
}

export async function answerInTab(tabId: number, label: string, value: string): Promise<boolean> {
  await checkTab(tabId);
  return (await callFiller<boolean>(tabId, 'answer', [label, value])).some((r) => r === true);
}

/** Presses the final submit button. Call only after the user confirmed. */
export async function submitInTab(tabId: number): Promise<SubmitOutcome> {
  await checkTab(tabId);
  let results: Array<SubmitOutcome | null>;
  try {
    results = await callFiller<SubmitOutcome>(tabId, 'submit', null);
  } catch (err) {
    // Submitting usually navigates, which can end the call before it returns.
    if (/frame|navigat|closed|context/i.test(String(err))) return { status: 'unknown', errors: [] };
    throw err;
  }
  const outcomes = results.filter((r): r is SubmitOutcome => !!r);
  if (!outcomes.length) return { status: 'unknown', errors: [] };
  return outcomes.find((o) => o.status === 'submitted') ?? outcomes.find((o) => o.status === 'errors') ?? outcomes[0]!;
}

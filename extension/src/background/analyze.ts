import { browser } from 'wxt/browser';
import { setDetection, type TabDetection } from '../lib/detection';
import type { ExtractionOutcome } from '../lib/extraction/extract';
import { isInjectableUrl, restrictedSiteLabel } from '../lib/extraction/sites';
import { ExtractionOutcomeSchema } from '../lib/messages';
import { nowIso } from '../lib/util';
import { DETECTOR_FILE } from './registration';

export function friendlyInjectionError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/cannot access|permission|host/i.test(msg) && !/chrome:\/\//i.test(msg))
    return 'Job Copilot doesn’t have access to this page. Click the Job Copilot toolbar icon while viewing the job (grants one-time access), or enable the site in Settings → Job sites.';
  if (/chrome:\/\/|chrome-extension:\/\/|extensions gallery|webstore/i.test(msg)) return 'Browser and extension pages can’t be analyzed.';
  if (/No tab with id|tab was closed/i.test(msg)) return 'That tab is no longer open.';
  if (/frame|error page/i.test(msg)) return 'This page can’t be analyzed (it may still be loading or be an error page).';
  return `Could not analyze this page: ${msg}`;
}

/**
 * Runs the detector in a tab the extension has access to (via activeTab or a
 * granted host permission). Returns and stores the outcome.
 */
export async function analyzeTab(tabId: number): Promise<TabDetection> {
  let url: string | undefined;
  try {
    url = (await browser.tabs.get(tabId)).url;
  } catch {
    throw new Error('That tab is no longer open.');
  }
  if (url) {
    const restricted = restrictedSiteLabel(url);
    if (restricted) {
      const d: TabDetection = { tabId, url, outcome: { status: 'restricted', site: restricted }, detectedAt: nowIso(), trigger: 'manual' };
      await setDetection(d);
      return d;
    }
    if (!isInjectableUrl(url)) throw new Error('Browser and extension pages can’t be analyzed.');
  }

  let result: unknown;
  try {
    // Mark the injection as user-initiated so the detector skips its on-page button.
    await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        (globalThis as unknown as { __jobCopilotManual?: boolean }).__jobCopilotManual = true;
      },
    });
    await browser.scripting.executeScript({ target: { tabId }, files: [DETECTOR_FILE] });
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      func: () => (globalThis as unknown as { __jobCopilot?: { run(): unknown } }).__jobCopilot?.run() ?? null,
    });
    result = res?.result;
  } catch (err) {
    throw new Error(friendlyInjectionError(err));
  }

  const parsed = parseRunResult(result);
  if (!parsed) throw new Error('The page returned an unexpected result. Reload the page and try again.');
  const d: TabDetection = { tabId, url: parsed.url, outcome: parsed.outcome, detectedAt: nowIso(), trigger: 'manual' };
  await setDetection(d);
  return d;
}

export function parseRunResult(value: unknown): { url: string; outcome: ExtractionOutcome } | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { url?: unknown; outcome?: unknown };
  if (typeof v.url !== 'string') return null;
  const outcome = ExtractionOutcomeSchema.safeParse(v.outcome);
  return outcome.success ? { url: v.url, outcome: outcome.data } : null;
}

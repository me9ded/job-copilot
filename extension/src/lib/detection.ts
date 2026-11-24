import { browser } from 'wxt/browser';
import type { ExtractionOutcome } from './extraction/extract';
import { SESSION_KEYS } from './storage/schema';
import type { ViewId } from './messages';

/**
 * Per-tab detection state lives in chrome.storage.session so it survives
 * service-worker suspension but is cleared when the browser closes. Only the
 * URL of pages where the detector ran is stored — never general history.
 */
export interface TabDetection {
  tabId: number;
  url: string;
  outcome: ExtractionOutcome;
  detectedAt: string;
  trigger: 'auto' | 'manual';
}

export async function setDetection(d: TabDetection): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEYS.tab(d.tabId)]: d });
}

export async function getDetection(tabId: number): Promise<TabDetection | null> {
  const key = SESSION_KEYS.tab(tabId);
  return ((await browser.storage.session.get(key))[key] as TabDetection | undefined) ?? null;
}

/** When a tab closes: its detection, autofill report and job context. */
export async function forgetTab(tabId: number): Promise<void> {
  await browser.storage.session.remove([SESSION_KEYS.tab(tabId), SESSION_KEYS.autofill(tabId), SESSION_KEYS.jobContext(tabId)]);
}

export async function clearDetection(tabId: number): Promise<void> {
  await browser.storage.session.remove([SESSION_KEYS.tab(tabId), SESSION_KEYS.autofill(tabId)]);
}

export interface UiRequest {
  view: ViewId;
  jobId?: string;
  at: number;
}

/** Lets the popup, context menu or a notification tell the side panel which view to show. */
export async function requestView(view: ViewId, jobId?: string): Promise<void> {
  await browser.storage.session.set({ [SESSION_KEYS.uiRequest]: { view, jobId, at: Date.now() } satisfies UiRequest });
}

export interface PendingManual {
  text: string;
  url?: string;
  at: number;
}

export async function getActiveTabId(): Promise<number | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

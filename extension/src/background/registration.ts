import { browser } from 'wxt/browser';
import { SUPPORTED_SITES } from '../lib/extraction/sites';
import { getSettings } from '../lib/storage/repo';

export const DETECTOR_SCRIPT_ID = 'job-detector';
export const DETECTOR_FILE = '/job-detector.js';

/** Origins the detector should auto-run on: supported or custom sites the user has granted. */
export async function grantedDetectorOrigins(): Promise<string[]> {
  const settings = await getSettings();
  const candidates = Array.from(new Set([...SUPPORTED_SITES.flatMap((s) => s.origins), ...settings.customSites]));
  const granted: string[] = [];
  for (const origin of candidates) {
    try {
      if (await browser.permissions.contains({ origins: [origin] })) granted.push(origin);
    } catch {
      /* malformed custom origin: ignore */
    }
  }
  return granted;
}

/**
 * Keeps the dynamically registered content script in sync with granted host
 * permissions. Called on install/startup, when permissions change and when the
 * custom site list changes. Idempotent.
 */
export async function syncContentScripts(): Promise<string[]> {
  const matches = await grantedDetectorOrigins();
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await browser.scripting.unregisterContentScripts({ ids: [DETECTOR_SCRIPT_ID] });
    return [];
  }
  const script = {
    id: DETECTOR_SCRIPT_ID,
    matches,
    js: [DETECTOR_FILE.slice(1)],
    runAt: 'document_idle' as const,
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (existing.length) await browser.scripting.updateContentScripts([script]);
  else await browser.scripting.registerContentScripts([script]);
  return matches;
}

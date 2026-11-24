import { browser } from 'wxt/browser';
import { getSettings } from '../lib/storage/repo';

/**
 * chrome.alarms notes (documented in docs/ARCHITECTURE.md):
 * - Periods shorter than 30 seconds are rounded up; we use hours.
 * - Alarms are not exact: Chrome may delay them while the device sleeps and
 *   fires a missed alarm once on wake rather than catching up.
 * - Alarms usually persist across restarts, but this is not guaranteed, so
 *   ensureAlarms() runs on install, on browser startup and on settings changes.
 */
export const ALARMS = { discovery: 'discovery-refresh', followUps: 'followup-check' } as const;

async function ensure(name: string, periodInMinutes: number | null): Promise<void> {
  const existing = await browser.alarms.get(name);
  if (periodInMinutes === null) {
    if (existing) await browser.alarms.clear(name);
    return;
  }
  if (existing && existing.periodInMinutes === periodInMinutes) return;
  await browser.alarms.create(name, { periodInMinutes, delayInMinutes: Math.min(periodInMinutes, 5) });
}

export async function ensureAlarms(): Promise<{ discovery: boolean; followUps: boolean }> {
  const s = await getSettings();
  const discovery = s.discovery.enabled && s.discovery.sources.some((x) => x.enabled);
  await ensure(ALARMS.discovery, discovery ? Math.round(s.discovery.refreshHours * 60) : null);
  await ensure(ALARMS.followUps, s.notifications.followUps ? 60 : null);
  return { discovery, followUps: s.notifications.followUps };
}

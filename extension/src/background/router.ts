import { browser, type Browser } from 'wxt/browser';
import { getDetection, setDetection } from '../lib/detection';
import { runDiscovery } from '../lib/discovery/run';
import { findDuplicate, mergeExtraction } from '../lib/jobs';
import { matchJob } from '../lib/matching/service';
import { ContentMessage, PageMessage, type DetectorSummary, type Envelope } from '../lib/messages';
import { getSettings, listJobs, putJob, setJobSaved, upsertJob } from '../lib/storage/repo';
import { SESSION_KEYS } from '../lib/storage/schema';
import { errorMessage, nowIso } from '../lib/util';
import { ensureAlarms } from './alarms';
import { analyzeTab } from './analyze';
import { checkFollowUps, notifyNewMatches } from './notify';
import { syncContentScripts } from './registration';

type Sender = Browser.runtime.MessageSender;

function isExtensionPage(sender: Sender): boolean {
  return sender.id === browser.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(browser.runtime.getURL('/'));
}

function isOurContentScript(sender: Sender): boolean {
  return sender.id === browser.runtime.id && !!sender.tab?.id && sender.frameId === 0 && !isExtensionPage(sender);
}

export async function updateBadge(tabId: number, score: number | null, isJob: boolean): Promise<void> {
  try {
    if (!isJob) {
      await browser.action.setBadgeText({ tabId, text: '' });
      return;
    }
    await browser.action.setBadgeText({ tabId, text: score === null ? 'JOB' : String(score) });
    const color = score === null ? '#475569' : score >= 75 ? '#15803d' : score >= 50 ? '#b45309' : '#b91c1c';
    await browser.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    /* tab closed */
  }
}

/** Refreshes a saved job's data and last-verified time when the user revisits its page. */
async function refreshKnownJob(outcomeJob: Parameters<typeof mergeExtraction>[1]): Promise<string | null> {
  const jobs = await listJobs();
  const dup = findDuplicate(outcomeJob, jobs);
  if (!dup) return null;
  await putJob(mergeExtraction(dup.job, outcomeJob));
  return dup.job.id;
}

async function handleContent(msg: ContentMessage, sender: Sender): Promise<unknown> {
  const tab = sender.tab!;
  const tabId = tab.id!;
  switch (msg.type) {
    case 'detector/result': {
      // The URL must be the sender tab's own page; a content script cannot report on other pages.
      if (sender.url && new URL(sender.url).origin !== new URL(msg.url).origin) throw new Error('URL mismatch');
      await setDetection({ tabId, url: msg.url, outcome: msg.outcome, detectedAt: nowIso(), trigger: 'auto' });
      if (msg.outcome.status !== 'ok') {
        await updateBadge(tabId, null, false);
        return null;
      }
      await browser.storage.session.set({ [SESSION_KEYS.jobContext(tabId)]: msg.outcome.job });
      await refreshKnownJob(msg.outcome.job);
      const match = await matchJob(msg.outcome.job);
      await updateBadge(tabId, match?.score ?? null, true);
      return null;
    }
    case 'detector/summary': {
      const d = await getDetection(tabId);
      const settings = await getSettings();
      if (!d || d.outcome.status !== 'ok') return null;
      const match = await matchJob(d.outcome.job);
      const dup = findDuplicate(d.outcome.job, await listJobs());
      const summary: DetectorSummary & { showButton: boolean } = {
        hasProfile: match !== null,
        score: match?.score ?? null,
        matched: match?.requiredMatched.filter((h) => h.credit === 1).map((h) => h.skill).slice(0, 6) ?? [],
        missing: match?.requiredMissing.slice(0, 4) ?? [],
        savedJobId: dup?.job.saved ? dup.job.id : null,
        showButton: settings.showOnPageButton,
      };
      return summary;
    }
    case 'detector/save': {
      const d = await getDetection(tabId);
      if (!d || d.outcome.status !== 'ok') throw new Error('No job detected on this page');
      const { job } = await upsertJob(d.outcome.job, 'page', { saved: true, savedAt: nowIso() });
      await setJobSaved(job.id, true);
      return { jobId: job.id };
    }
    case 'detector/openPanel': {
      // The on-page "Autofill" button: the panel picks this up and fills the form in this tab.
      await browser.storage.session.set({ [SESSION_KEYS.autofillRequest]: { tabId, at: Date.now() } });
      // Works when Chrome propagates the click's user gesture; otherwise the caller shows a hint.
      await browser.sidePanel.open({ windowId: tab.windowId });
      return null;
    }
  }
}

async function handlePage(msg: PageMessage): Promise<unknown> {
  switch (msg.type) {
    case 'tab/analyze': {
      const d = await analyzeTab(msg.tabId);
      if (d.outcome.status === 'ok') {
        await browser.storage.session.set({ [SESSION_KEYS.jobContext(msg.tabId)]: d.outcome.job });
        await refreshKnownJob(d.outcome.job);
        const match = await matchJob(d.outcome.job);
        await updateBadge(msg.tabId, match?.score ?? null, true);
      }
      return d;
    }
    case 'sites/sync':
      return syncContentScripts();
    case 'alarms/sync':
      return ensureAlarms();
    case 'discovery/run': {
      const { newJobs, ...summary } = await runDiscovery({ sourceId: msg.sourceId });
      await notifyNewMatches(newJobs);
      return summary;
    }
    case 'followups/check':
      return checkFollowUps();
  }
}

export async function routeMessage(raw: unknown, sender: Sender): Promise<Envelope> {
  try {
    if (sender.id !== browser.runtime.id) return { ok: false, error: 'Unknown sender' };
    if (isExtensionPage(sender)) {
      const parsed = PageMessage.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'Invalid message' };
      return { ok: true, data: await handlePage(parsed.data) };
    }
    if (isOurContentScript(sender)) {
      const parsed = ContentMessage.safeParse(raw);
      if (!parsed.success) return { ok: false, error: 'Invalid message' };
      return { ok: true, data: await handleContent(parsed.data, sender) };
    }
    return { ok: false, error: 'Unknown sender' };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

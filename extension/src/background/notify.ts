import { browser } from 'wxt/browser';
import { matchJobs } from '../lib/matching/service';
import { getJob, getSettings, listApplications, patchApplication } from '../lib/storage/repo';
import type { JobRecord } from '../lib/types';
import { nowIso, parseDate } from '../lib/util';

export async function canNotify(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: ['notifications'] });
  } catch {
    return false;
  }
}

async function notify(id: string, title: string, message: string): Promise<void> {
  await browser.notifications.create(id, {
    type: 'basic',
    iconUrl: browser.runtime.getURL('/icon/128.png'),
    title,
    message,
    priority: 0,
  });
}

/** Sends at most one summary notification for newly discovered high-scoring jobs. */
export async function notifyNewMatches(newJobs: JobRecord[]): Promise<void> {
  const settings = await getSettings();
  if (!newJobs.length || !settings.notifications.newMatches || !(await canNotify())) return;
  const results = await matchJobs(newJobs);
  const strong = newJobs.filter((j) => (results.get(j.id)?.score ?? 0) >= settings.discovery.notifyMinScore);
  if (!strong.length) return;
  const top = strong[0]!;
  await notify(
    `matches:${Date.now()}`,
    `${strong.length} new job match${strong.length > 1 ? 'es' : ''}`,
    `${top.title} at ${top.company}${strong.length > 1 ? ` and ${strong.length - 1} more` : ''} scored ${settings.discovery.notifyMinScore}+.`,
  );
}

const CLOSED = new Set(['rejected', 'withdrawn', 'offer']);

/** Notifies once per follow-up date; re-arms automatically when the user sets a new date. */
export async function checkFollowUps(now = new Date()): Promise<number> {
  const settings = await getSettings();
  if (!settings.notifications.followUps || !(await canNotify())) return 0;
  const due = (await listApplications()).filter((a) => {
    const at = parseDate(a.followUpAt);
    if (!at || at > now || CLOSED.has(a.status)) return false;
    const notified = parseDate(a.followUpNotifiedAt);
    return !notified || notified < at;
  });
  for (const app of due.slice(0, 3)) {
    const job = await getJob(app.jobId);
    await notify(`followup:${app.id}`, 'Follow-up due', job ? `${job.title} at ${job.company}` : 'An application needs a follow-up');
  }
  if (due.length > 3) await notify(`followup:more:${Date.now()}`, 'More follow-ups due', `${due.length - 3} more applications need a follow-up.`);
  for (const app of due) await patchApplication(app.id, (a) => ({ ...a, followUpNotifiedAt: nowIso() }));
  return due.length;
}

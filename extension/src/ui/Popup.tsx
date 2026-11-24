import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { requestView, type TabDetection } from '../lib/detection';
import { isInjectableUrl, restrictedSiteLabel } from '../lib/extraction/sites';
import { profileCompletion, profileIsEmpty } from '../lib/matching/service';
import { send, type ViewId } from '../lib/messages';
import { SESSION_KEYS } from '../lib/storage/schema';
import { Alert, Badge, Button, Loading, Meter, ScorePill } from './components';
import { useAction, useApplications, useJobs, useMatch, useProfile, useSessionValue, useSettings, useTabDetection } from './hooks';
import { Icon } from './icons';
import { STATUS_LABEL, STATUS_TONE } from './labels';
import { useJobContext } from './panel/shared';

const NEEDS_ACCESS_TTL_MS = 2 * 60_000;

interface ActiveTab {
  id: number;
  windowId: number;
  url?: string;
}

/**
 * Toolbar popup. Opening it grants access to the current page (activeTab), so
 * everything the panel then does on this tab works. Buttons that open the side
 * panel call sidePanel.open first, synchronously, inside the click.
 */
export function Popup() {
  const [tab, setTab] = useState<ActiveTab | null>();
  useEffect(() => {
    void browser.tabs.query({ active: true, currentWindow: true }).then(([t]) => setTab(t?.id !== undefined && t.windowId !== undefined ? { id: t.id, windowId: t.windowId, url: t.url } : null));
  }, []);
  const profile = useProfile();
  const settings = useSettings();
  const apps = useApplications();
  const jobs = useJobs();
  const detection = useTabDetection(tab === undefined ? undefined : (tab?.id ?? null));
  const context = useJobContext(tab === undefined ? undefined : (tab?.id ?? null));
  const needsAccess = useSessionValue<{ tabId: number; at: number }>(SESSION_KEYS.autofillNeedsAccess);
  const job = detection?.outcome.status === 'ok' ? detection.outcome.job : (context ?? null);
  const match = useMatch(job, profile, settings);

  const analyze = useAction(async () => {
    if (!tab) throw new Error('No active tab.');
    return send<TabDetection>({ type: 'tab/analyze', tabId: tab.id });
  });

  const recent = useMemo(() => {
    if (!apps || !jobs) return [];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return [...apps].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3).map((a) => ({ app: a, job: byId.get(a.jobId) }));
  }, [apps, jobs]);

  /** Opens the side panel (must be the first call in the click), then runs `then` and closes the popup. */
  const openPanel = (then: () => Promise<unknown>) => {
    if (!tab) return;
    const opened = browser.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
    void Promise.all([opened, then()]).finally(() => window.close());
  };
  const autofill = () => openPanel(() => browser.storage.session.set({ [SESSION_KEYS.autofillRequest]: { tabId: tab!.id, at: Date.now() } }));
  const view = (v: ViewId) => openPanel(() => requestView(v));

  if (!profile || tab === undefined) return <Shell><Loading /></Shell>;
  const empty = profileIsEmpty(profile);
  const completion = profileCompletion(profile);
  // Without a URL (rare), let the panel try and report what happened.
  const injectable = !tab?.url || isInjectableUrl(tab.url);
  const restricted = tab?.url ? restrictedSiteLabel(tab.url) : null;
  // A recent Autofill on this tab failed for lack of access; opening this popup has just granted it.
  const pending = needsAccess && tab && needsAccess.tabId === tab.id && Date.now() - needsAccess.at < NEEDS_ACCESS_TTL_MS;

  return (
    <Shell>
      {pending && (
        <Alert tone="accent" title="Ready to continue">
          <p>Job Copilot now has access to this page.</p>
          <div className="mt-2">
            <Button variant="primary" icon={<Icon.Form size={15} />} onClick={autofill}>
              Continue autofill
            </Button>
          </div>
        </Alert>
      )}

      {empty ? (
        <div className="flex flex-col gap-2 rounded-lg border border-accent/40 bg-accent-soft p-3">
          <p className="font-semibold">Add your résumé to get started</p>
          <p className="text-[12.5px]">It’s read in your browser and never uploaded.</p>
          <Button variant="primary" icon={<Icon.Upload size={15} />} disabled={!tab} onClick={() => view('profile')}>
            Upload résumé
          </Button>
        </div>
      ) : (
        <Button variant="primary" className="h-11! w-full text-[15px]!" icon={<Icon.Form size={18} />} disabled={!tab || !injectable} onClick={autofill}>
          Autofill this application
        </Button>
      )}
      {!injectable && tab && !empty && (
        <p className="text-center text-[12px] text-muted">{restricted ? `Autofill stays off on ${restricted} (its terms forbid it). It works once Apply takes you to the company’s own form.` : 'Open a job application page to autofill it.'}</p>
      )}

      <section aria-label="This page" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <p className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">This page</p>
        {job ? (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{job.title || 'Untitled role'}</p>
              <p className="truncate text-[12.5px] text-muted">{job.company || 'Unknown company'}</p>
            </div>
            {match && <ScorePill score={match.score} />}
          </div>
        ) : restricted || detection?.outcome.status === 'restricted' ? (
          <p className="text-[12.5px] text-muted">{restricted ?? (detection?.outcome.status === 'restricted' ? detection.outcome.site : '')} isn’t read or automated, by its terms. You can paste the job in the side panel’s Job tab.</p>
        ) : detection?.outcome.status === 'not_job' ? (
          <p className="text-[12.5px] text-muted">No job posting found here.</p>
        ) : (
          <p className="text-[12.5px] text-muted">See how a job posting matches your profile.</p>
        )}
        {analyze.error && <Alert tone="bad">{analyze.error}</Alert>}
        <div className="flex gap-2">
          {job ? (
            <Button size="sm" icon={<Icon.Target size={14} />} onClick={() => view('job')}>
              Match details
            </Button>
          ) : restricted ? (
            <Button size="sm" icon={<Icon.Clipboard size={14} />} onClick={() => view('job')}>
              Paste job
            </Button>
          ) : (
            <Button size="sm" icon={<Icon.Search size={14} />} busy={analyze.busy} disabled={!tab || !injectable} onClick={() => void analyze.run()}>
              Analyze job
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Icon.Panel size={14} />} disabled={!tab} onClick={() => view('home')}>
            Open side panel
          </Button>
        </div>
      </section>

      {!empty && (
        <button type="button" className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left hover:border-accent" onClick={() => view('profile')}>
          <span className="text-[12.5px] font-medium">Profile</span>
          <Meter value={completion.percent / 100} label="Profile completeness" />
          <span className="shrink-0 text-[11.5px] text-muted tabular-nums">{completion.percent}%</span>
        </button>
      )}

      {recent.length > 0 && (
        <section aria-label="Recent applications" className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Recent applications</p>
            <Button size="sm" variant="ghost" onClick={() => view('tracker')}>
              Tracker
            </Button>
          </div>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
            {recent.map(({ app, job: j }) => (
              <li key={app.id} className="flex items-center gap-2 px-3 py-1.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium">{j?.title || 'Untitled role'}</p>
                  <p className="truncate text-[11.5px] text-muted">{j?.company || ''}</p>
                </div>
                <Badge tone={STATUS_TONE[app.status]}>{STATUS_LABEL[app.status]}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-[360px] flex-col gap-3 bg-canvas p-3">
      <header className="flex items-center gap-2">
        <img src="/icon/32.png" alt="" width={20} height={20} />
        <h1 className="flex-1 text-[14px] font-semibold">Job Copilot</h1>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-subtle hover:text-fg"
          onClick={() => {
            void browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') });
            window.close();
          }}
        >
          Dashboard <Icon.External size={12} />
        </button>
      </header>
      {children}
    </div>
  );
}

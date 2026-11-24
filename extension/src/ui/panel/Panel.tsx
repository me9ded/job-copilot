import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import type { UiRequest } from '../../lib/detection';
import type { ViewId } from '../../lib/messages';
import { SESSION_KEYS } from '../../lib/storage/schema';
import type { AutofillRequest } from '../autofill';
import { cx, ToastProvider } from '../components';
import { useActiveTabId, useSessionValue } from '../hooks';
import { Icon } from '../icons';
import { NavCtx, type Nav } from '../permission';
import { AutofillTab } from './AutofillTab';
import { HomeTab } from './HomeTab';
import { JobTab } from './JobTab';
import { ProfileTab } from './ProfileTab';
import { SettingsTab } from './SettingsTab';
import { openDashboard, type PanelTab } from './shared';
import { TrackerTab } from './TrackerTab';

const TABS: Array<{ id: Exclude<PanelTab, 'settings'>; label: string; icon: (p: { size?: number }) => ReactNode }> = [
  { id: 'home', label: 'Home', icon: Icon.Home },
  { id: 'job', label: 'Job', icon: Icon.Target },
  { id: 'autofill', label: 'Autofill', icon: Icon.Form },
  { id: 'profile', label: 'Profile', icon: Icon.User },
  { id: 'tracker', label: 'Tracker', icon: Icon.Columns },
];

const TITLES: Record<PanelTab, string> = { home: 'Home', job: 'This job', autofill: 'Autofill', profile: 'Career profile', tracker: 'Applications', settings: 'Settings' };

/** Dashboard views the panel shows itself; the rest open in the full-page dashboard. */
const VIEW_TAB: Partial<Record<ViewId, PanelTab>> = {
  home: 'home',
  current: 'job',
  job: 'job',
  autofill: 'autofill',
  profile: 'profile',
  tracker: 'tracker',
  applications: 'tracker',
  settings: 'settings',
};

const UI_REQUEST_TTL_MS = 30_000;

/** The side panel: Home · Job · Autofill · Profile · Tracker, with Settings in the header. */
export function Panel() {
  const tabId = useActiveTabId();
  const [tab, setTab] = useState<PanelTab>('home');
  // Tabs stay mounted once opened, so drafts and edits survive switching.
  const [visited, setVisited] = useState<Set<PanelTab>>(new Set(['home']));
  const uiRequest = useSessionValue<UiRequest>(SESSION_KEYS.uiRequest);
  const autofillRequest = useSessionValue<AutofillRequest>(SESSION_KEYS.autofillRequest);

  const go = (t: PanelTab) => {
    setTab(t);
    setVisited((v) => (v.has(t) ? v : new Set([...v, t])));
    document.getElementById('main')?.scrollTo({ top: 0 });
  };

  // The popup / a notification asked for a view.
  useEffect(() => {
    if (!uiRequest) return;
    void browser.storage.session.remove(SESSION_KEYS.uiRequest);
    if (Date.now() - uiRequest.at > UI_REQUEST_TTL_MS) return;
    const t = VIEW_TAB[uiRequest.view];
    if (t) go(t);
    else openDashboard(uiRequest.view);
  }, [uiRequest]);

  // An autofill request (popup, shortcut, right-click) is handled by the Autofill tab.
  useEffect(() => {
    if (autofillRequest && autofillRequest.tabId === tabId) go('autofill');
  }, [autofillRequest, tabId]);

  const nav = useMemo<Nav>(
    () => ({
      view: tab === 'tracker' ? 'applications' : (tab as ViewId),
      jobId: null,
      layout: 'panel',
      go: (view) => {
        const t = VIEW_TAB[view];
        if (t) go(t);
        else openDashboard(view);
      },
    }),
    [tab],
  );

  const panes: Record<PanelTab, ReactNode> = {
    home: <HomeTab tabId={tabId} go={go} />,
    job: <JobTab tabId={tabId} go={go} />,
    autofill: <AutofillTab tabId={tabId} go={go} />,
    profile: <ProfileTab />,
    tracker: <TrackerTab />,
    settings: <SettingsTab />,
  };

  return (
    <NavCtx.Provider value={nav}>
      <ToastProvider>
        <div className="flex h-screen flex-col">
          <header className="flex items-center gap-2 border-b border-line bg-surface px-3 py-1.5">
            <img src="/icon/32.png" alt="" width={20} height={20} />
            <h1 className="min-w-0 flex-1 truncate text-[14px] font-semibold">
              <span className="sr-only">Job Copilot: </span>
              {TITLES[tab]}
            </h1>
            <button type="button" aria-label="Settings" aria-pressed={tab === 'settings'} className={cx('rounded-md p-1.5 hover:bg-subtle', tab === 'settings' ? 'text-accent' : 'text-muted hover:text-fg')} onClick={() => go(tab === 'settings' ? 'home' : 'settings')}>
              <Icon.Gear size={17} />
            </button>
            <button type="button" className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-muted hover:bg-subtle hover:text-fg" onClick={() => openDashboard()} title="Open the full-page dashboard">
              Expand <Icon.External size={12} />
            </button>
          </header>
          <main id="main" className="flex-1 overflow-x-hidden overflow-y-auto p-3">
            {(Object.keys(panes) as PanelTab[]).map((t) =>
              visited.has(t) || t === tab ? (
                <div key={t} hidden={t !== tab} role="tabpanel" id={`pane-${t}`} aria-label={TITLES[t]}>
                  {panes[t]}
                </div>
              ) : null,
            )}
          </main>
          <nav aria-label="Sections" className="grid grid-cols-5 border-t border-line bg-surface">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? 'page' : undefined}
                onClick={() => go(t.id)}
                className={cx('flex flex-col items-center gap-0.5 py-1.5 text-[11px] font-medium', tab === t.id ? 'text-accent' : 'text-muted hover:text-fg')}
              >
                <t.icon size={18} />
                {t.label}
              </button>
            ))}
          </nav>
        </div>
      </ToastProvider>
    </NavCtx.Provider>
  );
}

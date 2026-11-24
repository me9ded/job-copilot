import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ViewId } from '../lib/messages';
import { cx, ToastProvider } from './components';
import { Icon } from './icons';
import { NavCtx, type Nav } from './permission';
import { ApplicationsView } from './views/Applications';
import { InterviewPrepView } from './views/InterviewPrep';
import { MatchesView, SavedJobsView } from './views/JobLists';
import { ResumeStudioView } from './views/ResumeStudio';
import { SettingsView } from './views/Settings';

const NAV: Array<{ id: ViewId; label: string; short: string; icon: (p: { size?: number }) => ReactNode }> = [
  { id: 'matches', label: 'Job Matches', short: 'Matches', icon: Icon.Compass },
  { id: 'saved', label: 'Saved Jobs', short: 'Saved', icon: Icon.Bookmark },
  { id: 'applications', label: 'Applications', short: 'Tracker', icon: Icon.Columns },
  { id: 'studio', label: 'Résumé Studio', short: 'Résumé', icon: Icon.Doc },
  { id: 'prep', label: 'Interview Prep', short: 'Prep', icon: Icon.Chat },
  { id: 'settings', label: 'Settings', short: 'Settings', icon: Icon.Gear },
];

/** Views that exist only in the side panel. */
const PANEL_ONLY = new Set<ViewId>(['current', 'home', 'job', 'autofill', 'tracker']);

function parseHash(hash: string): { view: ViewId; jobId: string | null } | null {
  const [v, id] = hash.replace(/^#/, '').split('/');
  const parsed = ViewId.safeParse(v);
  if (!parsed.success || PANEL_ONLY.has(parsed.data)) return null;
  return { view: parsed.data, jobId: id ? decodeURIComponent(id) : null };
}

/** The full-page dashboard ("All tools"). The side panel (ui/panel) covers the day-to-day flow. */
export function App() {
  const fallback: ViewId = 'saved';
  const [state, setState] = useState<{ view: ViewId; jobId: string | null }>(() => parseHash(location.hash) ?? { view: fallback, jobId: null });

  const go = useCallback((view: ViewId, jobId: string | null = null) => {
    const v = view === 'tracker' ? 'applications' : PANEL_ONLY.has(view) ? fallback : view;
    setState({ view: v, jobId });
    history.replaceState(null, '', `#${v}${jobId ? `/${encodeURIComponent(jobId)}` : ''}`);
    document.getElementById('main')?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onHash = () => {
      const h = parseHash(location.hash);
      if (h) setState(h);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const nav = useMemo<Nav>(() => ({ ...state, go, layout: 'full' }), [state, go]);
  const items = NAV;
  const active = state.view === 'profile' ? 'studio' : state.view;

  const content = (
    <>
      {state.view === 'matches' && <MatchesView />}
      {state.view === 'saved' && <SavedJobsView />}
      {state.view === 'applications' && <ApplicationsView />}
      {state.view === 'studio' && <ResumeStudioView />}
      {state.view === 'profile' && <ResumeStudioView initialTab="profile" />}
      {state.view === 'prep' && <InterviewPrepView />}
      {state.view === 'settings' && <SettingsView />}
    </>
  );

  return (
    <NavCtx.Provider value={nav}>
      <ToastProvider>
          <div className="flex min-h-screen">
            <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-surface p-3 md:flex">
              <div className="mb-4 px-2 pt-1">
                <Brand />
              </div>
              <nav aria-label="Sections" className="flex flex-col gap-0.5">
                {items.map((n) => (
                  <button
                    key={n.id}
                    type="button"
                    aria-current={active === n.id ? 'page' : undefined}
                    onClick={() => go(n.id)}
                    className={cx('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13.5px] font-medium', active === n.id ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-subtle hover:text-fg')}
                  >
                    <n.icon size={17} />
                    {n.label}
                  </button>
                ))}
              </nav>
              <p className="mt-auto px-2 text-[11.5px] text-muted">Your data stays in this browser.</p>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <nav aria-label="Sections" className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-2 py-1.5 md:hidden">
                {items.map((n) => (
                  <button key={n.id} type="button" aria-current={active === n.id ? 'page' : undefined} onClick={() => go(n.id)} className={cx('shrink-0 rounded-md px-2.5 py-1 text-[13px] font-medium', active === n.id ? 'bg-accent-soft text-accent' : 'text-muted')}>
                    {n.short}
                  </button>
                ))}
              </nav>
              <main id="main" className="mx-auto w-full max-w-5xl flex-1 p-5">
                {content}
              </main>
            </div>
          </div>
      </ToastProvider>
    </NavCtx.Provider>
  );
}

function Brand() {
  return (
    <span className="inline-flex items-center gap-2 text-[14px] font-semibold">
      <img src="/icon/32.png" alt="" width={20} height={20} />
      Job Copilot
    </span>
  );
}

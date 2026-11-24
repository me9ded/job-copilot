import { useEffect, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { SESSION_KEYS } from '../../lib/storage/schema';
import type { ApplicationStatus, ExtractedJob } from '../../lib/types';
import { cx } from '../components';

/** The panel's sections, in tab-bar order (Settings is reached from the header). */
export type PanelTab = 'home' | 'job' | 'autofill' | 'profile' | 'tracker' | 'settings';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function when(d: string): string {
  if (d === 'present') return 'Present';
  const m = /^(\d{4})-(\d{2})$/.exec(d);
  return m ? `${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : d;
}
export const range = (start: string, end: string) => [start, end].filter(Boolean).map(when).join(' – ');

export function openDashboard(hash = ''): void {
  void browser.tabs.create({ url: browser.runtime.getURL(`/dashboard.html${hash ? `#${hash}` : ''}`) });
}

/** The job last analyzed in this tab. Kept across navigation, so Apply → form still knows the job. */
export function useJobContext(tabId: number | null | undefined): ExtractedJob | null | undefined {
  const [job, setJob] = useState<ExtractedJob | null>();
  useEffect(() => {
    if (tabId === undefined) return;
    if (tabId === null) {
      setJob(null);
      return;
    }
    const key = SESSION_KEYS.jobContext(tabId);
    let alive = true;
    void browser.storage.session.get(key).then((v) => alive && setJob((v[key] as ExtractedJob | undefined) ?? null));
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && key in changes) setJob((changes[key]!.newValue as ExtractedJob | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, [tabId]);
  return job;
}

export function setJobContext(tabId: number, job: ExtractedJob | null): Promise<void> {
  const key = SESSION_KEYS.jobContext(tabId);
  return job ? browser.storage.session.set({ [key]: job }) : browser.storage.session.remove(key);
}

/** The five stages people track, over the ten detailed statuses. */
export type Stage = 'saved' | 'applied' | 'interview' | 'offer' | 'rejected';
export const STAGES: Array<{ id: Stage; label: string; statuses: ApplicationStatus[] }> = [
  { id: 'saved', label: 'Saved', statuses: ['discovered', 'saved', 'to_review', 'preparing', 'ready'] },
  { id: 'applied', label: 'Applied', statuses: ['applied'] },
  { id: 'interview', label: 'Interview', statuses: ['interviewing'] },
  { id: 'offer', label: 'Offer', statuses: ['offer'] },
  { id: 'rejected', label: 'Rejected', statuses: ['rejected', 'withdrawn'] },
];
export const stageOf = (s: ApplicationStatus): Stage => STAGES.find((x) => x.statuses.includes(s))!.id;
/** The status a stage moves an application to. */
export const STAGE_STATUS: Record<Stage, ApplicationStatus> = { saved: 'saved', applied: 'applied', interview: 'interviewing', offer: 'offer', rejected: 'rejected' };

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h2 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">{children}</h2>
      {action}
    </div>
  );
}

export function StatTile({ label, value, onClick }: { label: string; value: ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <span className="text-[18px] leading-tight font-semibold tabular-nums">{value}</span>
      <span className="text-[11.5px] text-muted">{label}</span>
    </>
  );
  const cls = 'flex min-w-0 flex-col items-start rounded-lg border border-line bg-surface px-2.5 py-2 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} className={cx(cls, 'hover:border-accent')}>
      {body}
    </button>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Chip({ children, active, onClick, count }: { children: ReactNode; active?: boolean; onClick?: () => void; count?: number }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cx('inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] font-medium', active ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-muted hover:text-fg')}
    >
      {children}
      {count !== undefined && <span className="tabular-nums opacity-80">{count}</span>}
    </button>
  );
}

/** Shows a value, or a visible "not found" so parsing gaps stand out. */
export function Val({ v, missing }: { v: string; missing: string }) {
  return v ? <>{v}</> : <span className="text-warn italic">{missing}</span>;
}

export function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

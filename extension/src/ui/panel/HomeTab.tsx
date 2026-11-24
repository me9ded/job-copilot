import { useMemo } from 'react';
import { profileCompletion, profileIsEmpty } from '../../lib/matching/service';
import { getAutofillLog } from '../../lib/storage/repo';
import { KEYS } from '../../lib/storage/schema';
import type { AutofillLogEntry } from '../../lib/types';
import { formatRelative } from '../../lib/util';
import { Badge, Button, Loading, Meter, ScorePill } from '../components';
import { useApplications, useJobs, useMatch, useProfile, useSettings, useStored, useTabDetection } from '../hooks';
import { Icon } from '../icons';
import { STATUS_LABEL, STATUS_TONE } from '../labels';
import { SectionTitle, StatTile, stageOf, useJobContext, type PanelTab } from './shared';

const useAutofillLog = () => useStored<AutofillLogEntry[]>(getAutofillLog, (k, a) => a === 'local' && k === KEYS.autofillLog);

const STOP_SHORT: Record<string, string> = {
  submit_ready: 'ready to submit',
  done: 'filled',
  needs_answers: 'needed answers',
  errors: 'form showed errors',
  captcha: 'paused at CAPTCHA',
  login: 'needed sign-in',
  navigating: 'page was loading',
  needs_access: 'needed page access',
  max_steps: 'stopped (many steps)',
  no_form: 'no form found',
};

export function HomeTab({ tabId, go }: { tabId: number | null | undefined; go: (t: PanelTab) => void }) {
  const profile = useProfile();
  const settings = useSettings();
  const apps = useApplications();
  const jobs = useJobs();
  const log = useAutofillLog();
  const detection = useTabDetection(tabId);
  const context = useJobContext(tabId);
  const pageJob = detection?.outcome.status === 'ok' ? detection.outcome.job : (context ?? null);
  const match = useMatch(pageJob, profile, settings);

  const recent = useMemo(() => {
    if (!apps || !jobs) return [];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return [...apps].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 3).map((a) => ({ app: a, job: byId.get(a.jobId) }));
  }, [apps, jobs]);

  if (!profile || !apps) return <Loading />;
  const empty = profileIsEmpty(profile);
  const completion = profileCompletion(profile);
  const count = (stage: ReturnType<typeof stageOf>) => apps.filter((a) => stageOf(a.status) === stage).length;
  const firstName = profile.basics.name.split(/\s+/)[0];

  return (
    <div className="flex flex-col gap-3">
      {empty ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-accent/40 bg-accent-soft p-3.5">
          <p className="text-[15px] font-semibold">Start with your résumé</p>
          <p className="text-[12.5px]">Upload it once (PDF or Word). Job Copilot reads it in your browser and uses it to fill applications, draft answers and score jobs. Nothing is uploaded.</p>
          <Button variant="primary" icon={<Icon.Upload size={15} />} onClick={() => go('profile')}>
            Upload résumé
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">{firstName ? `Hi ${firstName}` : 'Your profile'}</p>
            <div className="mt-1 flex items-center gap-2">
              <Meter value={completion.percent / 100} label="Profile completeness" />
              <span className="shrink-0 text-[11.5px] text-muted tabular-nums">{completion.percent}% complete</span>
            </div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => go('profile')}>
            Review
          </Button>
        </div>
      )}

      <section aria-label="This page" className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3">
        <SectionTitle>This page</SectionTitle>
        {pageJob ? (
          <div className="flex items-start gap-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold">{pageJob.title || 'Untitled role'}</p>
              <p className="truncate text-[12.5px] text-muted">{pageJob.company || 'Unknown company'}</p>
            </div>
            {match && <ScorePill score={match.score} />}
          </div>
        ) : detection?.outcome.status === 'restricted' ? (
          <p className="text-[12.5px] text-muted">{detection.outcome.site} isn’t read or automated. Paste a job in the Job tab; Autofill works on the company’s own application form.</p>
        ) : (
          <p className="text-[12.5px] text-muted">On a job posting, analyze it to see your match. On an application form, press Autofill.</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Button variant="primary" icon={<Icon.Form size={15} />} disabled={empty} onClick={() => go('autofill')}>
            Autofill
          </Button>
          <Button icon={<Icon.Target size={15} />} onClick={() => go('job')}>
            {pageJob ? 'See match' : 'Analyze job'}
          </Button>
        </div>
      </section>

      <div className="grid grid-cols-4 gap-1.5">
        <StatTile label="Saved" value={count('saved')} onClick={() => go('tracker')} />
        <StatTile label="Applied" value={count('applied')} onClick={() => go('tracker')} />
        <StatTile label="Interview" value={count('interview')} onClick={() => go('tracker')} />
        <StatTile label="Offers" value={count('offer')} onClick={() => go('tracker')} />
      </div>

      <section aria-label="Recent applications" className="flex flex-col gap-1.5">
        <SectionTitle
          action={
            recent.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => go('tracker')}>
                All
              </Button>
            )
          }
        >
          Recent applications
        </SectionTitle>
        {recent.length ? (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
            {recent.map(({ app, job }) => (
              <li key={app.id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-medium">{job?.title || 'Untitled role'}</p>
                  <p className="truncate text-[11.5px] text-muted">
                    {job?.company || 'Unknown company'} · {formatRelative(app.updatedAt)}
                  </p>
                </div>
                <Badge tone={STATUS_TONE[app.status]}>{STATUS_LABEL[app.status]}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-muted">Nothing tracked yet. Save a job from the Job tab, or mark one as submitted after Autofill.</p>
        )}
      </section>

      {log && log.length > 0 && (
        <section aria-label="Autofill activity" className="flex flex-col gap-1.5">
          <SectionTitle>Autofill activity</SectionTitle>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
            {log.slice(0, 4).map((e) => (
              <li key={e.at} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{e.jobTitle || e.host || 'A form'}</span>
                  {e.company ? ` · ${e.company}` : ''}
                </span>
                <span className="shrink-0 text-muted">
                  {e.filled} fields, {STOP_SHORT[e.stop] ?? e.stop} · {formatRelative(e.at)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { findDuplicate } from '../../lib/jobs';
import { fitSummary } from '../../lib/matching/fit';
import { profileIsEmpty } from '../../lib/matching/service';
import { send } from '../../lib/messages';
import { setJobSaved, upsertJob } from '../../lib/storage/repo';
import type { ExtractedJob } from '../../lib/types';
import { nowIso } from '../../lib/util';
import type { TabDetection } from '../../lib/detection';
import { Alert, Button, Card, EmptyState, Loading, useToast } from '../components';
import { useAction, useJobs, useMatch, useProfile, useSettings, useTabDetection } from '../hooks';
import { Icon } from '../icons';
import { Description, ExtractionWarnings, JobHeader, MatchPanel } from '../job-parts';
import { ManualJobDialog } from '../views/ManualJob';
import { SectionTitle, useJobContext, type PanelTab } from './shared';

/** The job in the current tab: analysis, fit, and Save. */
export function JobTab({ tabId, go }: { tabId: number | null | undefined; go: (t: PanelTab) => void }) {
  const detection = useTabDetection(tabId);
  const context = useJobContext(tabId);
  const profile = useProfile();
  const settings = useSettings();
  const jobs = useJobs();
  const toast = useToast();
  const [manual, setManual] = useState<{ open: boolean; seed?: Partial<ExtractedJob> }>({ open: false });

  const analyze = useAction(async () => {
    if (!tabId) throw new Error('No active tab.');
    return send<TabDetection>({ type: 'tab/analyze', tabId });
  });

  // The job on this page, or the one analyzed earlier in this tab (e.g. before pressing Apply).
  const pageJob = detection?.outcome.status === 'ok' ? detection.outcome.job : null;
  const job = pageJob ?? context ?? null;
  const match = useMatch(job, profile, settings);
  const fit = useMemo(() => (match ? fitSummary(match) : null), [match]);
  const existing = job && jobs ? findDuplicate(job, jobs)?.job : undefined;

  const save = useAction(async () => {
    if (!job) return;
    const { job: rec } = await upsertJob(job, 'page', { saved: true, savedAt: nowIso() });
    await setJobSaved(rec.id, true);
    toast('Saved to your tracker', 'good');
  });

  if (detection === undefined || !profile || !settings) return <Loading />;

  const restricted = detection?.outcome.status === 'restricted' ? detection.outcome.site : null;
  const notJob = detection?.outcome.status === 'not_job' ? detection.outcome.reason : null;

  if (!job)
    return (
      <div className="flex flex-col gap-3">
        {restricted ? (
          <Alert tone="neutral" title={`${restricted} isn’t read automatically`}>
            <p>{restricted}’s terms don’t allow add-ons to read or automate its pages, so Job Copilot stays off there. Paste the job description to see how you match, and autofill works once “Apply” takes you to the company’s own application form.</p>
            <div className="mt-2">
              <Button size="sm" variant="primary" icon={<Icon.Clipboard size={14} />} onClick={() => setManual({ open: true, seed: { url: detection?.url } })}>
                Paste job description
              </Button>
            </div>
          </Alert>
        ) : (
          <EmptyState
            icon={<Icon.Target size={22} />}
            title={notJob ? 'No job posting found on this page' : 'See how you match this job'}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" icon={<Icon.Search size={15} />} busy={analyze.busy} disabled={!tabId} onClick={() => void analyze.run()}>
                  Analyze this page
                </Button>
                <Button icon={<Icon.Clipboard size={15} />} onClick={() => setManual({ open: true })}>
                  Paste a job
                </Button>
              </div>
            }
          >
            {notJob ? `${notJob}. Open the job posting itself, or paste its description.` : 'Open a job posting and press Analyze. It reads only this page, and only when you ask.'}
          </EmptyState>
        )}
        {analyze.error && <Alert tone="bad">{analyze.error}</Alert>}
        <ManualJobDialog open={manual.open} seed={manual.seed} onClose={() => setManual({ open: false })} />
      </div>
    );

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <JobHeader
          job={job}
          actions={
            <>
              {existing?.saved ? (
                <Button size="sm" icon={<Icon.Check size={14} />} onClick={() => go('tracker')}>
                  Saved · open tracker
                </Button>
              ) : (
                <Button size="sm" variant="primary" icon={<Icon.Bookmark size={14} />} busy={save.busy} onClick={() => void save.run()}>
                  Save job
                </Button>
              )}
              <Button size="sm" icon={<Icon.Form size={14} />} onClick={() => go('autofill')}>
                Autofill application
              </Button>
              <Button size="sm" variant="ghost" icon={<Icon.Refresh size={14} />} busy={analyze.busy} disabled={!tabId} onClick={() => void analyze.run()}>
                Re-analyze
              </Button>
            </>
          }
        />
        {!pageJob && context && <p className="mt-2 text-[12px] text-muted">Analyzed earlier in this tab. This page itself isn’t a job posting (an application form, for example).</p>}
      </Card>
      {analyze.error && <Alert tone="bad">{analyze.error}</Alert>}
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <ExtractionWarnings job={job} onEdit={() => setManual({ open: true, seed: existing ?? job })} />

      {profileIsEmpty(profile) ? (
        <Alert tone="warn" title="Add your résumé to see your match" action={<Button size="sm" onClick={() => go('profile')}>Open profile</Button>}>
          The score compares this job with your own profile.
        </Alert>
      ) : match === undefined ? (
        <Loading label="Scoring…" />
      ) : match ? (
        <>
          {fit && (fit.reasons.length > 0 || fit.weaknesses.length > 0) && (
            <Card>
              <div className="flex flex-col gap-3 text-[12.5px]">
                {fit.reasons.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <SectionTitle>Reasons to apply</SectionTitle>
                    <ul className="flex flex-col gap-1">
                      {fit.reasons.map((r) => (
                        <li key={r} className="flex gap-1.5">
                          <Icon.Check size={14} className="mt-0.5 shrink-0 text-good" />
                          <span>{r}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {fit.weaknesses.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <SectionTitle>Potential gaps</SectionTitle>
                    <ul className="flex flex-col gap-1">
                      {fit.weaknesses.map((w) => (
                        <li key={w} className="flex gap-1.5">
                          <Icon.Alert size={14} className="mt-0.5 shrink-0 text-warn" />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </Card>
          )}
          <MatchPanel match={match} job={job} profile={profile} settings={settings} compact />
        </>
      ) : null}

      <details className="rounded-lg border border-line bg-surface">
        <summary className="cursor-pointer px-3.5 py-2.5 text-[13px] font-semibold select-none">Job description</summary>
        <div className="border-t border-line p-3">
          <Description job={job} />
        </div>
      </details>
      {job.applyUrl && /^https?:\/\//i.test(job.applyUrl) && job.applyUrl !== detection?.url && (
        <Button size="sm" variant="ghost" icon={<Icon.External size={14} />} onClick={() => void browser.tabs.update(tabId ?? undefined, { url: job.applyUrl })}>
          Open the application page
        </Button>
      )}
      <ManualJobDialog open={manual.open} seed={manual.seed} onClose={() => setManual({ open: false })} />
    </div>
  );
}

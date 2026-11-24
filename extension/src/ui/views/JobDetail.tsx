import { useState } from 'react';
import { jobFreshness } from '../../lib/jobs';
import { profileIsEmpty } from '../../lib/matching/service';
import { deleteJob, ensureApplication, patchJob, setJobDismissed, setJobSaved } from '../../lib/storage/repo';
import type { JobRecord } from '../../lib/types';
import { Alert, Badge, Button, Card, Dialog, Loading, Select, TextArea, useToast } from '../components';
import { useAction, useApplications, useMatch, useProfile, useSettings } from '../hooks';
import { Icon } from '../icons';
import { Description, ExtractionWarnings, JobHeader, MatchPanel } from '../job-parts';
import { STATUS_LABEL } from '../labels';
import { useNav } from '../permission';
import { ManualJobDialog } from './ManualJob';

export function FreshnessBadge({ job, staleAfterDays }: { job: JobRecord; staleAfterDays: number }) {
  const f = jobFreshness(job, staleAfterDays);
  if (f.state === 'fresh') return null;
  return (
    <Badge tone={f.state === 'expired' ? 'bad' : 'warn'} title={f.reason}>
      {f.state === 'expired' ? 'Expired' : 'Stale'}
    </Badge>
  );
}

export function JobDetail({ job, onBack }: { job: JobRecord; onBack: () => void }) {
  const profile = useProfile();
  const settings = useSettings();
  const apps = useApplications();
  const match = useMatch(job, profile, settings);
  const nav = useNav();
  const toast = useToast();
  const [tab, setTab] = useState<'match' | 'description' | 'notes'>('match');
  const [notes, setNotes] = useState(job.notes);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const app = apps?.find((a) => a.jobId === job.id);
  const isLink = /^https?:\/\//.test(job.url);

  const act = useAction(async (fn: () => Promise<unknown>, msg?: string) => {
    await fn();
    if (msg) toast(msg, 'good');
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Button size="sm" variant="ghost" icon={<Icon.ArrowLeft size={14} />} onClick={onBack}>
          Back
        </Button>
        {settings && <FreshnessBadge job={job} staleAfterDays={settings.staleAfterDays} />}
      </div>
      <Card>
        <JobHeader
          job={job}
          actions={
            <>
              <Button
                variant={job.saved ? 'secondary' : 'primary'}
                icon={<Icon.Bookmark size={15} />}
                busy={act.busy}
                onClick={() => void act.run(() => setJobSaved(job.id, !job.saved), job.saved ? 'Removed from saved jobs' : 'Saved')}
              >
                {job.saved ? 'Unsave' : 'Save'}
              </Button>
              {isLink && (
                <a className="inline-flex h-8.5 items-center gap-1 rounded-md border border-line-strong px-3 text-[13px] font-medium hover:bg-subtle" href={job.url} target="_blank" rel="noopener noreferrer">
                  Original posting <Icon.External size={13} />
                </a>
              )}
              {job.applyUrl && /^https?:/.test(job.applyUrl) && (
                <a className="inline-flex h-8.5 items-center gap-1 px-2 text-[13px] font-medium text-accent" href={job.applyUrl} target="_blank" rel="noopener noreferrer">
                  Apply page <Icon.External size={13} />
                </a>
              )}
            </>
          }
        />
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
          <Button size="sm" icon={<Icon.Edit size={14} />} onClick={() => setEditing(true)}>
            Correct details
          </Button>
          <Button size="sm" icon={<Icon.Doc size={14} />} onClick={() => nav.go('studio', job.id)}>
            Tailor résumé
          </Button>
          <Button size="sm" icon={<Icon.Chat size={14} />} onClick={() => nav.go('prep', job.id)}>
            Interview prep
          </Button>
          {!job.dismissed ? (
            <Button size="sm" variant="ghost" onClick={() => void act.run(() => setJobDismissed(job.id, true), 'Dismissed')}>
              Dismiss
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void act.run(() => setJobDismissed(job.id, false), 'Restored')}>
              Restore
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void act.run(
                () => patchJob(job.id, (j) => ({ ...j, expired: !j.expired, expiredReason: j.expired ? undefined : 'Marked as closed by you', lastVerifiedAt: j.expired ? new Date().toISOString() : j.lastVerifiedAt })),
                job.expired ? 'Marked as open' : 'Marked as closed',
              )
            }
          >
            {job.expired ? 'Mark open' : 'Mark closed'}
          </Button>
          <Button size="sm" variant="danger" icon={<Icon.Trash size={14} />} onClick={() => setConfirmDelete(true)}>
            Delete
          </Button>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-[13px]">
          <span className="font-medium">Application</span>
          {app ? (
            <>
              <Badge tone="accent">{STATUS_LABEL[app.status]}</Badge>
              <Button size="sm" variant="ghost" onClick={() => nav.go('applications', job.id)}>
                Open in tracker
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void act.run(() => ensureApplication(job.id, 'to_review'), 'Added to tracker')}>
              Track application
            </Button>
          )}
        </div>
      </Card>
      {act.error && <Alert tone="bad">{act.error}</Alert>}
      <ExtractionWarnings job={job} onEdit={() => setEditing(true)} />

      <div role="tablist" aria-label="Job sections" className="flex gap-1">
        {(['match', 'description', 'notes'] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-md px-2.5 py-1 text-[13px] font-medium capitalize ${tab === t ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-subtle'}`}>
            {t}
          </button>
        ))}
      </div>

      {tab === 'match' &&
        (!profile || !settings || match === undefined ? (
          <Loading label="Scoring…" />
        ) : profileIsEmpty(profile) ? (
          <Alert tone="neutral" action={<Button size="sm" onClick={() => nav.go('profile')}>Set up profile</Button>}>
            Add your profile to see a match score.
          </Alert>
        ) : (
          match && <MatchPanel match={match} job={job} profile={profile} settings={settings} />
        ))}
      {tab === 'description' && (
        <Card>
          <Description job={job} />
        </Card>
      )}
      {tab === 'notes' && (
        <Card title="Notes" subtitle="Private notes about this job.">
          <TextArea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="Job notes" />
          <div className="mt-2 flex justify-end">
            <Button variant="primary" size="sm" busy={act.busy} disabled={notes === job.notes} onClick={() => void act.run(() => patchJob(job.id, (j) => ({ ...j, notes })), 'Notes saved')}>
              Save notes
            </Button>
          </div>
        </Card>
      )}

      <ManualJobDialog open={editing} seed={job} onClose={() => setEditing(false)} />
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this job?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await deleteJob(job.id);
                setConfirmDelete(false);
                toast('Job deleted');
                onBack();
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>This removes the job, its application record, cover letter and interview notes. Résumé versions are kept.</p>
      </Dialog>
    </div>
  );
}

export function SortSelect<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<[T, string]>; label: string }) {
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)} className="w-auto">
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </Select>
  );
}

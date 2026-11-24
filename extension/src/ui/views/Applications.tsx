import { useMemo, useState } from 'react';
import { applicationsToCsv } from '../../lib/export';
import { downloadBlob } from '../../lib/resume/export';
import { deleteApplication, patchApplication, setApplicationStatus } from '../../lib/storage/repo';
import { APPLICATION_STATUSES, type ApplicationRecord, type ApplicationStatus, type Contact, type JobRecord } from '../../lib/types';
import { formatDate, normalizeForCompare, uid } from '../../lib/util';
import { Alert, Badge, Button, Checkbox, Dialog, EmptyState, Field, IconButton, Input, Loading, PageHeader, ScorePill, Select, Tabs, TextArea, cx, useToast } from '../components';
import { useAction, useApplications, useCoverLetters, useJobs, useMatches, useProfile, useResumes, useSettings } from '../hooks';
import { Icon } from '../icons';
import { STATUS_LABEL, STATUS_TONE } from '../labels';
import { useNav } from '../permission';

const toDateInput = (iso?: string) => (iso ? iso.slice(0, 10) : '');
const fromDateInput = (v: string) => (v ? new Date(`${v}T09:00:00`).toISOString() : undefined);

export function ApplicationsView() {
  const apps = useApplications();
  const jobs = useJobs();
  const profile = useProfile();
  const settings = useSettings();
  const nav = useNav();
  const [mode, setMode] = useState<'board' | 'table'>(nav.layout === 'full' ? 'board' : 'table');
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<ApplicationStatus | 'all' | 'active'>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<ApplicationRecord | null>(null);
  const toast = useToast();

  const jobMap = useMemo(() => new Map((jobs ?? []).map((j) => [j.id, j])), [jobs]);
  const appJobs = useMemo(() => (apps ?? []).map((a) => jobMap.get(a.jobId)).filter(Boolean) as JobRecord[], [apps, jobMap]);
  const matches = useMatches(appJobs, profile, settings);

  // Deep link from a job: open its application.
  const linked = nav.view === 'applications' && nav.jobId ? apps?.find((a) => a.jobId === nav.jobId) : undefined;
  const openApp = apps?.find((a) => a.id === (openId ?? linked?.id));

  if (!apps || !jobs) return <Loading />;

  const nq = normalizeForCompare(q);
  const filtered = apps
    .filter((a) => {
      const j = jobMap.get(a.jobId);
      if (statusFilter === 'active' && ['rejected', 'withdrawn'].includes(a.status)) return false;
      if (statusFilter !== 'all' && statusFilter !== 'active' && a.status !== statusFilter) return false;
      return !nq || normalizeForCompare(`${j?.title} ${j?.company} ${a.notes} ${a.contacts.map((c) => c.name).join(' ')}`).includes(nq);
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const changeStatus = async (app: ApplicationRecord, status: ApplicationStatus) => {
    if (status === app.status) return;
    // Submission is only recorded after explicit confirmation.
    if (status === 'applied' && !app.submissionConfirmed) {
      setConfirmFor(app);
      return;
    }
    try {
      await setApplicationStatus(app.id, status);
      toast(`Moved to ${STATUS_LABEL[status]}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not update status', 'bad');
    }
  };

  const exportCsv = () => downloadBlob(applicationsToCsv(filtered, jobMap), `applications-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
  const dueSoon = apps.filter((a) => a.followUpAt && new Date(a.followUpAt) <= new Date(Date.now() + 86_400_000) && !['rejected', 'withdrawn', 'offer'].includes(a.status)).length;

  return (
    <div>
      <PageHeader
        title="Applications"
        description={`${filtered.length} shown${dueSoon ? ` · ${dueSoon} follow-up${dueSoon > 1 ? 's' : ''} due` : ''}`}
        actions={
          <Button size="sm" icon={<Icon.Download size={14} />} disabled={!filtered.length} onClick={exportCsv}>
            CSV
          </Button>
        }
      />
      <div className="mb-3 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Search applications" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-40 flex-1" />
          <Select aria-label="Status filter" className="w-auto" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="active">Active</option>
            <option value="all">All statuses</option>
            {APPLICATION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <Tabs
          label="View"
          value={mode}
          onChange={setMode}
          tabs={[
            { id: 'table', label: <span className="flex items-center gap-1"><Icon.Table size={14} /> Table</span> },
            { id: 'board', label: <span className="flex items-center gap-1"><Icon.Columns size={14} /> Board</span> },
          ]}
        />
      </div>

      {!apps.length ? (
        <EmptyState icon={<Icon.Columns size={28} />} title="No applications yet" action={<Button onClick={() => nav.go('saved')}>View saved jobs</Button>}>
          Saving a job adds it here in the “Saved” stage. Move it along as you prepare and apply.
        </EmptyState>
      ) : mode === 'table' ? (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead className="border-b border-line text-[12px] text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Job</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Score</th>
                <th className="px-3 py-2 font-medium">Applied</th>
                <th className="px-3 py-2 font-medium">Follow-up</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => {
                const j = jobMap.get(a.jobId);
                return (
                  <tr key={a.id} className="border-b border-line last:border-b-0 hover:bg-subtle/60">
                    <td className="max-w-56 px-3 py-2">
                      <button type="button" className="text-left" onClick={() => setOpenId(a.id)}>
                        <span className="block truncate font-medium">{j?.title ?? 'Deleted job'}</span>
                        <span className="block truncate text-[12px] text-muted">{j?.company}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <StatusSelect value={a.status} onChange={(s) => void changeStatus(a, s)} />
                    </td>
                    <td className="px-3 py-2">
                      <ScorePill score={j ? matches.get(j.id)?.score : null} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">{a.submissionConfirmed ? formatDate(a.appliedAt) : '—'}</td>
                    <td className={cx('px-3 py-2 whitespace-nowrap', a.followUpAt && new Date(a.followUpAt) < new Date() && 'font-medium text-warn')}>{formatDate(a.followUpAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Board apps={filtered} jobMap={jobMap} onOpen={setOpenId} onMove={(a, s) => void changeStatus(a, s)} />
      )}

      {openApp && <ApplicationDialog app={openApp} job={jobMap.get(openApp.jobId)} onClose={() => (setOpenId(null), linked && nav.go('applications'))} onStatus={(s) => void changeStatus(openApp, s)} />}
      <ConfirmAppliedDialog app={confirmFor} onClose={() => setConfirmFor(null)} />
    </div>
  );
}

function StatusSelect({ value, onChange }: { value: ApplicationStatus; onChange: (s: ApplicationStatus) => void }) {
  return (
    <Select aria-label="Status" className="h-7 w-auto text-[12.5px]" value={value} onChange={(e) => onChange(e.target.value as ApplicationStatus)}>
      {APPLICATION_STATUSES.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABEL[s]}
        </option>
      ))}
    </Select>
  );
}

function Board({ apps, jobMap, onOpen, onMove }: { apps: ApplicationRecord[]; jobMap: Map<string, JobRecord>; onOpen: (id: string) => void; onMove: (a: ApplicationRecord, s: ApplicationStatus) => void }) {
  const [over, setOver] = useState<ApplicationStatus | null>(null);
  return (
    <div className="flex gap-2 overflow-x-auto pb-2">
      {APPLICATION_STATUSES.map((status) => {
        const col = apps.filter((a) => a.status === status);
        return (
          <section
            key={status}
            aria-label={`${STATUS_LABEL[status]} (${col.length})`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(status);
            }}
            onDragLeave={() => setOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const a = apps.find((x) => x.id === e.dataTransfer.getData('text/plain'));
              if (a) onMove(a, status);
            }}
            className={cx('flex w-52 shrink-0 flex-col rounded-lg border bg-subtle/50 p-1.5', over === status ? 'border-accent' : 'border-line')}
          >
            <h3 className="flex items-center justify-between px-1.5 py-1 text-[12.5px] font-semibold">
              {STATUS_LABEL[status]} <span className="font-normal text-muted">{col.length}</span>
            </h3>
            <ul className="flex min-h-12 flex-col gap-1.5">
              {col.map((a) => {
                const j = jobMap.get(a.jobId);
                return (
                  <li key={a.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', a.id)} className="rounded-md border border-line bg-surface p-2 shadow-sm">
                    <button type="button" className="w-full text-left" onClick={() => onOpen(a.id)}>
                      <span className="block truncate text-[13px] font-medium">{j?.title ?? 'Deleted job'}</span>
                      <span className="block truncate text-[12px] text-muted">{j?.company}</span>
                    </button>
                    <div className="mt-1.5 flex items-center justify-between gap-1">
                      {a.followUpAt ? <Badge tone={new Date(a.followUpAt) < new Date() ? 'warn' : 'neutral'}>↻ {formatDate(a.followUpAt)}</Badge> : <span />}
                      <StatusSelect value={a.status} onChange={(s) => onMove(a, s)} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function ConfirmAppliedDialog({ app, onClose }: { app: ApplicationRecord | null; onClose: () => void }) {
  const [date, setDate] = useState(toDateInput(new Date().toISOString()));
  const toast = useToast();
  const confirm = useAction(async () => {
    if (!app) return;
    await setApplicationStatus(app.id, 'applied', { confirmedSubmission: true, appliedAt: fromDateInput(date) });
    toast('Marked as applied', 'good');
    onClose();
  });
  return (
    <Dialog
      open={!!app}
      onClose={onClose}
      title="Did you submit this application?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not yet
          </Button>
          <Button variant="primary" busy={confirm.busy} onClick={() => void confirm.run()}>
            Yes, I submitted it
          </Button>
        </>
      }
    >
      <p className="mb-3 text-[13px]">Job Copilot never submits applications for you. Confirm only if you actually sent it.</p>
      <Field label="Date submitted">{(id) => <Input id={id} type="date" value={date} max={toDateInput(new Date().toISOString())} onChange={(e) => setDate(e.target.value)} />}</Field>
      {confirm.error && <Alert tone="bad">{confirm.error}</Alert>}
    </Dialog>
  );
}

function ApplicationDialog({ app, job, onClose, onStatus }: { app: ApplicationRecord; job?: JobRecord; onClose: () => void; onStatus: (s: ApplicationStatus) => void }) {
  const resumes = useResumes();
  const letters = useCoverLetters();
  const nav = useNav();
  const toast = useToast();
  const [draft, setDraft] = useState(app);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useAction(async () => {
    await patchApplication(app.id, (a) => ({ ...a, notes: draft.notes, followUpAt: draft.followUpAt, followUpNotifiedAt: draft.followUpAt !== a.followUpAt ? undefined : a.followUpNotifiedAt, contacts: draft.contacts, resumeVersionId: draft.resumeVersionId, coverLetterId: draft.coverLetterId }));
    toast('Application saved', 'good');
    onClose();
  });
  const setContact = (i: number, patch: Partial<Contact>) => setDraft({ ...draft, contacts: draft.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const letter = letters?.[app.jobId];
  const jobResumes = resumes ?? [];

  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={job ? `${job.title} — ${job.company}` : 'Application'}
      footer={
        <>
          <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>
            Remove from tracker
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.error && <Alert tone="bad">{save.error}</Alert>}
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={STATUS_TONE[app.status]}>{STATUS_LABEL[app.status]}</Badge>
          <StatusSelect value={app.status} onChange={onStatus} />
          {app.submissionConfirmed && <span className="text-[12.5px] text-muted">Submitted {formatDate(app.appliedAt)} (confirmed by you)</span>}
          {job && (
            <Button size="sm" variant="ghost" onClick={() => nav.go('saved', job.id)}>
              View job
            </Button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="Follow-up date" hint="Optional reminder (enable notifications in Settings).">
            {(id, d) => <Input id={id} aria-describedby={d} type="date" value={toDateInput(draft.followUpAt)} onChange={(e) => setDraft({ ...draft, followUpAt: fromDateInput(e.target.value) })} />}
          </Field>
          <Field label="Résumé version used">
            {(id) => (
              <Select id={id} value={draft.resumeVersionId ?? ''} onChange={(e) => setDraft({ ...draft, resumeVersionId: e.target.value || undefined })}>
                <option value="">Not recorded</option>
                {jobResumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                    {r.jobId === app.jobId ? ' (for this job)' : ''}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-medium">Cover letter:</span>
          {letter ? (
            <>
              <span className="text-muted">saved {formatDate(letter.updatedAt)}</span>
              <Button size="sm" variant="ghost" onClick={() => nav.go('studio', app.jobId)}>
                Open
              </Button>
              <Checkbox label="Used for this application" checked={draft.coverLetterId === letter.id} onChange={(v) => setDraft({ ...draft, coverLetterId: v ? letter.id : undefined })} />
            </>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => nav.go('studio', app.jobId)}>
              Write one in Résumé Studio
            </Button>
          )}
        </div>
        <Field label="Notes">{(id) => <TextArea id={id} rows={5} value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />}</Field>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[12.5px] font-medium">Contacts</p>
            <Button size="sm" icon={<Icon.Plus size={14} />} onClick={() => setDraft({ ...draft, contacts: [...draft.contacts, { id: uid('c'), name: '', role: '', email: '', url: '', notes: '' }] })}>
              Add contact
            </Button>
          </div>
          {!draft.contacts.length && <p className="text-[12.5px] text-muted">No contacts yet.</p>}
          <ul className="flex flex-col gap-2">
            {draft.contacts.map((c, i) => (
              <li key={c.id} className="grid grid-cols-1 gap-1.5 rounded-md border border-line p-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <Input aria-label="Contact name" placeholder="Name" value={c.name} onChange={(e) => setContact(i, { name: e.target.value })} />
                <Input aria-label="Contact role" placeholder="Role" value={c.role} onChange={(e) => setContact(i, { role: e.target.value })} />
                <Input aria-label="Contact email or URL" placeholder="Email or profile URL" value={c.email || c.url} onChange={(e) => setContact(i, /@/.test(e.target.value) ? { email: e.target.value, url: '' } : { url: e.target.value, email: '' })} />
                <IconButton label="Remove contact" onClick={() => setDraft({ ...draft, contacts: draft.contacts.filter((_, j) => j !== i) })}>
                  <Icon.Trash size={15} />
                </IconButton>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="mb-1 text-[12.5px] font-medium">History</p>
          <ol className="text-[12.5px] text-muted">
            {app.statusHistory.map((h, i) => (
              <li key={i}>
                {formatDate(h.at)} — {STATUS_LABEL[h.status]}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Remove this application?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                await deleteApplication(app.id);
                setConfirmDelete(false);
                onClose();
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p>The job stays in your saved jobs; only the tracking record is removed.</p>
      </Dialog>
    </Dialog>
  );
}


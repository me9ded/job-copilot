import { useMemo, useState } from 'react';
import { setApplicationStatus } from '../../lib/storage/repo';
import type { ApplicationRecord, JobRecord } from '../../lib/types';
import { formatDate } from '../../lib/util';
import { Alert, Badge, Button, Dialog, EmptyState, Field, Input, Loading, Select, useToast } from '../components';
import { useAction, useApplications, useJobs } from '../hooks';
import { Icon } from '../icons';
import { STATUS_LABEL, STATUS_TONE } from '../labels';
import { ManualJobDialog } from '../views/ManualJob';
import { Chip, hostOf, openDashboard, STAGE_STATUS, STAGES, stageOf, type Stage } from './shared';

interface Row {
  app: ApplicationRecord;
  job: JobRecord | undefined;
}

const savedAt = (r: Row) => r.job?.savedAt ?? r.app.createdAt;
const todayInput = () => new Date().toISOString().slice(0, 10);

/** Saved → Applied → Interview → Offer / Rejected, with links and dates. */
export function TrackerTab() {
  const apps = useApplications();
  const jobs = useJobs();
  const [filter, setFilter] = useState<Stage | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<Row | null>(null);
  const toast = useToast();

  const rows = useMemo<Row[]>(() => {
    if (!apps || !jobs) return [];
    const byId = new Map(jobs.map((j) => [j.id, j]));
    return apps.map((app) => ({ app, job: byId.get(app.jobId) })).sort((a, b) => b.app.updatedAt.localeCompare(a.app.updatedAt));
  }, [apps, jobs]);

  const move = useAction(async (row: Row, stage: Stage) => {
    if (stage === 'applied' && !row.app.submissionConfirmed) {
      setConfirm(row);
      return;
    }
    await setApplicationStatus(row.app.id, STAGE_STATUS[stage]);
    toast(`Moved to ${STAGES.find((s) => s.id === stage)!.label}`, 'good');
  });

  if (!apps || !jobs) return <Loading />;
  const counts = Object.fromEntries(STAGES.map((s) => [s.id, rows.filter((r) => stageOf(r.app.status) === s.id).length])) as Record<Stage, number>;
  const shown = filter === 'all' ? rows : rows.filter((r) => stageOf(r.app.status) === filter);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" icon={<Icon.Plus size={14} />} onClick={() => setAdding(true)}>
          Add job
        </Button>
        <Button size="sm" variant="ghost" icon={<Icon.Columns size={14} />} onClick={() => openDashboard('applications')}>
          Board view
        </Button>
      </div>
      <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5" role="group" aria-label="Filter by stage">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')} count={rows.length}>
          All
        </Chip>
        {STAGES.map((s) => (
          <Chip key={s.id} active={filter === s.id} onClick={() => setFilter(s.id)} count={counts[s.id]}>
            {s.label}
          </Chip>
        ))}
      </div>
      {move.error && <Alert tone="bad">{move.error}</Alert>}

      {!shown.length ? (
        <EmptyState icon={<Icon.Columns size={22} />} title={rows.length ? 'Nothing at this stage' : 'No applications yet'}>
          {rows.length ? 'Pick another stage above.' : 'Save a job from the Job tab, or press Add job. Jobs you mark as submitted after Autofill show up here.'}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((r) => (
            <TrackerRow key={r.app.id} row={r} onMove={(s) => void move.run(r, s)} />
          ))}
        </ul>
      )}

      <ManualJobDialog open={adding} onClose={() => setAdding(false)} />
      <ConfirmApplied row={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function TrackerRow({ row, onMove }: { row: Row; onMove: (s: Stage) => void }) {
  const { app, job } = row;
  const link = job?.applyUrl || job?.url;
  const safeLink = link && /^https?:\/\//i.test(link) ? link : undefined;
  return (
    <li className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3" aria-label={`${job?.title ?? 'Job'} at ${job?.company ?? ''}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold">{job?.title || 'Untitled role'}</p>
          <p className="truncate text-[12.5px] text-muted">{job?.company || 'Unknown company'}</p>
        </div>
        <Badge tone={STATUS_TONE[app.status]}>{STATUS_LABEL[app.status]}</Badge>
      </div>
      <p className="text-[11.5px] text-muted">
        Saved {formatDate(savedAt(row))}
        {app.appliedAt ? ` · Applied ${formatDate(app.appliedAt)}` : ''}
        {app.updatedAt !== app.createdAt ? ` · Updated ${formatDate(app.updatedAt)}` : ''}
      </p>
      <div className="flex items-center gap-2">
        <Select aria-label="Stage" className="h-7! max-w-36 text-[12px]!" value={stageOf(app.status)} onChange={(e) => onMove(e.target.value as Stage)}>
          {STAGES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        {safeLink && (
          <a href={safeLink} target="_blank" rel="noreferrer noopener" className="inline-flex min-w-0 items-center gap-1 truncate text-[12px] text-accent hover:underline">
            {hostOf(safeLink)} <Icon.External size={11} />
          </a>
        )}
      </div>
    </li>
  );
}

function ConfirmApplied({ row, onClose }: { row: Row | null; onClose: () => void }) {
  const [date, setDate] = useState(todayInput());
  const toast = useToast();
  const save = useAction(async () => {
    if (!row) return;
    const at = date ? new Date(`${date}T12:00:00`).toISOString() : undefined;
    await setApplicationStatus(row.app.id, 'applied', { confirmedSubmission: true, appliedAt: at });
    toast('Marked as Applied', 'good');
    onClose();
  });
  return (
    <Dialog
      open={!!row}
      onClose={onClose}
      title="Did you submit this application?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
            Yes, I submitted it
          </Button>
        </>
      }
    >
      <p className="mb-2 text-[13px]">Applied is only recorded once you confirm you sent it{row?.job ? ` (${row.job.title} at ${row.job.company})` : ''}.</p>
      <Field label="Date applied">{(id) => <Input id={id} type="date" value={date} max={todayInput()} onChange={(e) => setDate(e.target.value)} />}</Field>
      {save.error && (
        <div className="mt-2">
          <Alert tone="bad">{save.error}</Alert>
        </div>
      )}
    </Dialog>
  );
}

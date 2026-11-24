import { useEffect, useMemo, useState } from 'react';
import { AiError } from '../../lib/ai/client';
import { aiInterviewPrep } from '../../lib/ai/features';
import { buildPrep } from '../../lib/interview';
import { putPrep } from '../../lib/storage/repo';
import type { InterviewPrep, PrepItem, Profile } from '../../lib/types';
import { downloadBlob, safeFilename } from '../../lib/resume/export';
import { nowIso, uid } from '../../lib/util';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, Loading, Meter, PageHeader, Select, TextArea, useToast } from '../components';
import { useAction, useMatch, usePrep, useProfile, useSettings } from '../hooks';
import { Icon } from '../icons';
import { PermissionButton } from '../permission';
import { JobPicker, useSelectedJob } from './ResumeStudio';

const CATEGORY_LABEL: Record<PrepItem['category'], string> = {
  technical: 'Technical',
  role: 'About the role',
  gap: 'Gaps to prepare for',
  behavioral: 'Behavioral (STAR)',
  ask: 'Questions to ask them',
  research: 'Research',
};
const ORDER = Object.keys(CATEGORY_LABEL) as Array<PrepItem['category']>;

function profileContent(p: Profile) {
  const { version: _v, updatedAt: _u, preferences: _p, ...content } = p;
  return content;
}

export function InterviewPrepView() {
  const profile = useProfile();
  const settings = useSettings();
  const all = usePrep();
  const [job, setJobId] = useSelectedJob();
  const match = useMatch(job ?? null, profile, settings);
  const toast = useToast();
  const [items, setItems] = useState<PrepItem[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [adding, setAdding] = useState<{ category: PrepItem['category']; question: string } | null>(null);
  const [permOrigin, setPermOrigin] = useState<string | null>(null);
  const stored = job && all ? all[job.id] : undefined;

  useEffect(() => {
    if (!job || !all) return setItems(null);
    if (dirty) return;
    setItems(stored?.items ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, stored?.updatedAt, all === undefined]);

  const persist = async (next: PrepItem[]) => {
    if (!job) return;
    const p: InterviewPrep = { jobId: job.id, items: next, updatedAt: nowIso() };
    await putPrep(p);
    setDirty(false);
  };
  const update = (next: PrepItem[]) => {
    setItems(next);
    setDirty(true);
  };

  const generate = useAction(async () => {
    if (!job || !profile) return;
    const fresh = buildPrep(job, profileContent(profile), match ?? null);
    // Keep the user's own questions and notes when regenerating.
    const keep = (items ?? []).filter((i) => i.source !== 'template' || i.notes || i.practiced);
    const next = [...keep, ...fresh.filter((f) => !keep.some((k) => k.question === f.question))];
    setItems(next);
    await persist(next);
  });
  const ai = useAction(async () => {
    if (!job || !profile) return;
    setPermOrigin(null);
    try {
      const r = await aiInterviewPrep(job, profileContent(profile));
      const base = items ?? [];
      const next = [...base, ...r.data.filter((n) => !base.some((b) => b.question === n.question))];
      setItems(next);
      await persist(next);
      toast(`Added ${next.length - base.length} AI question(s)`, 'good');
    } catch (e) {
      if (e instanceof AiError && e.code === 'permission' && e.origin) setPermOrigin(e.origin);
      throw e;
    }
  });
  const save = useAction(async () => {
    if (items) await persist(items);
    toast('Prep saved', 'good');
  });

  const grouped = useMemo(() => ORDER.map((c) => [c, (items ?? []).filter((i) => i.category === c)] as const).filter(([, l]) => l.length), [items]);

  if (!profile || !settings || !all) return <Loading />;
  const practiced = items?.filter((i) => i.practiced).length ?? 0;

  const exportText = () => {
    if (!job || !items) return;
    const lines = [`Interview prep — ${job.title} at ${job.company}`, ''];
    for (const [c, list] of grouped) {
      lines.push(CATEGORY_LABEL[c].toUpperCase());
      for (const i of list) {
        lines.push(`- ${i.question}`);
        if (i.suggestedEvidence.length) lines.push(`  Evidence: ${i.suggestedEvidence.join('; ')}`);
        if (i.notes) lines.push(`  Notes: ${i.notes}`);
      }
      lines.push('');
    }
    downloadBlob(lines.join('\n'), `${safeFilename(`prep-${job.company}`)}.txt`, 'text/plain');
  };

  return (
    <div>
      <PageHeader title="Interview Prep" description="Likely questions built from the posting and your own experience." />
      <div className="flex flex-col gap-3">
        <Card>
          <JobPicker value={job?.id ?? null} onChange={(id) => (setDirty(false), setJobId(id))} />
          {job && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" icon={<Icon.Refresh size={14} />} busy={generate.busy} onClick={() => void generate.run()}>
                {items ? 'Regenerate questions' : 'Generate questions'}
              </Button>
              {settings.ai.features.interviewPrep !== 'none' && (
                <Button icon={<Icon.Spark size={14} />} busy={ai.busy} onClick={() => void ai.run()}>
                  Add AI questions
                </Button>
              )}
              <Button icon={<Icon.Plus size={14} />} onClick={() => setAdding({ category: 'technical', question: '' })}>
                Add question
              </Button>
              {items && items.length > 0 && (
                <Button icon={<Icon.Download size={14} />} onClick={exportText}>
                  Export
                </Button>
              )}
            </div>
          )}
          {items && items.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-[12px] text-muted">
                {practiced} of {items.length} practiced
              </p>
              <Meter value={practiced / items.length} label={`${practiced} of ${items.length} practiced`} />
            </div>
          )}
        </Card>
        {generate.error && <Alert tone="bad">{generate.error}</Alert>}
        {ai.error && (
          <Alert tone="bad" action={permOrigin && <PermissionButton origins={[permOrigin]} label="Grant access" onGranted={() => void ai.run()} />}>
            {ai.error}
          </Alert>
        )}
        {!job ? (
          <EmptyState icon={<Icon.Chat size={28} />} title="Choose a saved job to prepare for" />
        ) : !items ? (
          <EmptyState icon={<Icon.Chat size={28} />} title="No prep yet">
            Generate questions to get started. Generation runs locally and takes no AI calls.
          </EmptyState>
        ) : (
          <>
            {grouped.map(([cat, list]) => (
              <Card key={cat} title={CATEGORY_LABEL[cat]}>
                <ul className="flex flex-col gap-3">
                  {list.map((it) => (
                    <PrepRow
                      key={it.id}
                      item={it}
                      onChange={(next) => update(items.map((x) => (x.id === it.id ? next : x)))}
                      onRemove={() => update(items.filter((x) => x.id !== it.id))}
                    />
                  ))}
                </ul>
              </Card>
            ))}
            {dirty && (
              <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-canvas/95 py-2 backdrop-blur">
                <Button variant="ghost" onClick={() => (setDirty(false), setItems(stored?.items ?? null))}>
                  Discard
                </Button>
                <Button variant="primary" busy={save.busy} onClick={() => void save.run()}>
                  Save changes
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      <Dialog
        open={!!adding}
        onClose={() => setAdding(null)}
        title="Add a question"
        footer={
          <Button
            variant="primary"
            disabled={!adding?.question.trim()}
            onClick={() => {
              if (!adding) return;
              const item: PrepItem = { id: uid('prep'), category: adding.category, question: adding.question.trim(), why: '', suggestedEvidence: [], notes: '', practiced: false, source: 'manual' };
              update([...(items ?? []), item]);
              setAdding(null);
            }}
          >
            Add
          </Button>
        }
      >
        <div className="flex flex-col gap-2.5">
          <Field label="Category">
            {(id) => (
              <Select id={id} value={adding?.category ?? 'technical'} onChange={(e) => adding && setAdding({ ...adding, category: e.target.value as PrepItem['category'] })}>
                {ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABEL[c]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Question">{(id) => <Input id={id} value={adding?.question ?? ''} onChange={(e) => adding && setAdding({ ...adding, question: e.target.value })} />}</Field>
        </div>
      </Dialog>
    </div>
  );
}

function PrepRow({ item, onChange, onRemove }: { item: PrepItem; onChange: (i: PrepItem) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-line p-2.5">
      <div className="flex items-start gap-2">
        <div className="pt-0.5">
          <Checkbox label={<span className="sr-only">Practiced</span>} checked={item.practiced} onChange={(practiced) => onChange({ ...item, practiced })} />
        </div>
        <div className="min-w-0 flex-1">
          <p className={item.practiced ? 'text-muted' : 'font-medium'}>{item.question}</p>
          {item.why && <p className="mt-0.5 text-[12px] text-muted">{item.why}</p>}
          {item.suggestedEvidence.length > 0 && (
            <p className="mt-1 text-[12.5px]">
              <span className="font-medium">From your experience:</span> {item.suggestedEvidence.join(' · ')}
            </p>
          )}
          {item.source !== 'template' && (
            <span className="mt-1 inline-block">
              <Badge>{item.source === 'ai' ? 'AI' : 'Yours'}</Badge>
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {item.notes ? 'Notes ✓' : 'Notes'}
        </Button>
        <Button size="sm" variant="ghost" aria-label={`Remove question: ${item.question}`} onClick={onRemove}>
          <Icon.Trash size={14} />
        </Button>
      </div>
      {open && <TextArea className="mt-2" rows={4} aria-label="Your answer notes" placeholder="Situation, task, action, result…" value={item.notes} onChange={(e) => onChange({ ...item, notes: e.target.value })} />}
    </li>
  );
}

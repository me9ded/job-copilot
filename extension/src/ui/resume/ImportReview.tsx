import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { commitResumeImport, draftFamily, type ResumeDraft } from '../../lib/resume/importer';
import { BASICS_FIELDS, LIST_KINDS, planCounts, planImport, replanEntry, type BasicsField, type Entry, type EntryKind, type EntryPlan, type FieldChoice, type ImportPlan, type ListKind } from '../../lib/resume/merge';
import type { ParseIssue } from '../../lib/resume/parse';
import type { Profile, ResumeContent, ResumeVersion } from '../../lib/types';
import { errorMessage, formatDate } from '../../lib/util';
import { Alert, Badge, Button, Checkbox, cx, Field, Input, ListInput, Select, TextArea, useToast } from '../components';
import { Icon } from '../icons';
import { range } from '../panel/shared';

/**
 * Review of a parsed résumé before anything is saved: what was found, what
 * couldn't be found, possible duplicates and values that differ from the
 * profile. Every entry can be edited, skipped or merged. Saving is the only
 * step that writes to storage.
 */

const FIELD_LABEL: Record<BasicsField, string> = { name: 'Name', headline: 'Headline', email: 'Email', phone: 'Phone', location: 'Location', summary: 'Summary' };
const LIST_LABEL: Record<ListKind, string> = { skills: 'Skills', certifications: 'Certifications', languages: 'Languages', awards: 'Awards & honours' };
const ENTRY_LABEL: Record<EntryKind, string> = { experience: 'Experience', education: 'Education', projects: 'Projects' };

type FormField = [key: string, label: string];
type FormList = [key: string, label: string, rows: number, commas: boolean];
const ENTRY_FORM: Record<EntryKind, { fields: FormField[]; lists: FormList[] }> = {
  experience: {
    fields: [
      ['title', 'Job title'],
      ['company', 'Company'],
      ['location', 'Location'],
      ['start', 'Start (YYYY-MM)'],
      ['end', 'End (YYYY-MM or present)'],
    ],
    lists: [
      ['bullets', 'What you did (one per line)', 5, false],
      ['skills', 'Technologies (comma-separated)', 0, true],
    ],
  },
  education: {
    fields: [
      ['institution', 'School'],
      ['degree', 'Degree'],
      ['field', 'Field of study'],
      ['start', 'Start (YYYY-MM)'],
      ['end', 'End or expected (YYYY-MM)'],
    ],
    lists: [
      ['details', 'Details (one per line)', 2, false],
      ['coursework', 'Coursework (comma-separated)', 0, true],
    ],
  },
  projects: {
    fields: [
      ['name', 'Name'],
      ['url', 'Link'],
      ['start', 'Start (YYYY-MM)'],
      ['end', 'End (YYYY-MM or present)'],
      ['description', 'One-line description'],
    ],
    lists: [
      ['bullets', 'What you did (one per line)', 3, false],
      ['skills', 'Technologies (comma-separated)', 0, true],
    ],
  },
};

const val = (e: Entry, k: string) => (e as unknown as Record<string, unknown>)[k];
const text = (e: Entry, k: string) => (typeof val(e, k) === 'string' ? (val(e, k) as string) : '');
const list = (e: Entry, k: string) => (Array.isArray(val(e, k)) ? (val(e, k) as string[]) : []);

function entryTitle(kind: EntryKind, e: Entry): string {
  if (kind === 'experience') return [text(e, 'title'), text(e, 'company')].filter(Boolean).join(' · ') || '(untitled role)';
  if (kind === 'education') return [text(e, 'institution'), text(e, 'degree')].filter(Boolean).join(' · ') || '(untitled)';
  return text(e, 'name') || '(untitled project)';
}

function profileContent(p: Profile): ResumeContent {
  const { version: _v, updatedAt: _u, preferences: _p, provenance: _s, ...content } = p;
  return content;
}

const isEmptyProfile = (p: Profile) => !p.basics.name && !p.basics.email && !p.experience.length && !p.education.length && !p.skills.length;

export function ImportReview({ draft, profile, onCancel, onSaved }: { draft: ResumeDraft; profile: Profile; onCancel: () => void; onSaved: (r: { profile: Profile; resume: ResumeVersion }) => void }) {
  const toast = useToast();
  const empty = isEmptyProfile(profile);
  const [replace, setReplace] = useState(false);
  const [plan, setPlan] = useState<ImportPlan>(() => planImport(empty ? null : profileContent(profile), draft.parsed.content));
  const [family, setFamily] = useState<ResumeVersion | null>(null);
  const [asVersion, setAsVersion] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void draftFamily(draft, draft.parsed.content).then((f) => alive && setFamily(f ?? null));
    return () => {
      alive = false;
    };
  }, [draft]);

  const switchMode = (next: boolean) => {
    setReplace(next);
    setPlan(planImport(next || empty ? null : profileContent(profile), currentContent(plan, draft.parsed.content)));
  };

  const counts = planCounts(plan);
  const issues = draft.parsed.issues;
  const missing = issues.filter((i) => i.level === 'missing');
  const entryIssues = (id: string) => issues.filter((i) => i.path.endsWith(`:${id}`));
  const c = draft.parsed.content;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await commitResumeImport(draft, currentContent(plan, c), plan, { replace, family: asVersion && family ? (family.family ?? family.id) : undefined });
      toast(replace || empty ? 'Profile saved from your résumé' : 'Résumé merged into your profile', 'good');
      onSaved(result);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setBasics = (field: BasicsField, patch: Partial<FieldChoice>) => setPlan((p) => ({ ...p, basics: p.basics.map((b) => (b.field === field ? { ...b, ...patch } : b)) }));
  const setEntry = (kind: EntryKind, index: number, next: EntryPlan) =>
    setPlan((p) => ({ ...p, [kind]: (p[kind] as EntryPlan[]).map((e, i) => (i === index ? next : e)) }));
  const existingOf = (kind: EntryKind): Entry[] => (replace ? [] : (profile[kind] as Entry[]));

  return (
    <div className="flex flex-col gap-3 pb-20" aria-label="Review your résumé">
      <section className="rounded-lg border border-line bg-surface p-3">
        <div className="flex items-start gap-2">
          <span className="mt-0.5 text-accent">
            <Icon.Doc size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">Check what was found</h2>
            <p className="text-[12.5px] text-muted">
              Read from {draft.fileName ?? 'pasted text'}
              {draft.kind === 'pdf' && draft.pages ? ` (PDF, ${draft.pages} page${draft.pages === 1 ? '' : 's'})` : draft.kind === 'docx' ? ' (Word)' : ''} on this device. Nothing is saved until you press Save.
            </p>
            <p className="mt-1 text-[12.5px]">
              {c.experience.length} role{c.experience.length === 1 ? '' : 's'} · {c.education.length} education · {c.projects.length} project{c.projects.length === 1 ? '' : 's'} · {c.skills.length} skills
              {(c.languages?.length ?? 0) > 0 && ` · ${c.languages!.length} languages`}
              {c.certifications.length > 0 && ` · ${c.certifications.length} certifications`}
            </p>
          </div>
        </div>
        {[...draft.fileWarnings, ...draft.parsed.warnings.filter((w) => !/Could not find your name|No “(Experience|Skills)”/.test(w))].map((w) => (
          <div key={w} className="mt-2">
            <Alert tone="warn">{w}</Alert>
          </div>
        ))}
        {!empty && (
          <div className="mt-2.5 flex flex-col gap-1.5 border-t border-line pt-2.5">
            {family && <Checkbox label={`New version of ${family.sourceFileName ?? family.name}`} hint={`Uploaded ${formatDate(family.createdAt)}. Both files are kept.`} checked={asVersion} onChange={setAsVersion} />}
            <Checkbox
              label="Replace my profile with this résumé instead of merging"
              hint={replace ? 'Roles, skills and details that aren’t in this résumé will be removed. Job preferences are kept.' : 'Off: new information is added and nothing you have is overwritten unless you choose it below.'}
              checked={replace}
              onChange={switchMode}
            />
          </div>
        )}
      </section>

      <NeedsLook missing={missing} counts={counts} issues={issues.filter((i) => i.level === 'uncertain')} />

      <ReviewSection title="Contact details">
        <div className="flex flex-col divide-y divide-line">
          {BASICS_FIELDS.map((f) => {
            const b = plan.basics.find((x) => x.field === f)!;
            return <BasicsRow key={f} choice={b} onChange={(patch) => setBasics(f, patch)} />;
          })}
        </div>
        {plan.links.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5">
            <p className="text-[11.5px] font-medium text-muted">Links</p>
            {plan.links.map((l, i) =>
              l.status === 'same' ? (
                <p key={l.url} className="text-[12.5px] break-all text-muted">
                  {l.url} <Badge>Already in profile</Badge>
                </p>
              ) : (
                <Checkbox
                  key={l.url}
                  label={
                    <span className="break-all">
                      {l.url} {l.status === 'new' ? <Badge tone="accent">New</Badge> : <Badge tone="warn">Differs</Badge>}
                    </span>
                  }
                  hint={l.status === 'conflict' ? `Replace your current ${l.kind === 'linkedin' ? 'LinkedIn' : l.kind === 'github' ? 'GitHub' : l.kind} link (${l.replaces}).` : undefined}
                  checked={l.include}
                  onChange={(v) => setPlan((p) => ({ ...p, links: p.links.map((x, j) => (j === i ? { ...x, include: v } : x)) }))}
                />
              ),
            )}
          </div>
        )}
      </ReviewSection>

      {(['experience', 'education', 'projects'] as const).map((kind) => (
        <ReviewSection key={kind} title={`${ENTRY_LABEL[kind]} (${plan[kind].length})`}>
          {!plan[kind].length && <p className="text-[12.5px] text-muted">{kind === 'projects' ? 'No projects in this résumé.' : `No ${ENTRY_LABEL[kind].toLowerCase()} was recognised. You can add it to your profile after saving.`}</p>}
          <ul className="flex flex-col gap-2">
            {(plan[kind] as EntryPlan[]).map((e, i) => (
              <li key={e.incoming.id}>
                <EntryCard kind={kind} plan={e} existing={existingOf(kind)} issues={entryIssues(e.incoming.id)} onChange={(next) => setEntry(kind, i, next)} />
              </li>
            ))}
          </ul>
        </ReviewSection>
      ))}

      {LIST_KINDS.map((kind) => (
        <ListSection
          key={kind}
          title={LIST_LABEL[kind]}
          added={plan.lists[kind].added}
          alreadyHave={plan.lists[kind].alreadyHave}
          onToggle={(index, include) => setPlan((p) => ({ ...p, lists: { ...p.lists, [kind]: { ...p.lists[kind], added: p.lists[kind].added.map((x, j) => (j === index ? { ...x, include } : x)) } } }))}
          extra={
            kind === 'skills' && plan.mentionedSkills.length > 0 ? (
              <div className="mt-2">
                <p className="mb-1 text-[11.5px] text-muted">Mentioned in your roles and projects but not in your skills list. Tap the ones you want to add:</p>
                <Chips items={plan.mentionedSkills} onToggle={(index, include) => setPlan((p) => ({ ...p, mentionedSkills: p.mentionedSkills.map((x, j) => (j === index ? { ...x, include } : x)) }))} />
              </div>
            ) : undefined
          }
        />
      ))}

      {plan.extras.map((x, xi) => (
        <ReviewSection key={x.heading} title={x.heading}>
          <div className="flex flex-col gap-1">
            {x.items.map((item, ii) => (
              <Checkbox key={item.value} label={item.value} checked={item.include} onChange={(v) => setPlan((p) => ({ ...p, extras: p.extras.map((y, j) => (j === xi ? { ...y, items: y.items.map((z, k) => (k === ii ? { ...z, include: v } : z)) } : y)) }))} />
            ))}
          </div>
        </ReviewSection>
      ))}

      {draft.parsed.unrecognized.length > 0 && (
        <details className="rounded-lg border border-line bg-surface p-3 text-[12.5px]">
          <summary className="cursor-pointer font-medium">Not imported ({draft.parsed.unrecognized.reduce((n, u) => n + u.lines.length, 0)} lines)</summary>
          <p className="mt-1 text-muted">This text didn’t fit any profile field. Add anything important by hand after saving.</p>
          {draft.parsed.unrecognized.map((u) => (
            <div key={u.heading} className="mt-1.5">
              <p className="font-medium">{u.heading}</p>
              <ul className="list-disc pl-4 text-muted">
                {u.lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}

      {error && <Alert tone="bad">{error}</Alert>}
      <div className="sticky bottom-0 -mx-1 flex items-center gap-2 border-t border-line bg-canvas/95 px-1 py-2 backdrop-blur">
        <p className="min-w-0 flex-1 truncate text-[12px] text-muted" title={saveSummary(counts, replace || empty)}>
          {saveSummary(counts, replace || empty)}
        </p>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" busy={busy} onClick={() => void save()}>
          Save to profile
        </Button>
      </div>
    </div>
  );
}

/** The résumé content as corrected during review (kept with the stored original). */
function currentContent(plan: ImportPlan, parsed: ResumeContent): ResumeContent {
  const basics = { ...parsed.basics };
  for (const b of plan.basics) if (b.incoming) basics[b.field] = b.incoming;
  return { ...parsed, basics, experience: plan.experience.map((e) => e.incoming), education: plan.education.map((e) => e.incoming), projects: plan.projects.map((e) => e.incoming) };
}

function saveSummary(c: ReturnType<typeof planCounts>, fresh: boolean): string {
  if (fresh) return 'Everything above becomes your profile.';
  const parts = [c.added && `adds ${c.added}`, c.merged && `updates ${c.merged}`, c.conflicts && `${c.conflicts} difference${c.conflicts === 1 ? '' : 's'} to check`].filter(Boolean);
  return parts.length ? `Saving ${parts.join(', ')}.` : 'Nothing new; saving records this file as a version.';
}

function NeedsLook({ missing, issues, counts }: { missing: ParseIssue[]; issues: ParseIssue[]; counts: ReturnType<typeof planCounts> }) {
  if (!missing.length && !issues.length && !counts.conflicts && !counts.possibleDuplicates) {
    return (
      <Alert tone="good" title="Everything was read clearly">
        Skim the sections below and press Save.
      </Alert>
    );
  }
  return (
    <Alert tone="warn" title="Needs a look">
      <ul className="list-disc pl-4">
        {missing.map((i) => (
          <li key={i.path + i.message}>{i.message}</li>
        ))}
        {issues.map((i) => (
          <li key={i.path + i.message}>{i.message}</li>
        ))}
        {counts.conflicts > 0 && (
          <li>
            {counts.conflicts} value{counts.conflicts === 1 ? '' : 's'} differ{counts.conflicts === 1 ? 's' : ''} from your profile. Your current value{counts.conflicts === 1 ? ' is' : 's are'} kept unless you pick the new one.
          </li>
        )}
        {counts.possibleDuplicates > 0 && (
          <li>
            {counts.possibleDuplicates} entr{counts.possibleDuplicates === 1 ? 'y looks' : 'ies look'} like {counts.possibleDuplicates === 1 ? 'one' : 'ones'} you have, with other dates.
          </li>
        )}
      </ul>
    </Alert>
  );
}

function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" aria-label={title}>
      <h3 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

function BasicsRow({ choice, onChange }: { choice: FieldChoice; onChange: (patch: Partial<FieldChoice>) => void }) {
  const { field, status } = choice;
  if (status === 'kept') return null;
  const label = FIELD_LABEL[field];
  const multiline = field === 'summary';
  const edit = (v: string) => onChange({ incoming: v, status: v ? (choice.current ? choice.status : 'new') : choice.current ? 'kept' : 'none', take: v && !choice.current ? 'incoming' : choice.take });
  if (status === 'conflict') {
    return (
      <fieldset className="py-1.5">
        <legend className="text-[11.5px] font-medium text-muted">
          {label} <Badge tone="warn">Differs</Badge>
        </legend>
        {(['current', 'incoming'] as const).map((side) => (
          <label key={side} className="mt-1 flex items-start gap-2 text-[12.5px]">
            <input type="radio" name={`take-${field}`} className="mt-0.5 accent-[var(--color-accent)]" checked={choice.take === side} onChange={() => onChange({ take: side })} />
            <span className="min-w-0 break-words">
              <span className="text-muted">{side === 'current' ? 'Keep: ' : 'Use the résumé’s: '}</span>
              {side === 'current' ? choice.current : choice.incoming}
            </span>
          </label>
        ))}
      </fieldset>
    );
  }
  if (status === 'same') {
    return (
      <div className="flex items-baseline gap-2 py-1.5 text-[12.5px]">
        <span className="w-16 shrink-0 text-[11.5px] font-medium text-muted">{label}</span>
        <span className={cx('min-w-0 flex-1 break-words', multiline && 'line-clamp-2')}>{choice.current}</span>
        <Badge>Same</Badge>
      </div>
    );
  }
  return (
    <div className="py-1.5">
      <Field label={label} hint={status === 'none' ? 'Not found in the résumé. Type it to add it.' : undefined}>
        {(id) => (multiline ? <TextArea id={id} rows={3} value={choice.incoming} onChange={(e) => edit(e.target.value)} /> : <Input id={id} value={choice.incoming} onChange={(e) => edit(e.target.value)} />)}
      </Field>
    </div>
  );
}

function statusBadge(kind: EntryKind, plan: EntryPlan, existing: Entry[]): ReactNode {
  if (plan.action === 'skip') return <Badge>Skipped</Badge>;
  if (plan.status === 'new' && plan.similarId) return <Badge tone="warn">Possible duplicate</Badge>;
  if (plan.status === 'new') return <Badge tone="accent">New</Badge>;
  if (plan.action === 'add') return <Badge tone="accent">Added separately</Badge>;
  if (plan.status === 'duplicate') return <Badge>Already in profile</Badge>;
  if (plan.status === 'update') return <Badge tone="good">Adds {plan.adds.join(', ')}</Badge>;
  const twin = existing.find((x) => x.id === plan.existingId);
  return <Badge tone="warn" title={twin ? entryTitle(kind, twin) : undefined}>Differs</Badge>;
}

function EntryCard({ kind, plan, existing, issues, onChange }: { kind: EntryKind; plan: EntryPlan; existing: Entry[]; issues: ParseIssue[]; onChange: (p: EntryPlan) => void }) {
  const [editing, setEditing] = useState(false);
  const e = plan.incoming;
  const match = existing.find((x) => x.id === (plan.existingId ?? plan.similarId));
  const bullets = list(e, kind === 'education' ? 'details' : 'bullets');
  const tech = list(e, kind === 'education' ? 'coursework' : 'skills');
  const patch = (key: string, value: unknown) => onChange(replanEntry(kind, { ...plan, incoming: { ...e, [key]: value } as Entry }, existing));
  const setAction = (value: string) => {
    if (value === 'merge-similar' && plan.similarId) onChange(replanEntry(kind, { ...plan, existingId: plan.similarId, similarId: undefined, action: 'merge', status: 'duplicate' }, existing));
    else onChange({ ...plan, action: value as EntryPlan['action'] });
  };

  return (
    <div className={cx('rounded-md border p-2.5 text-[13px]', plan.action === 'skip' ? 'border-line opacity-60' : plan.status === 'conflict' || plan.similarId ? 'border-warn/40' : 'border-line')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{entryTitle(kind, e)}</p>
          <p className="text-[12px] text-muted">
            {[kind === 'experience' ? text(e, 'location') : kind === 'education' ? text(e, 'field') : text(e, 'url'), range(text(e, 'start'), text(e, 'end'))].filter(Boolean).join(' · ') || 'No dates'}
          </p>
        </div>
        {statusBadge(kind, plan, existing)}
      </div>
      {plan.similarId && match && plan.action === 'add' && (
        <p className="mt-1 text-[12px] text-warn">
          Looks like “{entryTitle(kind, match)}” ({range(text(match, 'start'), text(match, 'end')) || 'no dates'}) in your profile, with other dates.
        </p>
      )}
      {issues.map((i) => (
        <p key={i.message} className="mt-1 text-[12px] text-warn">
          {i.message}
        </p>
      ))}
      {plan.action === 'merge' &&
        plan.conflicts.map((c) => (
          <fieldset key={c.field} className="mt-1.5 rounded bg-warn-soft/60 px-2 py-1">
            <legend className="sr-only">{c.label}</legend>
            <p className="text-[11.5px] font-medium">{c.label} differs</p>
            {(['current', 'incoming'] as const).map((side) => (
              <label key={side} className="flex items-center gap-2 text-[12.5px]">
                <input
                  type="radio"
                  name={`${e.id}-${c.field}`}
                  className="accent-[var(--color-accent)]"
                  checked={c.take === side}
                  onChange={() => onChange({ ...plan, conflicts: plan.conflicts.map((x) => (x.field === c.field ? { ...x, take: side } : x)) })}
                />
                <span>
                  <span className="text-muted">{side === 'current' ? 'Keep: ' : 'Use: '}</span>
                  {side === 'current' ? c.current : c.incoming}
                </span>
              </label>
            ))}
          </fieldset>
        ))}
      {!editing && bullets.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-[12.5px]">
          {bullets.slice(0, 3).map((b, i) => (
            <li key={i}>{b}</li>
          ))}
          {bullets.length > 3 && <li className="list-none text-muted">+{bullets.length - 3} more</li>}
        </ul>
      )}
      {!editing && tech.length > 0 && <p className="mt-1 text-[12px] text-muted">{tech.join(' · ')}</p>}
      {editing && (
        <div className="mt-2 grid grid-cols-1 gap-2 min-[380px]:grid-cols-2">
          {ENTRY_FORM[kind].fields.map(([key, label]) => (
            <Field key={key} label={label}>
              {(id) => <Input id={id} value={text(e, key)} onChange={(x) => patch(key, x.target.value)} />}
            </Field>
          ))}
          {ENTRY_FORM[kind].lists.map(([key, label, rows, commas]) => (
            <Field key={key} label={label} className="min-[380px]:col-span-2">
              {(id) => <ListInput id={id} rows={rows || undefined} commas={commas} value={list(e, key)} onChange={(v) => patch(key, v)} />}
            </Field>
          ))}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {plan.existingId || plan.similarId ? (
          <Select aria-label={`What to do with ${entryTitle(kind, e)}`} value={plan.action} onChange={(x) => setAction(x.target.value)} className="h-7 w-auto text-[12px]">
            {plan.existingId ? <option value="merge">Merge into your entry</option> : <option value="merge-similar">Merge into your “{match ? entryTitle(kind, match) : 'entry'}”</option>}
            <option value="add">Add as a separate entry</option>
            <option value="skip">Skip</option>
          </Select>
        ) : (
          <Checkbox label="Include" checked={plan.action !== 'skip'} onChange={(v) => setAction(v ? 'add' : 'skip')} />
        )}
        <span className="flex-1" />
        <Button size="sm" variant="ghost" icon={<Icon.Edit size={13} />} onClick={() => setEditing((x) => !x)}>
          {editing ? 'Done' : 'Edit'}
        </Button>
      </div>
    </div>
  );
}

function Chips({ items, onToggle }: { items: Array<{ value: string; include: boolean }>; onToggle: (index: number, include: boolean) => void }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {items.map((s, i) => (
        <li key={s.value}>
          <button
            type="button"
            aria-pressed={s.include}
            onClick={() => onToggle(i, !s.include)}
            className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px]', s.include ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-subtle text-muted line-through decoration-muted/50')}
          >
            {s.include ? <Icon.Check size={11} /> : <Icon.Plus size={11} />}
            {s.value}
          </button>
        </li>
      ))}
    </ul>
  );
}

function ListSection({ title, added, alreadyHave, onToggle, extra }: { title: string; added: Array<{ value: string; include: boolean }>; alreadyHave: string[]; onToggle: (index: number, include: boolean) => void; extra?: ReactNode }) {
  const known = useMemo(() => alreadyHave.join(', '), [alreadyHave]);
  if (!added.length && !alreadyHave.length && !extra) return null;
  return (
    <ReviewSection title={`${title} (${added.length + alreadyHave.length})`}>
      {added.length > 0 && <Chips items={added} onToggle={onToggle} />}
      {alreadyHave.length > 0 && (
        <p className="text-[12px] text-muted" title={known}>
          Already in your profile: {alreadyHave.length > 8 ? `${alreadyHave.slice(0, 8).join(', ')} and ${alreadyHave.length - 8} more` : known}
        </p>
      )}
      {extra}
    </ReviewSection>
  );
}

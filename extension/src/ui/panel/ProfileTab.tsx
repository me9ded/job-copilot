import { useEffect, useState, type ReactNode } from 'react';
import { resumeChoices } from '../../lib/autofill/run';
import { profileCompletion, profileIsEmpty } from '../../lib/matching/service';
import { groupSkills, splitBullets } from '../../lib/profile/organize';
import type { ResumeDraft } from '../../lib/resume/importer';
import { getProfile, getResumeFile, saveProfile, updateSettings } from '../../lib/storage/repo';
import { Profile, type Education, type Experience, type Project, type ResumeVersion } from '../../lib/types';
import { errorMessage, formatDate, uid } from '../../lib/util';
import { Badge, Button, Card, Field, IconButton, Input, ListInput, Loading, Meter, Select, TextArea, useToast } from '../components';
import { useProfile, useResumes, useSettings } from '../hooks';
import { Icon } from '../icons';
import { ImportReview } from '../resume/ImportReview';
import { ResumeDrop } from '../resume/ResumeDrop';
import { Chip, range, SectionTitle, Val } from './shared';

/** Reads the latest profile, applies `fn` and saves it (so edits never overwrite each other). */
async function patchProfile(fn: (p: Profile) => Profile): Promise<void> {
  await saveProfile(Profile.parse(fn(await getProfile())));
}

const EMPLOYMENT: Array<[Experience['employmentType'], string]> = [
  ['', 'Not set'],
  ['full-time', 'Full-time'],
  ['part-time', 'Part-time'],
  ['internship', 'Internship'],
  ['co-op', 'Co-op'],
  ['contract', 'Contract'],
  ['volunteer', 'Volunteer'],
];
const EMPLOYMENT_LABEL = Object.fromEntries(EMPLOYMENT) as Record<Experience['employmentType'], string>;
const PROJECT_KIND: Array<[Project['kind'], string]> = [
  ['', 'Not set'],
  ['academic', 'Academic'],
  ['personal', 'Personal'],
  ['professional', 'Professional'],
];

export function ProfileTab() {
  const profile = useProfile();
  // A parsed upload waiting for review. Nothing is saved until the review is confirmed.
  const [draft, setDraft] = useState<ResumeDraft | null>(null);
  if (!profile) return <Loading />;
  if (draft) return <ImportReview draft={draft} profile={profile} onCancel={() => setDraft(null)} onSaved={() => setDraft(null)} />;
  const empty = profileIsEmpty(profile);
  const completion = profileCompletion(profile);

  return (
    <div className="flex flex-col gap-3">
      <ResumeFiles empty={empty} onDraft={setDraft} />

      {!empty && (
        <>
          <div className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2">
            <span className="text-[15px] font-semibold tabular-nums">{completion.percent}%</span>
            <div className="min-w-0 flex-1">
              <Meter value={completion.percent / 100} label="Profile completeness" />
              {completion.missing.length > 0 && <p className="mt-1 truncate text-[11.5px] text-muted" title={completion.missing.join(', ')}>Missing: {completion.missing.join(', ')}</p>}
            </div>
          </div>
          <BasicsCard profile={profile} />
          <ExperienceList profile={profile} />
          <SkillsCard profile={profile} />
          <ProjectsList profile={profile} />
          <EducationList profile={profile} />
          <StringListCard profile={profile} field="certifications" title="Certifications" />
          <StringListCard profile={profile} field="languages" title="Languages" />
          <StringListCard profile={profile} field="awards" title="Awards & honours" />
          <ExtrasCard profile={profile} />
          <p className="text-center text-[12px] text-muted">Autofill and suggested answers use only what’s here. Fix anything that was read wrong.</p>
        </>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Résumé files: upload, versions and the file autofill attaches
 * ------------------------------------------------------------------------- */

/** Uploads grouped by résumé (versions of the same résumé share a family), newest first. */
function families(originals: ResumeVersion[]): Array<{ id: string; versions: ResumeVersion[] }> {
  const by = new Map<string, ResumeVersion[]>();
  for (const r of [...originals].sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
    const k = r.family ?? r.id;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  return [...by.entries()].map(([id, versions]) => ({ id, versions }));
}

function ResumeFiles({ empty, onDraft }: { empty: boolean; onDraft: (d: ResumeDraft) => void }) {
  const resumes = useResumes();
  const settings = useSettings();
  const [withFiles, setWithFiles] = useState<Set<string>>(new Set());
  const originals = (resumes ?? []).filter((r) => r.kind === 'original').sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  useEffect(() => {
    let alive = true;
    void Promise.all(originals.map(async (r) => ((await getResumeFile(r.id)) ? r.id : null))).then((ids) => alive && setWithFiles(new Set(ids.filter((x): x is string => !!x))));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originals.map((r) => r.id).join(',')]);

  if (empty)
    return (
      <Card title="Résumé">
        <p className="mb-2 text-[12.5px] text-muted">Upload your résumé once. Job Copilot reads it here in your browser and shows what it found (roles, education, skills, projects) so you can check it before saving. Autofill and suggested answers then reuse it.</p>
        <ResumeDrop onDraft={onDraft} label="Upload résumé" />
      </Card>
    );

  const groups = families(originals);
  return (
    <Card title="Résumé" subtitle={originals[0]?.sourceFileName ? `Read from ${originals[0].sourceFileName}` : 'Entered by hand'}>
      {settings && resumes && (
        <Field label="Autofill attaches" hint="Attached only when an application asks for a résumé, and reported only once the page accepts the file.">
          {(id) => (
            <Select id={id} value={settings.autofill.attach} onChange={(e) => void updateSettings((s) => ({ ...s, autofill: { ...s.autofill, attach: e.target.value } }))}>
              {resumeChoices(resumes, withFiles).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {groups.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 text-[12px]" aria-label="Uploaded résumés">
          {groups.map((g) => (
            <li key={g.id} className="flex items-center gap-1.5">
              <Icon.Doc size={13} />
              <span className="min-w-0 flex-1 truncate" title={g.versions.map((v) => `${v.sourceFileName ?? v.name} (${formatDate(v.createdAt)})`).join('\n')}>
                {g.versions[0]!.sourceFileName ?? g.versions[0]!.name}
              </span>
              {g.versions.length > 1 && <Badge>{g.versions.length} versions</Badge>}
              <span className="text-muted">{formatDate(g.versions[0]!.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2.5">
        <ResumeDrop compact onDraft={onDraft} label="Upload a new or updated résumé" hint="You’ll see what’s new or different before anything changes." />
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------------------
 * Inline editing
 * ------------------------------------------------------------------------- */

/** A list item shown read-only, with a pencil that swaps it for a small form. */
function Editable<T extends object>({ value, view, form, onSave, onDelete, onCancel, label, startEditing }: { value: T; view: ReactNode; form: (v: T, set: (patch: Partial<T>) => void) => ReactNode; onSave: (v: T) => Promise<void>; onDelete?: () => Promise<void>; onCancel?: () => void; label: string; startEditing?: boolean }) {
  const [draft, setDraft] = useState<T | null>(startEditing ? value : null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (!draft)
    return (
      <div className="group flex items-start gap-1">
        <div className="min-w-0 flex-1">{view}</div>
        <IconButton label={`Edit ${label}`} onClick={() => setDraft(value)}>
          <Icon.Edit size={14} />
        </IconButton>
      </div>
    );
  const save = async () => {
    setBusy(true);
    try {
      await onSave(draft);
      setDraft(null);
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-subtle p-2">
      {form(draft, (patch) => setDraft((d) => (d ? { ...d, ...patch } : d)))}
      <div className="flex items-center gap-2">
        {onDelete && (
          <Button size="sm" variant="danger" icon={<Icon.Trash size={13} />} onClick={() => void onDelete().then(() => setDraft(null))}>
            Delete
          </Button>
        )}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(null);
            onCancel?.();
          }}
        >
          Cancel
        </Button>
        <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function ListCard({ title, count, onAdd, children }: { title: string; count: number; onAdd?: () => void; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" aria-label={title}>
      <SectionTitle
        action={
          onAdd && (
            <Button size="sm" variant="ghost" icon={<Icon.Plus size={13} />} onClick={onAdd}>
              Add
            </Button>
          )
        }
      >
        {title} ({count})
      </SectionTitle>
      {children}
    </section>
  );
}

const two = 'grid grid-cols-1 gap-2 min-[380px]:grid-cols-2';

function BasicsCard({ profile }: { profile: Profile }) {
  const b = profile.basics;
  return (
    <section className="rounded-lg border border-line bg-surface p-3" aria-label="Contact details">
      <Editable
        label="contact details"
        value={b}
        onSave={(v) => patchProfile((p) => ({ ...p, basics: v }))}
        view={
          <div className="text-[13px]">
            <p className="text-[16px] font-semibold">
              <Val v={b.name} missing="Name not found" />
            </p>
            {b.headline && <p className="text-muted">{b.headline}</p>}
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px]">
              <dt className="text-muted">Email</dt>
              <dd className="min-w-0 break-words">
                <Val v={b.email} missing="not found" />
              </dd>
              <dt className="text-muted">Phone</dt>
              <dd>
                <Val v={b.phone} missing="not found" />
              </dd>
              <dt className="text-muted">Location</dt>
              <dd>
                <Val v={b.location} missing="not found" />
              </dd>
              {b.links.map((l, i) => (
                <Fragment2 key={l} a={<dt className="text-muted">{i === 0 ? 'Links' : ''}</dt>} b={<dd className="min-w-0 break-all">{l}</dd>} />
              ))}
            </dl>
          </div>
        }
        form={(v, set) => (
          <div className={two}>
            {(['name', 'headline', 'email', 'phone', 'location'] as const).map((k) => (
              <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}>
                {(id) => <Input id={id} value={v[k]} onChange={(e) => set({ [k]: e.target.value })} />}
              </Field>
            ))}
            <Field label="Links (comma-separated)">{(id) => <ListInput id={id} value={v.links} onChange={(links) => set({ links })} />}</Field>
            <Field label="Summary" className="min-[380px]:col-span-2">
              {(id) => <TextArea id={id} rows={3} value={v.summary} onChange={(e) => set({ summary: e.target.value })} />}
            </Field>
          </div>
        )}
      />
    </section>
  );
}

function Fragment2({ a, b }: { a: ReactNode; b: ReactNode }) {
  return (
    <>
      {a}
      {b}
    </>
  );
}

function Bullets({ items, title }: { items: string[]; title?: string }) {
  if (!items.length) return null;
  return (
    <div className="mt-1">
      {title && <p className="text-[11px] font-medium text-muted">{title}</p>}
      <ul className="list-disc pl-4 text-[12.5px]">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function ExperienceList({ profile }: { profile: Profile }) {
  const [adding, setAdding] = useState<Experience | null>(null);
  const save = (e: Experience) => patchProfile((p) => ({ ...p, experience: p.experience.some((x) => x.id === e.id) ? p.experience.map((x) => (x.id === e.id ? e : x)) : [e, ...p.experience] }));
  const form = (e: Experience, set: (patch: Partial<Experience>) => void) => (
    <div className={two}>
      <Field label="Title">{(id) => <Input id={id} value={e.title} onChange={(x) => set({ title: x.target.value })} />}</Field>
      <Field label="Company">{(id) => <Input id={id} value={e.company} onChange={(x) => set({ company: x.target.value })} />}</Field>
      <Field label="Start (YYYY-MM)">{(id) => <Input id={id} value={e.start} placeholder="2024-01" onChange={(x) => set({ start: x.target.value.trim() })} />}</Field>
      <Field label="End (YYYY-MM or present)">{(id) => <Input id={id} value={e.end} placeholder="present" onChange={(x) => set({ end: x.target.value.trim() })} />}</Field>
      <Field label="Location">{(id) => <Input id={id} value={e.location} onChange={(x) => set({ location: x.target.value })} />}</Field>
      <Field label="Type">
        {(id) => (
          <Select id={id} value={e.employmentType} onChange={(x) => set({ employmentType: x.target.value as Experience['employmentType'] })}>
            {EMPLOYMENT.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="What you did (one per line)" className="min-[380px]:col-span-2">
        {(id) => <ListInput id={id} rows={5} value={e.bullets} onChange={(bullets) => set({ bullets })} />}
      </Field>
      <Field label="Technologies (comma-separated)" className="min-[380px]:col-span-2">
        {(id) => <ListInput id={id} value={e.skills ?? []} onChange={(skills) => set({ skills })} />}
      </Field>
    </div>
  );
  return (
    <ListCard title="Experience" count={profile.experience.length} onAdd={() => setAdding({ id: uid('exp'), title: '', company: '', location: '', start: '', end: '', employmentType: '', bullets: [] })}>
      {adding && <Editable label="new role" value={adding} startEditing view={null} onCancel={() => setAdding(null)} form={form} onSave={async (e) => (await save(e), setAdding(null))} />}
      {!profile.experience.length && !adding && <p className="text-[12.5px] text-warn italic">No roles found</p>}
      <ul className="flex flex-col gap-3">
        {profile.experience.map((e) => {
          const { achievements, responsibilities } = splitBullets(e.bullets);
          return (
            <li key={e.id}>
              <Editable
                label={e.title || 'role'}
                value={e}
                onSave={save}
                onDelete={() => patchProfile((p) => ({ ...p, experience: p.experience.filter((x) => x.id !== e.id) }))}
                form={form}
                view={
                  <div className="text-[13px]">
                    <p className="font-semibold">
                      <Val v={e.title} missing="Title not found" />
                      {e.employmentType && (
                        <span className="ml-1.5 align-middle">
                          <Badge>{EMPLOYMENT_LABEL[e.employmentType]}</Badge>
                        </span>
                      )}
                    </p>
                    <p>
                      <Val v={e.company} missing="Company not found" />
                      {e.location && <span className="text-muted"> · {e.location}</span>}
                    </p>
                    <p className="text-[12px] text-muted">{range(e.start, e.end) || 'Dates not found'}</p>
                    <Bullets title={achievements.length && responsibilities.length ? 'Achievements' : undefined} items={achievements} />
                    <Bullets title={achievements.length && responsibilities.length ? 'Responsibilities' : undefined} items={responsibilities} />
                    {(e.skills?.length ?? 0) > 0 && <p className="mt-1 text-[12px] text-muted">{e.skills!.join(' · ')}</p>}
                  </div>
                }
              />
            </li>
          );
        })}
      </ul>
    </ListCard>
  );
}

function SkillsCard({ profile }: { profile: Profile }) {
  const [text, setText] = useState('');
  const groups = groupSkills(profile.skills);
  const add = async () => {
    const items = text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    if (!items.length) return;
    await patchProfile((p) => ({ ...p, skills: Array.from(new Set([...p.skills, ...items.filter((s) => !p.skills.some((x) => x.toLowerCase() === s.toLowerCase()))])) }));
    setText('');
  };
  return (
    <ListCard title="Skills" count={profile.skills.length}>
      {!profile.skills.length && <p className="text-[12.5px] text-warn italic">No skills found</p>}
      {groups.map((g) => (
        <div key={g.group}>
          <p className="mb-1 text-[11.5px] font-medium text-muted">{g.label}</p>
          <ul className="flex flex-wrap gap-1">
            {g.skills.map((s) => (
              <li key={s} className="inline-flex items-center gap-0.5 rounded-full border border-line bg-subtle py-0.5 pr-1 pl-2 text-[12px]">
                {s}
                <button type="button" aria-label={`Remove ${s}`} className="rounded-full p-0.5 text-muted hover:bg-surface hover:text-bad" onClick={() => void patchProfile((p) => ({ ...p, skills: p.skills.filter((x) => x !== s) }))}>
                  <Icon.X size={11} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Input aria-label="Add skills" placeholder="Add skills, comma-separated" value={text} onChange={(e) => setText(e.target.value)} />
        <Button size="sm" type="submit" disabled={!text.trim()}>
          Add
        </Button>
      </form>
      <p className="text-[11.5px] text-muted">Only list skills you can talk about. Suggested answers never claim a skill that isn’t here or in your roles.</p>
    </ListCard>
  );
}

function ProjectsList({ profile }: { profile: Profile }) {
  const [filter, setFilter] = useState<Project['kind'] | 'all'>('all');
  const [adding, setAdding] = useState<Project | null>(null);
  const save = (x: Project) => patchProfile((p) => ({ ...p, projects: p.projects.some((y) => y.id === x.id) ? p.projects.map((y) => (y.id === x.id ? x : y)) : [x, ...p.projects] }));
  const kinds = PROJECT_KIND.filter(([k]) => k && profile.projects.some((p) => p.kind === k));
  const shown = filter === 'all' ? profile.projects : profile.projects.filter((p) => p.kind === filter);
  const form = (x: Project, set: (patch: Partial<Project>) => void) => (
    <div className={two}>
      <Field label="Name">{(id) => <Input id={id} value={x.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
      <Field label="Type">
        {(id) => (
          <Select id={id} value={x.kind} onChange={(e) => set({ kind: e.target.value as Project['kind'] })}>
            {PROJECT_KIND.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Start (YYYY-MM)">{(id) => <Input id={id} value={x.start} onChange={(e) => set({ start: e.target.value.trim() })} />}</Field>
      <Field label="End (YYYY-MM or present)">{(id) => <Input id={id} value={x.end} onChange={(e) => set({ end: e.target.value.trim() })} />}</Field>
      <Field label="Technologies (comma-separated)" className="min-[380px]:col-span-2">{(id) => <ListInput id={id} value={x.skills} onChange={(skills) => set({ skills })} />}</Field>
      <Field label="Link">{(id) => <Input id={id} value={x.url} onChange={(e) => set({ url: e.target.value.trim() })} />}</Field>
      <Field label="One-line description">{(id) => <Input id={id} value={x.description} onChange={(e) => set({ description: e.target.value })} />}</Field>
      <Field label="What you did (one per line)" className="min-[380px]:col-span-2">{(id) => <ListInput id={id} rows={4} value={x.bullets} onChange={(bullets) => set({ bullets })} />}</Field>
    </div>
  );
  return (
    <ListCard title="Projects" count={profile.projects.length} onAdd={() => setAdding({ id: uid('proj'), name: '', description: '', url: '', bullets: [], skills: [], kind: '', start: '', end: '' })}>
      {kinds.length > 0 && (
        <div className="flex gap-1.5" role="group" aria-label="Project type">
          <Chip active={filter === 'all'} onClick={() => setFilter('all')}>
            All
          </Chip>
          {kinds.map(([k, l]) => (
            <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>
              {l}
            </Chip>
          ))}
        </div>
      )}
      {adding && <Editable label="new project" value={adding} startEditing view={null} onCancel={() => setAdding(null)} form={form} onSave={async (x) => (await save(x), setAdding(null))} />}
      {!profile.projects.length && !adding && <p className="text-[12.5px] text-muted">No projects yet. Add academic or personal projects: suggested answers use them for “describe a project” questions.</p>}
      <ul className="flex flex-col gap-3">
        {shown.map((x) => (
          <li key={x.id}>
            <Editable
              label={x.name || 'project'}
              value={x}
              onSave={save}
              onDelete={() => patchProfile((p) => ({ ...p, projects: p.projects.filter((y) => y.id !== x.id) }))}
              form={form}
              view={
                <div className="text-[13px]">
                  <p className="font-semibold">
                    {x.name || 'Untitled project'}
                    {x.kind && (
                      <span className="ml-1.5 align-middle">
                        <Badge>{PROJECT_KIND.find(([k]) => k === x.kind)![1]}</Badge>
                      </span>
                    )}
                  </p>
                  {range(x.start, x.end) && <p className="text-[12px] text-muted">{range(x.start, x.end)}</p>}
                  {x.description && <p className="text-[12.5px]">{x.description}</p>}
                  {x.skills.length > 0 && <p className="text-[12px] text-muted">{x.skills.join(' · ')}</p>}
                  <Bullets items={x.bullets} />
                </div>
              }
            />
          </li>
        ))}
      </ul>
    </ListCard>
  );
}

function EducationList({ profile }: { profile: Profile }) {
  const [adding, setAdding] = useState<Education | null>(null);
  const save = (x: Education) => patchProfile((p) => ({ ...p, education: p.education.some((y) => y.id === x.id) ? p.education.map((y) => (y.id === x.id ? x : y)) : [x, ...p.education] }));
  const form = (x: Education, set: (patch: Partial<Education>) => void) => (
    <div className={two}>
      <Field label="School">{(id) => <Input id={id} value={x.institution} onChange={(e) => set({ institution: e.target.value })} />}</Field>
      <Field label="Degree">{(id) => <Input id={id} value={x.degree} placeholder="Bachelor of Science" onChange={(e) => set({ degree: e.target.value })} />}</Field>
      <Field label="Field of study">{(id) => <Input id={id} value={x.field} onChange={(e) => set({ field: e.target.value })} />}</Field>
      <Field label="Start (YYYY-MM)">{(id) => <Input id={id} value={x.start} onChange={(e) => set({ start: e.target.value.trim() })} />}</Field>
      <Field label="End or expected (YYYY-MM)">{(id) => <Input id={id} value={x.end} onChange={(e) => set({ end: e.target.value.trim() })} />}</Field>
      <Field label="Details (one per line)" className="min-[380px]:col-span-2">{(id) => <ListInput id={id} rows={2} value={x.details} onChange={(details) => set({ details })} />}</Field>
      <Field label="Relevant coursework (comma-separated)" className="min-[380px]:col-span-2">{(id) => <ListInput id={id} value={x.coursework ?? []} onChange={(coursework) => set({ coursework })} />}</Field>
    </div>
  );
  return (
    <ListCard title="Education" count={profile.education.length} onAdd={() => setAdding({ id: uid('edu'), institution: '', degree: '', field: '', start: '', end: '', details: [] })}>
      {adding && <Editable label="new education" value={adding} startEditing view={null} onCancel={() => setAdding(null)} form={form} onSave={async (x) => (await save(x), setAdding(null))} />}
      {!profile.education.length && !adding && <p className="text-[12.5px] text-warn italic">No education found</p>}
      <ul className="flex flex-col gap-2.5">
        {profile.education.map((e) => (
          <li key={e.id}>
            <Editable
              label={e.institution || 'education'}
              value={e}
              onSave={save}
              onDelete={() => patchProfile((p) => ({ ...p, education: p.education.filter((y) => y.id !== e.id) }))}
              form={form}
              view={
                <div className="text-[13px]">
                  <p className="font-semibold">
                    <Val v={e.institution} missing="School not found" />
                  </p>
                  <p>{[e.degree, e.field].filter(Boolean).join(', ') || <span className="text-warn italic">Degree not found</span>}</p>
                  {range(e.start, e.end) && <p className="text-[12px] text-muted">{range(e.start, e.end)}</p>}
                  {e.details.length > 0 && <p className="text-[12.5px] text-muted">{e.details.join(' · ')}</p>}
                  {(e.coursework?.length ?? 0) > 0 && <p className="text-[12px] text-muted">Coursework: {e.coursework!.join(', ')}</p>}
                </div>
              }
            />
          </li>
        ))}
      </ul>
    </ListCard>
  );
}

type StringListField = 'certifications' | 'languages' | 'awards';

function StringListCard({ profile, field, title }: { profile: Profile; field: StringListField; title: string }) {
  const items = profile[field] ?? [];
  return (
    <ListCard title={title} count={items.length}>
      <Editable
        label={title.toLowerCase()}
        value={{ items }}
        onSave={(v) => patchProfile((p) => ({ ...p, [field]: v.items }))}
        view={items.length ? <Bullets items={items} /> : <p className="text-[12.5px] text-muted">None listed.</p>}
        form={(v, set) => <Field label="One per line">{(id) => <ListInput id={id} rows={3} value={v.items} onChange={(next) => set({ items: next })} />}</Field>}
      />
    </ListCard>
  );
}

/** Other résumé sections kept as written (publications, leadership, interests). */
function ExtrasCard({ profile }: { profile: Profile }) {
  const extras = profile.extras ?? [];
  if (!extras.length) return null;
  return (
    <>
      {extras.map((x, i) => (
        <ListCard key={x.heading} title={x.heading} count={x.items.length}>
          <Editable
            label={x.heading}
            value={{ items: x.items }}
            onSave={(v) => patchProfile((p) => ({ ...p, extras: (p.extras ?? []).map((y, j) => (j === i ? { ...y, items: v.items } : y)).filter((y) => y.items.length) }))}
            view={<Bullets items={x.items} />}
            form={(v, set) => <Field label="One per line">{(id) => <ListInput id={id} rows={3} value={v.items} onChange={(next) => set({ items: next })} />}</Field>}
          />
        </ListCard>
      ))}
    </>
  );
}

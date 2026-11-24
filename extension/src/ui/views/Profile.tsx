import { useEffect, useState } from 'react';
import { profileCompletion } from '../../lib/matching/service';
import { textResumeDraft, type ResumeDraft } from '../../lib/resume/importer';
import { saveProfile } from '../../lib/storage/repo';
import { Profile, Seniority, type Education, type Experience, type Project } from '../../lib/types';
import { errorMessage, uid } from '../../lib/util';
import { Button, Card, Checkbox, Dialog, Field, IconButton, Input, ListInput, Loading, Meter, TextArea, useToast } from '../components';
import { useProfile } from '../hooks';
import { Icon } from '../icons';
import { ImportReview } from '../resume/ImportReview';
import { ResumeDrop } from '../resume/ResumeDrop';
import { SENIORITY_LABEL } from '../../lib/matching/analysis';

const ARRANGEMENTS = ['remote', 'hybrid', 'onsite'] as const;

/** `simple`: only the résumé content (no import, completeness or job preferences), for the side panel's Edit mode. */
export function ProfileEditor({ simple = false, onDone }: { simple?: boolean; onDone?: () => void } = {}) {
  const stored = useProfile();
  const [draft, setDraft] = useState<Profile | null>(null);
  const [dirty, setDirty] = useState(false);
  // A parsed upload or paste waiting for review; nothing is saved until it's confirmed.
  const [review, setReview] = useState<ResumeDraft | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (stored && !dirty) setDraft(stored);
  }, [stored, dirty]);

  if (!draft) return <Loading />;
  if (review && stored)
    return (
      <ImportReview
        draft={review}
        profile={stored}
        onCancel={() => setReview(null)}
        onSaved={({ profile }) => {
          setReview(null);
          setDraft(profile);
          setDirty(false);
        }}
      />
    );
  const update = (fn: (p: Profile) => Profile) => {
    setDraft((p) => (p ? fn(p) : p));
    setDirty(true);
  };
  const completion = profileCompletion(draft);

  const save = async () => {
    setBusy(true);
    try {
      const saved = await saveProfile(Profile.parse(draft));
      setDraft(saved);
      setDirty(false);
      toast('Profile saved', 'good');
      onDone?.();
    } catch (e) {
      toast(errorMessage(e), 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 pb-16">
      {!simple && (<>
      <Card
        title="Résumé import"
        subtitle="PDF, DOCX or plain text. Read in your browser; nothing is uploaded."
        actions={
          <Button size="sm" icon={<Icon.Clipboard size={14} />} onClick={() => setPasteOpen(true)}>
            Paste text
          </Button>
        }
      >
        {dirty ? (
          <p className="text-[12.5px] text-warn">Save or discard your edits below first; an import is compared with your saved profile.</p>
        ) : (
          <ResumeDrop onDraft={setReview} hint="You’ll check everything that was found (and anything that differs from your profile) before it’s saved. The original is kept unchanged." />
        )}
      </Card>

      <Card title="Profile completeness">
        <div className="flex items-center gap-3">
          <span className="text-[18px] font-semibold tabular-nums">{completion.percent}%</span>
          <Meter value={completion.percent / 100} label="Profile completeness" />
        </div>
        {completion.missing.length > 0 && <p className="mt-1.5 text-[12.5px] text-muted">To improve matching: {completion.missing.join(', ')}.</p>}
      </Card>
      </>)}

      <Card title="Basics">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {(['name', 'headline', 'email', 'phone', 'location'] as const).map((k) => (
            <Field key={k} label={k === 'headline' ? 'Headline (e.g. Backend Software Engineer)' : k[0]!.toUpperCase() + k.slice(1)}>
              {(id) => <Input id={id} value={draft.basics[k]} onChange={(e) => {
                const v = e.target.value;
                update((p) => ({ ...p, basics: { ...p.basics, [k]: v } }));
              }} />}
            </Field>
          ))}
          <Field label="Links" hint="Comma-separated (LinkedIn, GitHub, portfolio)">
            {(id, d) => <ListInput id={id} value={draft.basics.links} onChange={(v) => update((p) => ({ ...p, basics: { ...p.basics, links: v } }))} />}
          </Field>
          <Field label="Summary" className="sm:col-span-2">
            {(id) => <TextArea id={id} rows={3} value={draft.basics.summary} onChange={(e) => {
              const summary = e.target.value;
              update((p) => ({ ...p, basics: { ...p.basics, summary } }));
            }} />}
          </Field>
        </div>
      </Card>

      <Card title="Skills" subtitle="Only list skills you can discuss confidently. One per line or comma-separated.">
        <ListInput id="skills" commas value={draft.skills} onChange={(v) => update((p) => ({ ...p, skills: v }))} rows={6} placeholder={'Python\nTypeScript\nPostgreSQL'} />
        <p className="mt-1 text-[12px] text-muted">One per line. Aliases such as “k8s” or “Postgres” are recognised automatically.</p>
      </Card>

      <EntryList<Experience>
        title="Experience"
        items={draft.experience}
        onChange={(experience) => update((p) => ({ ...p, experience }))}
        blank={() => ({ id: uid('exp'), title: '', company: '', location: '', start: '', end: '', employmentType: '', bullets: [] })}
        label={(e) => [e.title, e.company].filter(Boolean).join(' at ') || 'New role'}
        render={(e, set) => (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Title">{(id) => <Input id={id} value={e.title} onChange={(x) => set({ title: x.target.value })} />}</Field>
            <Field label="Company">{(id) => <Input id={id} value={e.company} onChange={(x) => set({ company: x.target.value })} />}</Field>
            <Field label="Start" hint="YYYY-MM">{(id) => <Input id={id} value={e.start} placeholder="2021-07" onChange={(x) => set({ start: x.target.value })} />}</Field>
            <Field label="End" hint="YYYY-MM or “present”">{(id) => <Input id={id} value={e.end} placeholder="present" onChange={(x) => set({ end: x.target.value })} />}</Field>
            <Field label="Location">{(id) => <Input id={id} value={e.location} onChange={(x) => set({ location: x.target.value })} />}</Field>
            <Field label="Bullets (one per line)" className="sm:col-span-2">
              {(id) => <ListInput id={id} rows={5} value={e.bullets} onChange={(bullets) => set({ bullets })} />}
            </Field>
          </div>
        )}
      />

      <EntryList<Project>
        title="Projects"
        items={draft.projects}
        onChange={(projects) => update((p) => ({ ...p, projects }))}
        blank={() => ({ id: uid('proj'), name: '', description: '', url: '', bullets: [], skills: [], kind: '', start: '', end: '' })}
        label={(p) => p.name || 'New project'}
        render={(p, set) => (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Name">{(id) => <Input id={id} value={p.name} onChange={(x) => set({ name: x.target.value })} />}</Field>
            <Field label="URL">{(id) => <Input id={id} value={p.url} onChange={(x) => set({ url: x.target.value })} />}</Field>
            <Field label="Technologies" className="sm:col-span-2">{(id) => <ListInput id={id} value={p.skills} onChange={(skills) => set({ skills })} />}</Field>
            <Field label="Description" className="sm:col-span-2">{(id) => <Input id={id} value={p.description} onChange={(x) => set({ description: x.target.value })} />}</Field>
            <Field label="Bullets (one per line)" className="sm:col-span-2">{(id) => <ListInput id={id} rows={3} value={p.bullets} onChange={(bullets) => set({ bullets })} />}</Field>
          </div>
        )}
      />

      <EntryList<Education>
        title="Education"
        items={draft.education}
        onChange={(education) => update((p) => ({ ...p, education }))}
        blank={() => ({ id: uid('edu'), institution: '', degree: '', field: '', start: '', end: '', details: [] })}
        label={(e) => [e.degree, e.institution].filter(Boolean).join(', ') || 'New entry'}
        render={(e, set) => (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Field label="Institution">{(id) => <Input id={id} value={e.institution} onChange={(x) => set({ institution: x.target.value })} />}</Field>
            <Field label="Degree">{(id) => <Input id={id} value={e.degree} placeholder="Bachelor of Science" onChange={(x) => set({ degree: x.target.value })} />}</Field>
            <Field label="Field">{(id) => <Input id={id} value={e.field} onChange={(x) => set({ field: x.target.value })} />}</Field>
            <Field label="End" hint="YYYY or YYYY-MM">{(id) => <Input id={id} value={e.end} onChange={(x) => set({ end: x.target.value })} />}</Field>
          </div>
        )}
      />

      <Card title="Certifications">
        <ListInput id="certs" rows={2} value={draft.certifications} onChange={(v) => update((p) => ({ ...p, certifications: v }))} />
      </Card>

      {!simple && (
      <Card title="Job preferences" subtitle="Used for location, seniority and deal-breaker checks.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="Target role titles">{(id) => <ListInput id={id} value={draft.preferences.roleTitles} onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, roleTitles: v } }))} placeholder="Backend Engineer, Platform Engineer" />}</Field>
          <Field label="Preferred locations">{(id) => <ListInput id={id} value={draft.preferences.locations} onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, locations: v } }))} placeholder="Toronto, Montreal" />}</Field>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[12.5px] font-medium">Work arrangement</legend>
            {ARRANGEMENTS.map((a) => (
              <Checkbox
                key={a}
                label={a === 'onsite' ? 'On-site' : a[0]!.toUpperCase() + a.slice(1)}
                checked={draft.preferences.workArrangements.includes(a)}
                onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, workArrangements: v ? [...p.preferences.workArrangements, a] : p.preferences.workArrangements.filter((x) => x !== a) } }))}
              />
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1">
            <legend className="mb-1 text-[12.5px] font-medium">Seniority</legend>
            {Seniority.options.map((s) => (
              <Checkbox
                key={s}
                label={SENIORITY_LABEL[s]}
                checked={draft.preferences.seniority.includes(s)}
                onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, seniority: v ? [...p.preferences.seniority, s] : p.preferences.seniority.filter((x) => x !== s) } }))}
              />
            ))}
          </fieldset>
          <Field label="Minimum salary (annual)" hint="Jobs listing less are flagged.">
            {(id, d) => (
              <Input
                id={id}
                aria-describedby={d}
                type="number"
                min={0}
                value={draft.preferences.minSalary ?? ''}
                onChange={(e) => {
                  const minSalary = e.target.value ? Number(e.target.value) : undefined;
                  update((p) => ({ ...p, preferences: { ...p.preferences, minSalary } }));
                }}
              />
            )}
          </Field>
          <Field label="Currency">{(id) => <Input id={id} maxLength={3} value={draft.preferences.salaryCurrency} onChange={(e) => {
                const salaryCurrency = e.target.value.toUpperCase();
                update((p) => ({ ...p, preferences: { ...p.preferences, salaryCurrency } }));
              }} />}</Field>
          <Field label="Excluded keywords" hint="Jobs mentioning these get a deal-breaker." className="sm:col-span-2">
            {(id, d) => <ListInput id={id} value={draft.preferences.excludedKeywords} onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, excludedKeywords: v } }))} placeholder="crypto, gambling" />}
          </Field>
          <Checkbox label="I need visa sponsorship" checked={draft.preferences.needsSponsorship} onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, needsSponsorship: v } }))} />
          <Checkbox label="I’m open to relocating" checked={draft.preferences.willingToRelocate} onChange={(v) => update((p) => ({ ...p, preferences: { ...p.preferences, willingToRelocate: v } }))} />
        </div>
      </Card>
      )}

      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t border-line bg-canvas/95 px-1 py-2 backdrop-blur">
        {dirty && <span className="mr-auto text-[12.5px] text-warn">Unsaved changes</span>}
        <Button variant="ghost" disabled={!dirty && !onDone} onClick={() => (setDirty(false), stored && setDraft(stored), onDone?.())}>
          {onDone ? 'Cancel' : 'Discard'}
        </Button>
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => void save()}>
          Save profile
        </Button>
      </div>

      <Dialog open={pasteOpen} onClose={() => setPasteOpen(false)} wide title="Paste résumé text"
        footer={
          <Button
            variant="primary"
            disabled={pasteText.trim().length < 50}
            onClick={() => {
              setReview(textResumeDraft(pasteText));
              setPasteOpen(false);
            }}
          >
            Parse
          </Button>
        }
      >
        <TextArea aria-label="Résumé text" rows={14} value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
      </Dialog>

    </div>
  );
}

function EntryList<T extends { id: string }>({ title, items, onChange, blank, label, render }: { title: string; items: T[]; onChange: (v: T[]) => void; blank: () => T; label: (t: T) => string; render: (t: T, set: (patch: Partial<T>) => void) => React.ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card
      title={title}
      actions={
        <Button
          size="sm"
          icon={<Icon.Plus size={14} />}
          onClick={() => {
            const b = blank();
            onChange([b, ...items]);
            setOpen(b.id);
          }}
        >
          Add
        </Button>
      }
    >
      {!items.length && <p className="text-[12.5px] text-muted">Nothing added yet.</p>}
      <ul className="flex flex-col gap-1.5">
        {items.map((item, i) => (
          <li key={item.id} className="rounded-md border border-line">
            <div className="flex items-center gap-1 px-2 py-1.5">
              <button type="button" className="min-w-0 flex-1 truncate text-left font-medium" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>
                {label(item)}
              </button>
              <IconButton label="Move up" disabled={i === 0} onClick={() => onChange(items.map((x, j) => (j === i - 1 ? item : j === i ? items[i - 1]! : x)))}>
                ↑
              </IconButton>
              <IconButton label={`Remove ${label(item)}`} onClick={() => onChange(items.filter((x) => x.id !== item.id))}>
                <Icon.Trash size={15} />
              </IconButton>
            </div>
            {open === item.id && <div className="border-t border-line p-2">{render(item, (patch) => onChange(items.map((x) => (x.id === item.id ? { ...x, ...patch } : x))))}</div>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

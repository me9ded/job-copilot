import { useEffect, useMemo, useState } from 'react';
import { AiError } from '../../lib/ai/client';
import { aiCoverLetter, aiRewriteBullets, type CheckedRewrite } from '../../lib/ai/features';
import type { ClaimCheck } from '../../lib/ai/guard';
import { draftCoverLetter } from '../../lib/resume/cover-letter';
import { diffLines } from '../../lib/resume/diff';
import { docxBlob, downloadBlob, letterDocx, letterPdf, resumeDocx, resumePdf, resumeToText, safeFilename } from '../../lib/resume/export';
import { DEFAULT_TAILOR_OPTIONS, lintBullet, suggestSummary, tailorResume, type TailorOptions } from '../../lib/resume/tailor';
import { deleteResume, putCoverLetter, putResume } from '../../lib/storage/repo';
import type { JobRecord, Profile, ResumeContent, ResumeVersion } from '../../lib/types';
import { formatDate, nowIso, uid } from '../../lib/util';
import { Alert, Badge, Button, Card, Checkbox, Dialog, EmptyState, Field, Input, ListInput, Loading, PageHeader, Select, Tabs, TextArea, cx, useToast } from '../components';
import { useAction, useCoverLetters, useJobs, useMatch, useProfile, useResumes, useSettings } from '../hooks';
import { Icon } from '../icons';
import { PermissionButton, useNav } from '../permission';
import { ProfileEditor } from './Profile';

type StudioTab = 'profile' | 'tailor' | 'letter' | 'versions';

export function ResumeStudioView({ initialTab }: { initialTab?: StudioTab }) {
  const nav = useNav();
  const [tab, setTab] = useState<StudioTab>(initialTab ?? (nav.jobId ? 'tailor' : 'profile'));
  useEffect(() => {
    if (initialTab) setTab(initialTab);
    else if (nav.jobId) setTab('tailor');
  }, [initialTab, nav.jobId]);
  return (
    <div>
      <PageHeader title="Résumé Studio" description="Your canonical profile, job-specific versions and cover letters." />
      <div className="mb-3">
        <Tabs
          label="Résumé Studio sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'profile', label: 'Profile' },
            { id: 'tailor', label: 'Tailor' },
            { id: 'letter', label: 'Cover letter' },
            { id: 'versions', label: 'Versions' },
          ]}
        />
      </div>
      {tab === 'profile' && <ProfileEditor />}
      {tab === 'tailor' && <TailorTab />}
      {tab === 'letter' && <CoverLetterTab />}
      {tab === 'versions' && <VersionsTab />}
    </div>
  );
}

export function JobPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  const jobs = useJobs();
  const saved = useMemo(() => (jobs ?? []).filter((j) => j.saved || j.id === value).sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? '')), [jobs, value]);
  return (
    <Field label="Job">
      {(id) => (
        <Select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>
            {saved.length ? 'Choose a saved job…' : 'Save a job first'}
          </option>
          {saved.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title} — {j.company}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

export function useSelectedJob(): [JobRecord | undefined, (id: string) => void] {
  const nav = useNav();
  const jobs = useJobs();
  const [id, setId] = useState<string | null>(nav.jobId);
  useEffect(() => {
    if (nav.jobId) setId(nav.jobId);
  }, [nav.jobId]);
  return [jobs?.find((j) => j.id === id), setId];
}

function profileContent(p: Profile): ResumeContent {
  const { version: _v, updatedAt: _u, preferences: _p, ...content } = p;
  return content;
}

function ClaimWarning({ check }: { check: ClaimCheck }) {
  if (check.ok) return null;
  return (
    <Alert tone="warn" title="Not found in your profile">
      {check.unsupportedSkills.length > 0 && <p>Skills: {check.unsupportedSkills.join(', ')}</p>}
      {check.unsupportedNumbers.length > 0 && <p>Numbers: {check.unsupportedNumbers.join(', ')}</p>}
      <p>Only keep these if they are true. Otherwise edit them out.</p>
    </Alert>
  );
}

function AiErrorAlert({ error, origin, retry }: { error: string; origin: string | null; retry: () => void }) {
  return (
    <Alert tone="bad" action={origin && <PermissionButton origins={[origin]} label="Grant access" onGranted={retry} />}>
      {error}
    </Alert>
  );
}

/* ----------------------------------------------------------------------------
 * Tailor
 * ------------------------------------------------------------------------- */

function TailorTab() {
  const profile = useProfile();
  const settings = useSettings();
  const resumes = useResumes();
  const [job, setJobId] = useSelectedJob();
  const match = useMatch(job ?? null, profile, settings);
  const toast = useToast();
  const [baseId, setBaseId] = useState<string>('profile');
  const [opts, setOpts] = useState<TailorOptions>(DEFAULT_TAILOR_OPTIONS);
  const [draft, setDraft] = useState<ResumeContent | null>(null);
  const [changes, setChanges] = useState<string[]>([]);
  const [view, setView] = useState<'edit' | 'compare'>('edit');
  const [name, setName] = useState('');
  const [rewrites, setRewrites] = useState<CheckedRewrite[] | null>(null);
  const [permOrigin, setPermOrigin] = useState<string | null>(null);

  const base: ResumeContent | null = useMemo(() => {
    if (!profile) return null;
    if (baseId === 'profile') return profileContent(profile);
    return resumes?.find((r) => r.id === baseId)?.content ?? profileContent(profile);
  }, [profile, resumes, baseId]);

  const generate = () => {
    if (!base || !job) return;
    const r = tailorResume(base, job, match ?? null, opts);
    setDraft(r.content);
    setChanges(r.changes);
    setRewrites(null);
    setName(`${job.company} — ${job.title}`.slice(0, 80));
  };
  // Regenerate when the job, base or options change, but never overwrite edits silently.
  useEffect(() => {
    if (!draft) generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, base, match?.cacheKey]);

  const aiRewrite = useAction(async () => {
    if (!job || !draft || !profile) return;
    setPermOrigin(null);
    const bullets = draft.experience.flatMap((e) => e.bullets);
    try {
      const r = await aiRewriteBullets(job, profileContent(profile), bullets);
      setRewrites(r.data);
    } catch (e) {
      if (e instanceof AiError && e.code === 'permission' && e.origin) setPermOrigin(e.origin);
      throw e;
    }
  });

  const save = useAction(async () => {
    if (!draft || !job) return;
    const now = nowIso();
    const v: ResumeVersion = { id: uid('res'), name: name || `${job.company} — ${job.title}`, kind: 'tailored', jobId: job.id, content: draft, createdAt: now, updatedAt: now };
    await putResume(v);
    toast('Saved as a new résumé version', 'good');
  });

  const exportAs = async (kind: 'docx' | 'pdf' | 'txt') => {
    if (!draft) return;
    const file = safeFilename(`${draft.basics.name || 'resume'}-${job?.company ?? ''}`);
    if (kind === 'docx') downloadBlob(await docxBlob(resumeDocx(draft)), `${file}.docx`);
    else if (kind === 'pdf') downloadBlob(await resumePdf(draft), `${file}.pdf`, 'application/pdf');
    else downloadBlob(resumeToText(draft), `${file}.txt`, 'text/plain');
  };

  if (!profile || !settings || !resumes) return <Loading />;
  if (!profile.experience.length && !profile.skills.length)
    return <EmptyState icon={<Icon.User size={28} />} title="Add your profile first">Tailoring only reorganises content from your own profile, so add it in the Profile tab.</EmptyState>;

  const setRole = (id: string, bullets: string[]) => draft && setDraft({ ...draft, experience: draft.experience.map((e) => (e.id === id ? { ...e, bullets } : e)) });
  const applyRewrite = (rw: CheckedRewrite) => {
    if (!draft) return;
    setDraft({ ...draft, experience: draft.experience.map((e) => ({ ...e, bullets: e.bullets.map((b) => (b === rw.original ? rw.rewritten : b)) })) });
    setRewrites((list) => list?.filter((x) => x !== rw) ?? null);
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <JobPicker value={job?.id ?? null} onChange={(id) => (setJobId(id), setDraft(null))} />
          <Field label="Start from">
            {(id) => (
              <Select id={id} value={baseId} onChange={(e) => (setBaseId(e.target.value), setDraft(null))}>
                <option value="profile">Canonical profile</option>
                {resumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Max bullets per role">
            {(id) => <Input id={id} type="number" min={1} max={10} value={opts.maxBulletsPerRole} onChange={(e) => setOpts({ ...opts, maxBulletsPerRole: Number(e.target.value) || 5 })} />}
          </Field>
          <Field label="Max projects">{(id) => <Input id={id} type="number" min={0} max={10} value={opts.maxProjects} onChange={(e) => setOpts({ ...opts, maxProjects: Number(e.target.value) })} />}</Field>
          <Checkbox label="Hide skills unrelated to this job" checked={opts.hideUnrelatedSkills} onChange={(v) => setOpts({ ...opts, hideUnrelatedSkills: v })} />
        </div>
        {base && base.experience.length > 0 && (
          <fieldset className="mt-2">
            <legend className="mb-1 text-[12.5px] font-medium">Include roles</legend>
            <div className="flex flex-col gap-1">
              {base.experience.map((e) => (
                <Checkbox key={e.id} label={[e.title, e.company].filter(Boolean).join(' at ')} checked={!opts.excludedExperience.includes(e.id)} onChange={(v) => setOpts({ ...opts, excludedExperience: v ? opts.excludedExperience.filter((x) => x !== e.id) : [...opts.excludedExperience, e.id] })} />
              ))}
            </div>
          </fieldset>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Icon.Refresh size={14} />} disabled={!job} onClick={generate}>
            {draft ? 'Rebuild draft' : 'Build draft'}
          </Button>
          {draft && (
            <span className="self-center text-[12px] text-muted">Rebuilding replaces your edits to the draft.</span>
          )}
        </div>
      </Card>

      {!job ? (
        <EmptyState icon={<Icon.Doc size={28} />} title="Choose a saved job to tailor for" />
      ) : !draft ? null : (
        <>
          {changes.length > 0 && (
            <Card title="What changed">
              <ul className="list-disc pl-4 text-[13px]">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
            </Card>
          )}
          {match && match.requiredMissing.length > 0 && (
            <Alert tone="warn" title="Missing qualifications (not added)">
              {match.requiredMissing.join(', ')}. The draft never claims these. Add them to your profile only if you genuinely have them.
            </Alert>
          )}
          <Tabs label="Draft view" value={view} onChange={setView} tabs={[{ id: 'edit', label: 'Edit draft' }, { id: 'compare', label: 'Compare with original' }]} />
          {view === 'compare' && base ? (
            <DiffView before={resumeToText(base)} after={resumeToText(draft)} />
          ) : (
            <div className="flex flex-col gap-3">
              <Card
                title="Summary"
                actions={
                  <Button size="sm" variant="ghost" onClick={() => setDraft({ ...draft, basics: { ...draft.basics, summary: suggestSummary(draft, match ?? null) } })}>
                    Use factual suggestion
                  </Button>
                }
              >
                <TextArea aria-label="Summary" rows={3} value={draft.basics.summary} onChange={(e) => setDraft({ ...draft, basics: { ...draft.basics, summary: e.target.value } })} />
              </Card>
              <Card title="Skills (matching skills first)">
                <ListInput id="draft-skills" commas rows={5} value={draft.skills} onChange={(skills) => setDraft({ ...draft, skills })} />
              </Card>
              <Card
                title="Experience"
                actions={
                  settings.ai.features.resumeTailor !== 'none' && (
                    <Button size="sm" icon={<Icon.Spark size={14} />} busy={aiRewrite.busy} onClick={() => void aiRewrite.run()}>
                      Suggest rewrites
                    </Button>
                  )
                }
              >
                {aiRewrite.error && <AiErrorAlert error={aiRewrite.error} origin={permOrigin} retry={() => void aiRewrite.run()} />}
                {rewrites && rewrites.length > 0 && (
                  <div className="mb-3 flex flex-col gap-2">
                    <p className="text-[12.5px] font-medium">AI suggestions — review each one. Nothing is applied automatically.</p>
                    {rewrites.map((rw, i) => (
                      <div key={i} className="rounded-md border border-line p-2 text-[13px]">
                        <p className="text-muted line-through">{rw.original}</p>
                        <p>{rw.rewritten}</p>
                        <ClaimWarning check={rw.check} />
                        <div className="mt-1.5 flex gap-1.5">
                          <Button size="sm" variant={rw.check.ok ? 'primary' : 'secondary'} onClick={() => applyRewrite(rw)}>
                            {rw.check.ok ? 'Use this' : 'Use anyway'}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setRewrites((l) => l?.filter((x) => x !== rw) ?? null)}>
                            Discard
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-3">
                  {draft.experience.map((e) => (
                    <div key={e.id}>
                      <p className="mb-1 font-medium">{[e.title, e.company].filter(Boolean).join(' — ')}</p>
                      <ListInput id={`b-${e.id}`} rows={Math.max(3, e.bullets.length + 1)} value={e.bullets} onChange={(b) => setRole(e.id, b)} />
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {e.bullets.map((b, i) => {
                          const issues = lintBullet(b);
                          return issues.length ? (
                            <li key={i} className="text-[12px] text-muted">
                              <span className="font-medium text-fg">Bullet {i + 1}:</span> {issues.map((x) => x.message).join(' ')}
                            </li>
                          ) : null;
                        })}
                      </ul>
                    </div>
                  ))}
                </div>
              </Card>
              {draft.projects.length > 0 && (
                <Card title="Projects (most relevant first)">
                  <ul className="list-disc pl-4 text-[13px]">{draft.projects.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
                </Card>
              )}
            </div>
          )}
          <Card title="Save & export">
            <div className="flex flex-col gap-2">
              <Field label="Version name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" busy={save.busy} icon={<Icon.Check size={14} />} onClick={() => void save.run()}>
                  Save version
                </Button>
                <Button icon={<Icon.Download size={14} />} onClick={() => void exportAs('docx')}>
                  DOCX
                </Button>
                <Button icon={<Icon.Download size={14} />} onClick={() => void exportAs('pdf')}>
                  PDF
                </Button>
                <Button icon={<Icon.Download size={14} />} onClick={() => void exportAs('txt')}>
                  Text
                </Button>
              </div>
              {save.error && <Alert tone="bad">{save.error}</Alert>}
              <p className="text-[12px] text-muted">Exports are single-column, use standard headings and real text, which applicant tracking systems parse reliably. Your original résumé is never changed.</p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const ops = useMemo(() => diffLines(before, after), [before, after]);
  const added = ops.filter((o) => o.type === 'add').length;
  const removed = ops.filter((o) => o.type === 'del').length;
  return (
    <Card title="Changes" subtitle={`${added} line(s) added or moved, ${removed} removed or moved`}>
      <pre className="overflow-x-auto font-mono text-[12px] leading-relaxed">
        {ops.map((o, i) => (
          <div key={i} className={cx('px-1 whitespace-pre-wrap', o.type === 'add' && 'bg-good-soft text-good', o.type === 'del' && 'bg-bad-soft text-bad line-through')}>
            <span aria-hidden="true">{o.type === 'add' ? '+ ' : o.type === 'del' ? '− ' : '  '}</span>
            <span className="sr-only">{o.type === 'add' ? 'Added: ' : o.type === 'del' ? 'Removed: ' : ''}</span>
            {o.value || ' '}
          </div>
        ))}
      </pre>
    </Card>
  );
}

/* ----------------------------------------------------------------------------
 * Cover letter
 * ------------------------------------------------------------------------- */

function CoverLetterTab() {
  const profile = useProfile();
  const settings = useSettings();
  const letters = useCoverLetters();
  const [job, setJobId] = useSelectedJob();
  const match = useMatch(job ?? null, profile, settings);
  const toast = useToast();
  const [body, setBody] = useState('');
  const [source, setSource] = useState<'template' | 'ai' | 'manual'>('template');
  const [check, setCheck] = useState<ClaimCheck | null>(null);
  const [tone, setTone] = useState<'warm' | 'concise'>('warm');
  const [addressGaps, setAddressGaps] = useState(false);
  const [permOrigin, setPermOrigin] = useState<string | null>(null);
  const existing = job && letters ? letters[job.id] : undefined;

  useEffect(() => {
    setBody(existing?.body ?? '');
    setSource(existing?.generatedBy ?? 'template');
    setCheck(null);
  }, [job?.id, existing?.id]);

  const ai = useAction(async () => {
    if (!job || !profile) return;
    setPermOrigin(null);
    try {
      const r = await aiCoverLetter(job, profileContent(profile));
      setBody(r.data.body);
      setCheck(r.data.check);
      setSource('ai');
    } catch (e) {
      if (e instanceof AiError && e.code === 'permission' && e.origin) setPermOrigin(e.origin);
      throw e;
    }
  });
  const save = useAction(async () => {
    if (!job) return;
    const now = nowIso();
    await putCoverLetter({ id: existing?.id ?? uid('cl'), jobId: job.id, body, generatedBy: source, createdAt: existing?.createdAt ?? now, updatedAt: now });
    toast('Cover letter saved', 'good');
  });

  if (!profile || !settings || !letters) return <Loading />;
  const file = safeFilename(`cover-letter-${job?.company ?? ''}`);

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <JobPicker value={job?.id ?? null} onChange={setJobId} />
          <Field label="Tone">
            {(id) => (
              <Select id={id} value={tone} onChange={(e) => setTone(e.target.value as 'warm' | 'concise')}>
                <option value="warm">Warm</option>
                <option value="concise">Concise</option>
              </Select>
            )}
          </Field>
          <Checkbox label="Acknowledge missing requirements honestly" checked={addressGaps} onChange={setAddressGaps} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!job}
            onClick={() => {
              if (!job) return;
              setBody(draftCoverLetter(profileContent(profile), job, match ?? null, { tone, addressGaps }));
              setSource('template');
              setCheck(null);
            }}
          >
            Draft from template
          </Button>
          {settings.ai.features.coverLetter !== 'none' && (
            <Button icon={<Icon.Spark size={14} />} disabled={!job} busy={ai.busy} onClick={() => void ai.run()}>
              Draft with AI
            </Button>
          )}
        </div>
        <p className="mt-2 text-[12px] text-muted">Drafts use only facts from your profile. Always read and edit before sending.</p>
      </Card>
      {ai.error && <AiErrorAlert error={ai.error} origin={permOrigin} retry={() => void ai.run()} />}
      {check && <ClaimWarning check={check} />}
      {job && (
        <Card title={existing ? `Saved ${formatDate(existing.updatedAt)}` : 'Draft'} actions={<Badge>{source === 'ai' ? 'AI draft' : source === 'manual' ? 'Edited' : 'Template'}</Badge>}>
          <TextArea
            aria-label="Cover letter"
            rows={16}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (source === 'template') setSource('manual');
            }}
            placeholder="Generate a draft or write your own."
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <Button variant="primary" busy={save.busy} disabled={!body.trim()} onClick={() => void save.run()}>
              Save
            </Button>
            <Button disabled={!body.trim()} onClick={() => void navigator.clipboard.writeText(body).then(() => toast('Copied'))}>
              Copy
            </Button>
            <Button icon={<Icon.Download size={14} />} disabled={!body.trim()} onClick={async () => downloadBlob(await docxBlob(letterDocx(body)), `${file}.docx`)}>
              DOCX
            </Button>
            <Button icon={<Icon.Download size={14} />} disabled={!body.trim()} onClick={async () => downloadBlob(await letterPdf(body), `${file}.pdf`, 'application/pdf')}>
              PDF
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Versions
 * ------------------------------------------------------------------------- */

function VersionsTab() {
  const resumes = useResumes();
  const jobs = useJobs();
  const toast = useToast();
  const [viewing, setViewing] = useState<ResumeVersion | null>(null);
  const [renaming, setRenaming] = useState<{ v: ResumeVersion; name: string } | null>(null);
  const [deleting, setDeleting] = useState<ResumeVersion | null>(null);
  if (!resumes) return <Loading />;
  if (!resumes.length) return <EmptyState icon={<Icon.Doc size={28} />} title="No versions yet">Uploading a résumé stores the original here; tailored drafts you save appear here too.</EmptyState>;
  const jobName = (id?: string) => jobs?.find((j) => j.id === id)?.company;

  const duplicate = async (v: ResumeVersion) => {
    const now = nowIso();
    await putResume({ ...v, id: uid('res'), kind: 'custom', name: `${v.name} (copy)`, rawText: undefined, createdAt: now, updatedAt: now });
    toast('Copy created');
  };

  return (
    <div className="flex flex-col gap-2">
      <ul className="overflow-hidden rounded-lg border border-line bg-surface">
        {[...resumes].reverse().map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 last:border-b-0">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{v.name}</p>
              <p className="text-[12px] text-muted">
                <Badge tone={v.kind === 'original' ? 'accent' : 'neutral'}>{v.kind === 'original' ? 'Original (read-only)' : v.kind === 'tailored' ? 'Tailored' : 'Custom'}</Badge> {jobName(v.jobId) ? `for ${jobName(v.jobId)} · ` : ''}
                {formatDate(v.updatedAt)}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setViewing(v)}>
              View
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void duplicate(v)}>
              Duplicate
            </Button>
            {v.kind !== 'original' && (
              <Button size="sm" variant="ghost" onClick={() => setRenaming({ v, name: v.name })}>
                Rename
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<Icon.Download size={14} />} onClick={async () => downloadBlob(await docxBlob(resumeDocx(v.content)), `${safeFilename(v.name)}.docx`)}>
              DOCX
            </Button>
            <Button size="sm" variant="ghost" icon={<Icon.Download size={14} />} onClick={async () => downloadBlob(await resumePdf(v.content), `${safeFilename(v.name)}.pdf`, 'application/pdf')}>
              PDF
            </Button>
            <Button size="sm" variant="danger" onClick={() => setDeleting(v)}>
              Delete
            </Button>
          </li>
        ))}
      </ul>
      <Dialog open={!!viewing} onClose={() => setViewing(null)} wide title={viewing?.name ?? ''}>
        {viewing && (
          <>
            {viewing.rawText && <p className="mb-2 text-[12px] text-muted">Showing the extracted text exactly as uploaded.</p>}
            <pre className="font-sans text-[13px] whitespace-pre-wrap">{viewing.rawText ?? resumeToText(viewing.content)}</pre>
          </>
        )}
      </Dialog>
      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title="Rename version"
        footer={
          <Button
            variant="primary"
            onClick={async () => {
              if (renaming) await putResume({ ...renaming.v, name: renaming.name.trim() || renaming.v.name });
              setRenaming(null);
            }}
          >
            Save
          </Button>
        }
      >
        <Input aria-label="Version name" value={renaming?.name ?? ''} onChange={(e) => renaming && setRenaming({ ...renaming, name: e.target.value })} />
      </Dialog>
      <Dialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title="Delete this version?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (deleting) await deleteResume(deleting.id);
                setDeleting(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p>{deleting?.kind === 'original' ? 'This is an uploaded original. Your canonical profile is not affected, but the original text will be gone.' : 'This cannot be undone.'}</p>
      </Dialog>
    </div>
  );
}

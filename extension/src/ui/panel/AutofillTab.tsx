import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { AiError } from '../../lib/ai/client';
import { aiAnswerQuestion } from '../../lib/ai/features';
import { composeAnswer, hasSlot, QUESTION_TYPE_LABEL, type Draft } from '../../lib/autofill/answers';
import type { FillReport, QuestionCategory, Unanswered } from '../../lib/autofill/fill';
import { profileIsEmpty } from '../../lib/matching/service';
import { ensureApplication, setApplicationStatus, setJobSaved, upsertJob } from '../../lib/storage/repo';
import { SESSION_KEYS } from '../../lib/storage/schema';
import type { ExtractedJob, JobRecord, Profile } from '../../lib/types';
import { nowIso } from '../../lib/util';
import { FailedList, FillResult, useAutofill, useResumeChoices, type AutofillRequest } from '../autofill';
import { Alert, Badge, Button, Card, Checkbox, Dialog, Input, Select, TextArea, cx, useToast } from '../components';
import { useAction, useJobs, useProfile, useSessionValue, useSettings } from '../hooks';
import { Icon } from '../icons';
import { SectionTitle, useJobContext, type PanelTab } from './shared';

const REQUEST_TTL_MS = 30_000;

const CATEGORY_LABEL: Record<QuestionCategory, string> = {
  contact: 'Contact details',
  eligibility: 'Work eligibility',
  sponsorship: 'Sponsorship',
  salary: 'Pay',
  availability: 'Availability',
  relocation: 'Location & relocation',
  employment: 'Employment type',
  demographics: 'Voluntary self-identification',
  experience: 'Experience & skills',
  documents: 'Documents',
  consent: 'Agreements',
  custom: 'Other questions',
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABEL) as QuestionCategory[];

/** Required first, then grouped by topic, in a fixed topic order. */
function groupByCategory(qs: Unanswered[]): Array<[QuestionCategory, Unanswered[]]> {
  const by = new Map<QuestionCategory, Unanswered[]>();
  for (const q of [...qs].sort((a, b) => Number(b.required) - Number(a.required))) {
    const c = q.category ?? 'custom';
    by.set(c, [...(by.get(c) ?? []), q]);
  }
  return CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => [c, by.get(c)!]);
}
const CHOICE_KINDS = new Set(['select', 'radio', 'buttons', 'combobox', 'listbox', 'checkbox', 'checkboxes']);

type Step = 0 | 1 | 2 | 3;
const STEPS = ['Open form', 'Fill', 'Your answers', 'Review & submit'];

function stepOf(report: FillReport | null, busy: boolean): Step {
  if (busy) return 1;
  if (!report || report.stop === 'no_form') return 0;
  if (report.stop === 'submit_ready' || report.stop === 'done') return 3;
  if (report.unanswered.length || report.stop === 'needs_answers') return 2;
  return 1;
}

function Stepper({ step }: { step: Step }) {
  return (
    <ol className="flex items-center gap-1 text-[11px]" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 flex-col gap-1" aria-current={i === step ? 'step' : undefined}>
          <span className={cx('h-1 rounded-full', i <= step ? 'bg-accent' : 'bg-subtle')} />
          <span className={cx('truncate', i === step ? 'font-semibold text-fg' : 'text-muted')}>{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** Which job this application is for: the job analyzed in this tab, or one the user picks. */
function useTargetJob(tabId: number | null | undefined) {
  const context = useJobContext(tabId);
  const jobs = useJobs();
  const [chosenId, setChosenId] = useState<string | null>(null);
  useEffect(() => setChosenId(null), [tabId]);
  const chosen = chosenId ? jobs?.find((j) => j.id === chosenId) : undefined;
  const job: ExtractedJob | JobRecord | null = chosen ?? context ?? null;
  return { job, context, chosenId, setChosenId, jobs };
}

export function AutofillTab({ tabId, go }: { tabId: number | null | undefined; go: (t: PanelTab) => void }) {
  const profile = useProfile();
  const settings = useSettings();
  const target = useTargetJob(tabId);
  const auto = useAutofill(tabId, { jobId: target.chosenId, context: target.job ? { title: target.job.title, company: target.job.company } : null });
  const request = useSessionValue<AutofillRequest>(SESSION_KEYS.autofillRequest);
  const report = auto.report;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const choicesForResume = useResumeChoices();
  // The résumé to attach on this run; starts from the saved choice.
  const [attach, setAttach] = useState<string | null>(null);
  useEffect(() => setAttach(null), [tabId]);

  // The popup, toolbar shortcut or right-click menu asked to autofill this tab: do it once, as soon as data is loaded.
  useEffect(() => {
    if (!request || request.tabId !== tabId || !auto.ready || auto.fill.busy) return;
    void browser.storage.session.remove(SESSION_KEYS.autofillRequest);
    if (Date.now() - request.at > REQUEST_TTL_MS) return;
    void auto.fill.run(request.tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, auto.ready, tabId]);

  const step = stepOf(report, auto.fill.busy);
  const empty = profile ? profileIsEmpty(profile) : false;
  const aiOn = !!settings && settings.ai.features.applicationAnswers !== 'none';
  const toSign = report?.unanswered.filter((u) => u.reason === 'signature') ?? [];
  const open = report?.unanswered.filter((u) => u.reason !== 'signature') ?? [];
  const written = open.filter((u) => !CHOICE_KINDS.has(u.kind ?? 'text'));
  const choices = open.filter((u) => CHOICE_KINDS.has(u.kind ?? 'text'));

  return (
    <div className="flex flex-col gap-3">
      <Stepper step={step} />

      <TargetJobCard target={target} />

      {empty && (
        <Alert tone="warn" title="Add your résumé first" action={<Button size="sm" onClick={() => go('profile')}>Open profile</Button>}>
          Autofill uses only what’s in your profile.
        </Alert>
      )}

      <Button variant="primary" className="h-11! w-full text-[15px]!" icon={<Icon.Form size={18} />} busy={auto.fill.busy} disabled={!tabId || empty} onClick={() => void auto.fill.run(undefined, attach ?? undefined)}>
        {report && report.stop !== 'no_form' && report.stop !== 'submit_ready' ? 'Continue autofill' : 'Autofill this page'}
      </Button>
      {settings && choicesForResume && !empty && (
        <label className="flex items-center gap-2 text-[12px] text-muted">
          <span className="shrink-0">Résumé to attach</span>
          <Select aria-label="Résumé to attach on this application" value={attach ?? settings.autofill.attach} onChange={(e) => setAttach(e.target.value)} className="h-7 text-[12px]">
            {choicesForResume.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        </label>
      )}
      {!report && !auto.fill.error && !auto.fill.busy && (
        <p className="text-center text-[12px] text-muted">Open the job’s application form, then press Autofill. It fills each step, drafts answers for you to review, and stops before the final submit.</p>
      )}
      {auto.fill.error && (
        <Alert tone="bad">{auto.fill.error}</Alert>
      )}
      {report && <FillResult report={report} attach={attach ?? auto.attach} />}

      {report && <FailedList report={report} busy={auto.answer.busy} onAnswer={(q, v, r) => auto.answer.run(q, v, r)} onReveal={auto.reveal} onSkip={auto.skip} />}

      {toSign.length > 0 && (
        <Alert tone="warn" title="Sign these yourself">
          <p>Job Copilot never signs or initials for you.</p>
          <ul className="mt-1 flex flex-col gap-1">
            {toSign.map((u) => (
              <li key={u.id ?? u.label} className="flex items-center justify-between gap-2">
                <span>{u.label}</span>
                <Button size="sm" variant="ghost" icon={<Icon.Search size={13} />} onClick={() => auto.reveal(u)}>
                  Show on page
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {report && written.length > 0 && profile && (
        <section aria-label="Written answers" className="flex flex-col gap-2">
          <SectionTitle>Suggested answers ({written.length})</SectionTitle>
          <p className="text-[12px] text-muted">Drafted from your own résumé bullets{target.job ? ` and tailored to ${target.job.title || 'this job'}` : ''}. Read and edit each one. Nothing goes into the page until you press Use.</p>
          {auto.answer.error && <Alert tone="bad">{auto.answer.error}</Alert>}
          {[...written]
            .sort((a, b) => Number(b.required) - Number(a.required))
            .map((u) => (
              <WrittenQuestion key={u.id ?? u.label} q={u} profile={profile} job={target.job} aiOn={aiOn} busy={auto.answer.busy} onUse={(v, remember) => auto.answer.run(u, v, remember)} onSkip={() => auto.skip(u)} />
            ))}
        </section>
      )}

      {report && choices.length > 0 && (
        <section aria-label="Choices" className="flex flex-col gap-2">
          <SectionTitle>Questions to choose ({choices.length})</SectionTitle>
          <p className="text-[12px] text-muted">Autofill doesn’t guess these. Pick your answer; tick Remember to reuse it on other applications.</p>
          {auto.answer.error && !written.length && <Alert tone="bad">{auto.answer.error}</Alert>}
          {groupByCategory(choices).map(([category, qs]) => (
            <div key={category} className="flex flex-col gap-2">
              {category !== 'custom' && <p className="text-[11.5px] font-medium text-muted">{CATEGORY_LABEL[category]}</p>}
              {qs.map((u) => (
                <ChoiceQuestion key={u.id ?? u.label} q={u} busy={auto.answer.busy} onUse={(v, remember) => auto.answer.run(u, v, remember)} />
              ))}
            </div>
          ))}
        </section>
      )}

      {report && report.noValue.length > 0 && (
        <Card title="Missing from your profile">
          <p className="text-[12.5px]">The form asks for {report.noValue.join(', ')}, which your profile doesn’t have.</p>
          <div className="mt-2">
            <Button size="sm" icon={<Icon.User size={14} />} onClick={() => go('profile')}>
              Add to profile
            </Button>
          </div>
        </Card>
      )}

      {report && report.stop === 'submit_ready' && (
        <Card title="Last step is yours">
          <p className="text-[12.5px]">
            Review every field on the page{report.unanswered.length ? ' (optional questions above are still empty)' : ''}, then press {report.submitLabel ? `“${report.submitLabel}”` : 'Submit'} yourself. Job Copilot never submits for you.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<Icon.Check size={14} />} onClick={() => setConfirmOpen(true)}>
              I submitted it
            </Button>
          </div>
        </Card>
      )}
      <MarkAppliedDialog open={confirmOpen} onClose={() => setConfirmOpen(false)} job={target.job} findJob={auto.findJob} />
    </div>
  );
}

function TargetJobCard({ target }: { target: ReturnType<typeof useTargetJob> }) {
  const [picking, setPicking] = useState(false);
  const saved = (target.jobs ?? []).filter((j) => j.saved).sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
  const job = target.job;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface px-3 py-2">
      <Icon.Briefcase size={16} className="mt-0.5 shrink-0 text-muted" />
      <div className="min-w-0 flex-1 text-[12.5px]">
        {picking ? (
          <Select
            aria-label="Which job is this application for?"
            value={target.chosenId ?? ''}
            onChange={(e) => {
              target.setChosenId(e.target.value || null);
              setPicking(false);
            }}
          >
            <option value="">{target.context ? `${target.context.title} (this tab)` : 'No specific job'}</option>
            {saved.map((j) => (
              <option key={j.id} value={j.id}>
                {j.title} · {j.company}
              </option>
            ))}
          </Select>
        ) : job ? (
          <>
            <p className="truncate font-medium">{job.title || 'Untitled role'}</p>
            <p className="truncate text-muted">{job.company || 'Unknown company'} · answers are tailored to this job</p>
          </>
        ) : (
          <>
            <p className="font-medium">No job selected</p>
            <p className="text-muted">Analyze the job posting first (Job tab), or pick a saved job, so answers can be tailored.</p>
          </>
        )}
      </div>
      {!picking && (saved.length > 0 || target.context) && (
        <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
          Change
        </Button>
      )}
    </div>
  );
}

function WrittenQuestion({
  q,
  profile,
  job,
  aiOn,
  busy,
  onUse,
  onSkip,
}: {
  q: Unanswered;
  profile: Profile;
  job: ExtractedJob | null;
  aiOn: boolean;
  busy: boolean;
  onUse: (value: string, remember: boolean) => Promise<unknown>;
  onSkip: () => void;
}) {
  const draft: Draft = useMemo(() => composeAnswer(q.label, profile, job, { maxLength: q.maxLength, short: q.kind === 'text' }), [q.label, q.maxLength, q.kind, profile, job]);
  const [text, setText] = useState(draft.text);
  const [remember, setRemember] = useState(draft.type === 'years_of');
  const [flags, setFlags] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const toast = useToast();
  useEffect(() => {
    setText(draft.text);
    setFlags([]);
  }, [draft]);

  const improve = useAction(async () => {
    try {
      const res = await aiAnswerQuestion(q.label, profile, job, { text, evidence: draft.evidence.map((e) => e.text) }, q.maxLength);
      if (!res.data.answer) throw new Error('The model found nothing in your profile that answers this. Keep the draft or write it yourself.');
      setText(res.data.answer);
      setApproved(false);
      setFlags([...res.data.check.unsupportedNumbers.map((n) => `number “${n}”`), ...res.data.check.unsupportedSkills.map((s) => `skill “${s}”`)]);
      if (res.cached) toast('Reused the previous suggestion', 'neutral');
    } catch (e) {
      throw e instanceof AiError ? new Error(e.message) : e;
    }
  });

  const slot = hasSlot(text);
  const over = q.maxLength !== undefined && text.length > q.maxLength;
  const canUse = !!text.trim() && !slot && !over && (!flags.length || approved);
  const rows = q.kind === 'text' ? 2 : Math.min(12, Math.max(3, Math.ceil(text.length / 45) + 1));

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-3" aria-label={q.section ? `${q.label} (${q.section})` : q.label}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-[13px] font-medium">
          {q.label}
          {q.required && <span className="text-bad"> *</span>}
          {q.section && <span className="block text-[11.5px] font-normal text-muted">In “{q.section}”</span>}
        </p>
        <Badge tone="accent">{QUESTION_TYPE_LABEL[draft.type]}</Badge>
      </div>
      <TextArea aria-label={`Answer: ${q.label}`} rows={rows} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write your answer" />
      <div className="flex items-center justify-between gap-2 text-[11.5px] text-muted">
        <span>{slot && <span className="text-warn">Replace the [bracketed] part with your own words before using this.</span>}</span>
        <span className={cx('tabular-nums', over && 'text-bad')}>
          {text.length}
          {q.maxLength ? ` / ${q.maxLength}` : ''}
        </span>
      </div>
      {draft.note && <p className="text-[12px] text-muted">{draft.note}</p>}
      {draft.missingSkills.length > 0 && draft.text && <p className="text-[12px] text-warn">Not on your résumé: {draft.missingSkills.join(', ')}. The draft doesn’t claim them.</p>}
      {flags.length > 0 && (
        <Alert tone="warn" title="Check before using">
          <p>The AI added a {flags.join(', ')} that isn’t in your profile. Edit it out unless it’s true.</p>
          <div className="mt-1">
            <Checkbox label="I checked it, this is true" checked={approved} onChange={setApproved} />
          </div>
        </Alert>
      )}
      {improve.error && <Alert tone="bad">{improve.error}</Alert>}
      {draft.evidence.length > 0 && (
        <details className="text-[12px]">
          <summary className="cursor-pointer text-muted select-none">Based on {draft.evidence.length} line{draft.evidence.length === 1 ? '' : 's'} from your résumé</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {draft.evidence.map((e, i) => (
              <li key={i} className="rounded-md bg-subtle px-2 py-1">
                <span className="font-medium">{e.source}:</span> {e.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="primary" disabled={!canUse || busy} onClick={() => void onUse(text.trim(), remember)}>
          Use this answer
        </Button>
        {aiOn && (
          <Button size="sm" icon={<Icon.Spark size={14} />} busy={improve.busy} onClick={() => void improve.run()}>
            Improve with AI
          </Button>
        )}
        {draft.text && text !== draft.text && (
          <Button size="sm" variant="ghost" onClick={() => setText(draft.text)}>
            Reset
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onSkip}>
          I’ll answer on the page
        </Button>
      </div>
      <Checkbox label="Remember this answer for this exact question" checked={remember} onChange={setRemember} />
    </article>
  );
}

function ChoiceQuestion({ q, busy, onUse }: { q: Unanswered; busy: boolean; onUse: (value: string, remember: boolean) => Promise<unknown> }) {
  const options = (q.options ?? []).filter((o) => o.trim() && !/^(select|choose|please select)\b/i.test(o.trim()));
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface p-3" aria-label={q.section ? `${q.label} (${q.section})` : q.label}>
      <p className="text-[13px] font-medium">
        {q.label}
        {q.required && <span className="text-bad"> *</span>}
        {q.section && <span className="block text-[11.5px] font-normal text-muted">In “{q.section}”</span>}
      </p>
      <div className="flex gap-2">
        {options.length ? (
          <Select aria-label={`Answer: ${q.label}`} value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose…</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        ) : (
          <Input aria-label={`Answer: ${q.label}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Type the option’s wording" />
        )}
        <Button size="sm" disabled={!value.trim() || busy} onClick={() => void onUse(value.trim(), remember)}>
          Fill in
        </Button>
      </div>
      <Checkbox label="Remember for next time" checked={remember} onChange={setRemember} />
    </article>
  );
}

/** "I submitted it": records Applied only after the user says so. */
function MarkAppliedDialog({ open, onClose, job, findJob }: { open: boolean; onClose: () => void; job: ExtractedJob | JobRecord | null; findJob: () => Promise<JobRecord | undefined> }) {
  const toast = useToast();
  const mark = useAction(async () => {
    let record = (job && 'id' in job ? job : undefined) ?? (await findJob());
    if (!record && job) record = (await upsertJob(job, 'page', { saved: true, savedAt: nowIso() })).job;
    if (!record) throw new Error('No job to record this against. Analyze the job posting (Job tab) or add it in Tracker first.');
    if (!record.saved) await setJobSaved(record.id, true);
    const app = await ensureApplication(record.id, 'saved');
    await setApplicationStatus(app.id, 'applied', { confirmedSubmission: true });
    toast(`Marked ${record.title || 'the job'} as Applied`, 'good');
    onClose();
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Did you submit the application?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not yet
          </Button>
          <Button variant="primary" busy={mark.busy} onClick={() => void mark.run()}>
            Yes, I submitted it
          </Button>
        </>
      }
    >
      <p className="text-[13px]">Only confirm once you’ve pressed Submit on the page and seen it go through. {job ? `This records ${job.title || 'the job'}${job.company ? ` at ${job.company}` : ''} as Applied, with today’s date, in your tracker.` : ''}</p>
      {mark.error && (
        <div className="mt-2">
          <Alert tone="bad">{mark.error}</Alert>
        </div>
      )}
    </Dialog>
  );
}

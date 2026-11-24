import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { FailedField, FillReport, FillRequest, Unanswered } from '../lib/autofill/fill';
import { answerInTab, autofillTab, buildAnswers, fillHistory, fillLists, fillValues, inferredKeys, jobForUrl, NoAccessError, profileFillValues, resolveResume, resumeChoices, revealInTab, type ResumeChoice } from '../lib/autofill/run';
import { findDuplicate } from '../lib/jobs';
import { profileIsEmpty } from '../lib/matching/service';
import { getResumeFile, logAutofill, updateSettings } from '../lib/storage/repo';
import { SESSION_KEYS } from '../lib/storage/schema';
import { AUTOFILL_KEYS, type AutofillKey, type AutofillSettings, type JobRecord } from '../lib/types';
import { uid } from '../lib/util';
import { Alert, Badge, Button, Checkbox, CommitInput, Field, Input, Select } from './components';
import { useAction, useCoverLetters, useJobs, useProfile, useResumes, useSettings, useTabDetection } from './hooks';
import { Icon } from './icons';
import { hostOf } from './panel/shared';
import { PermissionButton } from './permission';

const LABELS: Record<AutofillKey, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
  address: 'Street address',
  city: 'City',
  state: 'Province / state',
  postalCode: 'Postal / ZIP code',
  country: 'Country',
  linkedin: 'LinkedIn URL',
  github: 'GitHub URL',
  website: 'Website / portfolio',
  currentTitle: 'Current title',
  currentCompany: 'Current company',
  school: 'School',
  degree: 'Degree',
  discipline: 'Field of study',
};

/** Set by the toolbar shortcut and the right-click menu: "autofill this tab" (they also grant page access). */
export interface AutofillRequest {
  tabId: number;
  at: number;
}
const REQUEST_TTL_MS = 30_000;

/** Anything in the report the user can answer or look at: a question, or a field that couldn't be filled. */
export type Answerable = Pick<Unanswered, 'id' | 'label' | 'frameId'>;
const keyOf = (q: Answerable) => q.id ?? q.label;

/** The last report for a tab, kept in session storage so it survives the panel being closed and reopened. */
function useTabReport(tabId: number | null | undefined): FillReport | null {
  const [report, setReport] = useState<FillReport | null>(null);
  useEffect(() => {
    if (!tabId) return;
    const key = SESSION_KEYS.autofill(tabId);
    let alive = true;
    void browser.storage.session.get(key).then((v) => alive && setReport((v[key] as FillReport | undefined) ?? null));
    const onChange = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === 'session' && key in changes) setReport((changes[key]!.newValue as FillReport | undefined) ?? null);
    };
    browser.storage.onChanged.addListener(onChange);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChange);
    };
  }, [tabId]);
  return report;
}

const saveReport = (tabId: number, r: FillReport | null) => {
  const key = SESSION_KEYS.autofill(tabId);
  return r ? browser.storage.session.set({ [key]: r }) : browser.storage.session.remove(key);
};

/** The résumé files and versions autofill can attach. */
export function useResumeChoices(): ResumeChoice[] | null {
  const resumes = useResumes();
  const [withFiles, setWithFiles] = useState<Set<string> | null>(null);
  const ids = (resumes ?? []).filter((r) => r.kind === 'original').map((r) => r.id);
  useEffect(() => {
    let alive = true;
    void Promise.all(ids.map(async (id) => ((await getResumeFile(id)) ? id : null))).then((x) => alive && setWithFiles(new Set(x.filter((v): v is string => !!v))));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);
  return resumes && withFiles ? resumeChoices(resumes, withFiles) : null;
}

export function useAutofill(tabId: number | null | undefined, opts: { jobId?: string | null; context?: { title: string; company: string } | null } = {}) {
  const profile = useProfile();
  const settings = useSettings();
  const resumes = useResumes();
  const jobs = useJobs();
  const letters = useCoverLetters();
  const detection = useTabDetection(tabId);
  const report = useTabReport(tabId);
  const setReport = (r: FillReport | null) => {
    if (tabId) void saveReport(tabId, r);
  };
  const ready = !!(profile && settings && resumes && jobs);

  /** The saved job this page belongs to, if any (for its cover letter). */
  const findJob = async (): Promise<JobRecord | undefined> => {
    if (!tabId || !jobs) return undefined;
    if (opts.jobId) {
      const chosen = jobs.find((j) => j.id === opts.jobId);
      if (chosen) return chosen;
    }
    if (detection?.outcome.status === 'ok') {
      const dup = findDuplicate(detection.outcome.job, jobs);
      if (dup) return dup.job;
    }
    return jobForUrl((await browser.tabs.get(tabId)).url, jobs);
  };

  /** Fills the application in the tab. `attach` overrides the saved résumé choice for this run only. */
  const fill = useAction(async (forTab?: number, attach?: string) => {
    const id = forTab ?? tabId;
    if (!id) throw new Error('No active tab.');
    if (!profile || !settings || !resumes || !jobs) throw new Error('Still loading, try again in a moment.');
    if (profileIsEmpty(profile)) throw new Error('Upload your résumé first (below).');
    const s = settings.autofill;
    const choice = attach ?? s.attach;
    const job = await findJob();
    const [resume, answers] = await Promise.all([resolveResume(choice, profile, resumes), buildAnswers(s, job ? letters?.[job.id] : undefined, profile.basics.name)]);
    const req: FillRequest = {
      data: fillValues(profile, s),
      history: fillHistory(profile),
      lists: fillLists(profile),
      inferred: inferredKeys(profile, s),
      resume,
      resumeMode: choice === 'none' ? 'off' : 'file',
      overwrite: s.overwrite,
      answers,
      advance: s.advance,
    };
    let r: FillReport;
    try {
      r = await autofillTab(id, req);
    } catch (err) {
      // Opening the popup (toolbar icon) grants access; it offers to continue (see entrypoints/popup).
      if (err instanceof NoAccessError) await browser.storage.session.set({ [SESSION_KEYS.autofillNeedsAccess]: { tabId: id, at: Date.now() } });
      throw err;
    }
    const endTab = r.tabId ?? id;
    // The form moved to a page Job Copilot may not open yet: the popup there offers "Continue autofill".
    if (r.stop === 'needs_access') await browser.storage.session.set({ [SESSION_KEYS.autofillNeedsAccess]: { tabId: endTab, at: Date.now() } });
    else await browser.storage.session.remove(SESSION_KEYS.autofillNeedsAccess);
    const stored = { ...r, jobId: job?.id ?? report?.jobId };
    await saveReport(endTab, stored);
    if (endTab !== id) await saveReport(id, stored);
    // Local activity log: where and how much, never what was typed.
    await logAutofill({
      at: new Date().toISOString(),
      host: hostOf(r.url),
      jobTitle: job?.title ?? opts.context?.title ?? '',
      company: job?.company ?? opts.context?.company ?? '',
      filled: r.filled.length,
      stop: r.stop,
    }).catch(() => undefined);
    return r;
  });

  const answer = useAction(async (q: Answerable, value: string, remember: boolean) => {
    if (!tabId) throw new Error('No active tab.');
    const out = await answerInTab(tabId, keyOf(q), value, q.frameId);
    if (remember)
      await updateSettings((x) => ({
        ...x,
        autofill: { ...x.autofill, savedAnswers: [...x.autofill.savedAnswers.filter((a) => a.question !== q.label), { id: uid('ans'), question: q.label, answer: value }] },
      }));
    if (!out.ok) {
      const choices = out.options?.length ? ` Choices on the page: ${out.options.slice(0, 8).join(', ')}${out.options.length > 8 ? '…' : ''}.` : '';
      throw new Error(`“${value}” couldn’t be filled into “${q.label}”: ${out.message}${choices}`);
    }
    if (report) {
      const k = keyOf(q);
      setReport({
        ...report,
        unanswered: report.unanswered.filter((u) => keyOf(u) !== k),
        failed: (report.failed ?? []).filter((u) => keyOf(u) !== k),
        unverified: (report.unverified ?? []).filter((u) => keyOf(u) !== k),
        filled: [...report.filled, { label: q.label, key: 'saved', id: q.id, basis: 'explicit' }],
      });
    }
    return true;
  });

  /** Clears a question from the list without filling it (the user will answer on the page). */
  const skip = (q: Answerable) => {
    if (!report) return;
    const k = keyOf(q);
    setReport({ ...report, unanswered: report.unanswered.filter((u) => keyOf(u) !== k), failed: (report.failed ?? []).filter((u) => keyOf(u) !== k) });
  };

  /** Scrolls the page to the field and outlines it. */
  const reveal = (q: Answerable) => {
    if (tabId) void revealInTab(tabId, keyOf(q), q.frameId);
  };

  return { fill, answer, skip, reveal, report, ready, findJob, attach: settings?.autofill.attach ?? 'auto' };
}

const STOP_TEXT: Record<FillReport['stop'], (r: FillReport) => string> = {
  submit_ready: (r) => `Done. Check the page (filled fields are outlined in green), then press “${r.submitLabel ?? 'Submit'}” yourself. It’s outlined in blue.`,
  needs_answers: () => 'Paused: the questions below need your answer. Answer them here or on the page, then press Autofill again.',
  errors: () => 'Paused: the form didn’t move on or shows errors. Fix what the page points out, then press Autofill again.',
  captcha: () => 'Paused at a CAPTCHA. Complete it on the page yourself, then press Autofill again.',
  login: () => 'This site wants you to sign in or create an account first. Do that, then press Autofill again.',
  navigating: () => 'The application form is still loading. Press Autofill again once it’s open.',
  needs_access: (r) =>
    `The application continues on ${r.needsAccess?.host ?? 'another site'}, which Job Copilot can’t open yet. Allow it below, or click the Job Copilot icon in the toolbar on that page and press “Continue autofill”.`,
  max_steps: () => 'Stopped after many steps to be safe. Press Autofill again to keep going.',
  done: () => 'Filled what was on this page. No Next or Submit button was found.',
  no_form: () => 'No application form was found on this page. Open the job’s application form, then press Autofill.',
};

function resumeLine(report: FillReport, attach: string): { text: string; tone: 'good' | 'warn' | 'muted' } | null {
  const r = report.resume;
  if (!r) {
    // Reports saved by older builds.
    const attached = report.filled.some((f) => f.key === 'resume');
    return attach !== 'none' && report.resumeInputFound && !attached ? { text: 'The résumé wasn’t attached (the field already has a file or doesn’t accept it).', tone: 'muted' } : null;
  }
  switch (r.status) {
    case 'attached':
      return { text: `Résumé attached: ${r.file}. The page confirmed it holds the file.`, tone: 'good' };
    case 'already':
      return { text: `The résumé field already had a file (${r.file}); it was kept.`, tone: 'muted' };
    case 'rejected':
      return { text: `The résumé wasn’t attached: ${r.reason} Attach it on the page yourself.`, tone: 'warn' };
    case 'not_accepted':
      return { text: `The résumé wasn’t attached: ${r.reason} Attach a matching file yourself.`, tone: 'warn' };
    case 'off':
      return { text: 'Attaching a résumé is off for this run.', tone: 'muted' };
    case 'no_file':
      return { text: 'The form asks for a résumé, but there’s no file to attach. Upload one in Profile, or attach it on the page.', tone: 'warn' };
    case 'not_found':
      return attach !== 'none' ? { text: 'No résumé upload was found on this step.', tone: 'muted' } : null;
  }
}

export function FillResult({ report, attach }: { report: FillReport; attach: string }) {
  const fields = report.filled.filter((f) => f.key !== 'resume' && f.key !== 'coverLetter');
  const resume = report.filled.find((f) => f.key === 'resume');
  const letter = report.filled.find((f) => f.key === 'coverLetter');
  const inferred = fields.filter((f) => f.basis === 'inferred');
  const failed = (report.failed?.length ?? 0) + (report.unverified?.length ?? 0);
  const tone = report.stop === 'submit_ready' ? 'text-good' : report.stop === 'done' ? '' : 'text-warn';
  const r = resumeLine(report, attach);
  return (
    <div role="status" className="flex flex-col gap-1 rounded-md border border-line bg-subtle p-2.5 text-[12.5px]">
      <p className="font-medium">
        {report.filled.length ? `Filled ${fields.length} field${fields.length === 1 ? '' : 's'}` : 'Nothing new was filled'}
        {resume ? ', attached your résumé' : ''}
        {letter ? ', added your cover letter' : ''}
        {report.steps ? ` across ${report.steps + 1} steps` : ''}.
      </p>
      {(failed > 0 || report.unanswered.length > 0 || (report.skipped?.length ?? 0) > 0) && (
        <p className="flex flex-wrap gap-1" aria-label="Summary">
          <Badge tone="good">{fields.length} filled and checked</Badge>
          {report.unanswered.length > 0 && <Badge tone="warn">{report.unanswered.length} need you</Badge>}
          {failed > 0 && <Badge tone="bad">{failed} couldn’t be filled</Badge>}
          {(report.skipped?.length ?? 0) > 0 && <Badge>{report.skipped!.length} left alone</Badge>}
        </p>
      )}
      <p className={tone}>{STOP_TEXT[report.stop](report)}</p>
      {report.errors.length > 0 && (
        <ul className="list-disc pl-4 text-bad">
          {report.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {r && <p className={r.tone === 'good' ? 'text-good' : r.tone === 'warn' ? 'text-warn' : 'text-muted'}>{r.text}</p>}
      {inferred.length > 0 && (
        <p className="text-muted">
          Worked out from your profile, check these: {inferred.map((f) => f.label).join(', ')}.
        </p>
      )}
      {report.noValue.length > 0 && <p className="text-muted">Not in your résumé: {report.noValue.join(', ')}.</p>}
      {(report.skipped?.length ?? 0) > 0 && <p className="text-muted">Left for you on purpose: {report.skipped!.map((s) => s.label).join(', ')}.</p>}
      {report.moreSteps && <p className="text-muted">There are more steps after this one. Press Next on the page, then Autofill again (or turn on stepping through in Settings).</p>}
      {report.newTab?.accessible && <p className="text-muted">The application opened in a new tab; Autofill continued there.</p>}
      {report.stop === 'submit_ready' && <p className="text-muted">Nothing has been submitted yet.</p>}
      <AccessNotices report={report} />
    </div>
  );
}

/** Frames and pages Job Copilot couldn't reach: reported, with a way to allow access (never bypassed). */
function AccessNotices({ report }: { report: FillReport }) {
  const blocked = report.frames?.inaccessible ?? [];
  const need = report.needsAccess;
  if (!blocked.length && !need) return null;
  const origins = [...new Set([...(need?.origin ? [need.origin] : []), ...blocked.map((b) => new URL(b.url).origin)])].filter((o) => /^https:\/\//.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)/.test(o));
  return (
    <div className="mt-1">
      <Alert tone="warn" role="note" title={need ? `Needs access to ${need.host}` : 'Part of this page wasn’t filled'}>
        {blocked.length > 0 && (
          <p>
            The form inside {blocked.map((b) => b.host).join(', ')} is from another site. Chrome only lets Job Copilot into it with your permission, so nothing there was filled or checked.
          </p>
        )}
        {need && !blocked.length && <p>Chrome only lets Job Copilot into {need.host} with your permission.</p>}
        {origins.length > 0 && (
          <div className="mt-1.5">
            <PermissionButton origins={origins.map((o) => `${o}/*`)} label={`Allow access to ${origins.map((o) => new URL(o).hostname).join(', ')}`} variant="secondary" />
            <p className="mt-1 text-[11.5px] text-muted">Then press Autofill again.</p>
          </div>
        )}
      </Alert>
    </div>
  );
}

/** Fields Job Copilot tried and couldn't fill, or that the page changed back: with the reason and a way to answer. */
export function FailedList({ report, busy, onAnswer, onReveal, onSkip }: { report: FillReport; busy: boolean; onAnswer: (q: FailedField, value: string, remember: boolean) => Promise<unknown>; onReveal: (q: FailedField) => void; onSkip: (q: FailedField) => void }) {
  const items = [...(report.failed ?? []), ...(report.unverified ?? [])];
  if (!items.length) return null;
  return (
    <section aria-label="Couldn’t fill" className="flex flex-col gap-2">
      <h2 className="text-[11.5px] font-semibold tracking-wide text-muted uppercase">Couldn’t fill ({items.length})</h2>
      <p className="text-[12px] text-muted">These are outlined in red on the page. Nothing here was counted as filled.</p>
      {items.map((f) => (
        <FailedRow key={keyOf(f)} item={f} busy={busy} onAnswer={(v, remember) => onAnswer(f, v, remember)} onReveal={() => onReveal(f)} onSkip={() => onSkip(f)} />
      ))}
    </section>
  );
}

function FailedRow({ item, busy, onAnswer, onReveal, onSkip }: { item: FailedField; busy: boolean; onAnswer: (v: string, remember: boolean) => Promise<unknown>; onReveal: () => void; onSkip: () => void }) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(false);
  const options = (item.options ?? []).filter((o) => o.trim());
  const file = item.kind === 'file';
  return (
    <article className="flex flex-col gap-1.5 rounded-lg border border-bad/30 bg-surface p-3" aria-label={item.label}>
      <p className="text-[13px] font-medium">
        {item.label}
        {item.required && <span className="text-bad"> *</span>}
      </p>
      <p className="text-[12px] text-bad">{item.reason}</p>
      {!file && (
        <div className="flex gap-2">
          {options.length ? (
            <Select aria-label={`Answer: ${item.label}`} value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          ) : (
            <Input aria-label={`Answer: ${item.label}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Type the answer to use" />
          )}
          <Button size="sm" disabled={!value.trim() || busy} onClick={() => void onAnswer(value.trim(), remember)}>
            Fill in
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<Icon.Search size={13} />} onClick={onReveal}>
          Show on page
        </Button>
        <Button size="sm" variant="ghost" onClick={onSkip}>
          I’ll fix it on the page
        </Button>
        {!file && <Checkbox label="Remember this answer" checked={remember} onChange={setRemember} />}
      </div>
    </article>
  );
}

function AnswerRow({ label, required, onAnswer, busy }: { label: string; required: boolean; onAnswer: (value: string, remember: boolean) => Promise<unknown>; busy: boolean }) {
  const [value, setValue] = useState('');
  const [remember, setRemember] = useState(true);
  return (
    <li className="flex flex-col gap-1.5 border-b border-line py-2 last:border-b-0">
      <p className="text-[12.5px] font-medium">
        {label}
        {required && <span className="text-bad"> *</span>}
      </p>
      <div className="flex gap-2">
        <Input aria-label={`Answer: ${label}`} value={value} onChange={(e) => setValue(e.target.value)} placeholder="Your answer, or the option to choose" />
        <Button size="sm" disabled={!value.trim() || busy} onClick={() => void onAnswer(value.trim(), remember)}>
          Fill in
        </Button>
      </div>
      <Checkbox label="Remember for next time" checked={remember} onChange={setRemember} />
    </li>
  );
}

/** Lets the user correct what goes into forms (e.g. how the name splits into first / last). */
export function ValuesEditor({ settings }: { settings: AutofillSettings }) {
  const profile = useProfile();
  const base = useMemo(() => (profile ? profileFillValues(profile) : null), [profile]);
  if (!base) return null;
  const commit = (k: AutofillKey, v: string) =>
    void updateSettings((s) => {
      const overrides = { ...s.autofill.overrides };
      if (!v.trim() || v.trim() === base[k]) delete overrides[k];
      else overrides[k] = v.trim();
      return { ...s, autofill: { ...s.autofill, overrides } };
    });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted">Grey text comes from your résumé (province, country and the name split are worked out from it). Type to use something else in forms. Clear a field to go back to the résumé value.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {AUTOFILL_KEYS.map((k) => (
          <Field key={k} label={LABELS[k]}>
            {(id) => <CommitInput id={id} value={settings.overrides[k] ?? ''} placeholder={base[k] || (k === 'address' ? 'Not used unless you type it' : 'Not in your résumé')} onCommit={(v) => commit(k, v)} />}
          </Field>
        ))}
      </div>
    </div>
  );
}

/** The dashboard's autofill action: fill the application in the current tab. */
export function AutofillSection({ tabId, request }: { tabId: number | null | undefined; request: AutofillRequest | null | undefined }) {
  const auto = useAutofill(tabId);
  const report = auto.report;

  // The toolbar shortcut / right-click menu asked to autofill this tab: do it once, as soon as data is loaded.
  useEffect(() => {
    if (!request || !auto.ready || auto.fill.busy) return;
    void browser.storage.session.remove(SESSION_KEYS.autofillRequest);
    if (Date.now() - request.at > REQUEST_TTL_MS) return;
    void auto.fill.run(request.tabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, auto.ready]);

  return (
    <section aria-label="Autofill" className="flex flex-col gap-2.5">
      <Button variant="primary" className="h-11! w-full text-[15px]!" icon={<Icon.Form size={18} />} busy={auto.fill.busy} disabled={!tabId} onClick={() => void auto.fill.run()}>
        Autofill
      </Button>
      {!report && !auto.fill.error && !auto.fill.busy && (
        <p className="text-center text-[12px] text-muted">Open a job application, then press Autofill. It fills every step and stops before the final submit.</p>
      )}
      {auto.fill.error && <Alert tone="bad">{auto.fill.error}</Alert>}
      {report && <FillResult report={report} attach={auto.attach} />}
      {report && <FailedList report={report} busy={auto.answer.busy} onAnswer={(q, v, r) => auto.answer.run(q, v, r)} onReveal={auto.reveal} onSkip={auto.skip} />}
      {report && report.unanswered.length > 0 && (
        <div className="rounded-md border border-line bg-surface px-2.5 py-1.5">
          <p className="pt-1 text-[12.5px] font-semibold">Questions for you</p>
          <p className="text-[12px] text-muted">Autofill only answers with what you tell it. For a choice, type the option’s wording (for example “Yes”).</p>
          {auto.answer.error && (
            <div className="mt-1.5">
              <Alert tone="bad">{auto.answer.error}</Alert>
            </div>
          )}
          <ul>
            {[...report.unanswered]
              .sort((a, b) => Number(b.required) - Number(a.required))
              .map((u) => (
                <AnswerRow key={keyOf(u)} label={u.label} required={u.required} busy={auto.answer.busy} onAnswer={(v, remember) => auto.answer.run(u, v, remember)} />
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

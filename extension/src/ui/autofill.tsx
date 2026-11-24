import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { FillReport } from '../lib/autofill/fill';
import { answerInTab, autofillTab, buildAnswers, fillHistory, fillValues, jobForUrl, NoAccessError, profileFillValues, resolveResume } from '../lib/autofill/run';
import { findDuplicate } from '../lib/jobs';
import { profileIsEmpty } from '../lib/matching/service';
import { logAutofill, updateSettings } from '../lib/storage/repo';
import { SESSION_KEYS } from '../lib/storage/schema';
import { AUTOFILL_KEYS, type AutofillKey, type AutofillSettings, type JobRecord } from '../lib/types';
import { uid } from '../lib/util';
import { Alert, Button, Checkbox, CommitInput, Field, Input } from './components';
import { useAction, useCoverLetters, useJobs, useProfile, useResumes, useSettings, useTabDetection } from './hooks';
import { Icon } from './icons';
import { hostOf } from './panel/shared';

const LABELS: Record<AutofillKey, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email',
  phone: 'Phone',
  location: 'Location',
  city: 'City',
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

export function useAutofill(tabId: number | null | undefined, opts: { jobId?: string | null; context?: { title: string; company: string } | null } = {}) {
  const profile = useProfile();
  const settings = useSettings();
  const resumes = useResumes();
  const jobs = useJobs();
  const letters = useCoverLetters();
  const detection = useTabDetection(tabId);
  const report = useTabReport(tabId);
  const setReport = (r: FillReport | null) => {
    if (!tabId) return;
    const key = SESSION_KEYS.autofill(tabId);
    void (r ? browser.storage.session.set({ [key]: r }) : browser.storage.session.remove(key));
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

  const fill = useAction(async (forTab?: number) => {
    const id = forTab ?? tabId;
    if (!id) throw new Error('No active tab.');
    if (!profile || !settings || !resumes || !jobs) throw new Error('Still loading, try again in a moment.');
    if (profileIsEmpty(profile)) throw new Error('Upload your résumé first (below).');
    const s = settings.autofill;
    const job = await findJob();
    const [resume, answers] = await Promise.all([resolveResume(s.attach, profile, resumes), buildAnswers(s, job ? letters?.[job.id] : undefined, profile.basics.name)]);
    let r: FillReport;
    try {
      r = await autofillTab(id, { data: fillValues(profile, s), history: fillHistory(profile), resume, overwrite: s.overwrite, answers, advance: s.advance });
    } catch (err) {
      // Opening the popup (toolbar icon) grants access; it offers to continue (see entrypoints/popup).
      if (err instanceof NoAccessError) await browser.storage.session.set({ [SESSION_KEYS.autofillNeedsAccess]: { tabId: id, at: Date.now() } });
      throw err;
    }
    await browser.storage.session.remove(SESSION_KEYS.autofillNeedsAccess);
    setReport({ ...r, jobId: job?.id ?? report?.jobId });
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

  const answer = useAction(async (label: string, value: string, remember: boolean) => {
    if (!tabId) throw new Error('No active tab.');
    const ok = await answerInTab(tabId, label, value);
    if (remember)
      await updateSettings((x) => ({
        ...x,
        autofill: { ...x.autofill, savedAnswers: [...x.autofill.savedAnswers.filter((a) => a.question !== label), { id: uid('ans'), question: label, answer: value }] },
      }));
    if (!ok) throw new Error(`“${value}” didn’t match any choice for “${label}”. Use the wording of one of the options.`);
    if (report) setReport({ ...report, unanswered: report.unanswered.filter((u) => u.label !== label), filled: [...report.filled, { label, key: 'saved' }] });
    return ok;
  });

  /** Clears a question from the list without filling it (the user will answer on the page). */
  const skip = (label: string) => {
    if (report) setReport({ ...report, unanswered: report.unanswered.filter((u) => u.label !== label) });
  };

  return { fill, answer, skip, report, ready, findJob, attach: settings?.autofill.attach ?? 'auto' };
}

const STOP_TEXT: Record<FillReport['stop'], (r: FillReport) => string> = {
  submit_ready: (r) => `Done. Check the page (filled fields are outlined in green), then press “${r.submitLabel ?? 'Submit'}” yourself. It’s outlined in blue.`,
  needs_answers: () => 'Paused: the questions below need your answer. Answer them here or on the page, then press Autofill again.',
  errors: () => 'Paused: the form didn’t move to the next step. Fix what the page points out, then press Autofill again.',
  captcha: () => 'Paused at a CAPTCHA. Complete it on the page yourself, then press Autofill again.',
  login: () => 'This site wants you to sign in or create an account first. Do that, then press Autofill again.',
  navigating: () => 'The application form is still loading. Press Autofill again once it’s open.',
  max_steps: () => 'Stopped after many steps to be safe. Press Autofill again to keep going.',
  done: () => 'Filled what was on this page. No Next or Submit button was found.',
  no_form: () => 'No application form was found on this page. Open the job’s application form, then press Autofill.',
};

export function FillResult({ report, attach }: { report: FillReport; attach: string }) {
  const fields = report.filled.filter((f) => f.key !== 'resume' && f.key !== 'coverLetter');
  const resume = report.filled.find((f) => f.key === 'resume');
  const letter = report.filled.find((f) => f.key === 'coverLetter');
  const tone = report.stop === 'submit_ready' ? 'text-good' : report.stop === 'done' ? '' : 'text-warn';
  return (
    <div role="status" className="flex flex-col gap-1 rounded-md border border-line bg-subtle p-2.5 text-[12.5px]">
      <p className="font-medium">
        {report.filled.length ? `Filled ${fields.length} field${fields.length === 1 ? '' : 's'}` : 'Nothing new was filled'}
        {resume ? ', attached your résumé' : ''}
        {letter ? ', added your cover letter' : ''}
        {report.steps ? ` across ${report.steps + 1} steps` : ''}.
      </p>
      <p className={tone}>{STOP_TEXT[report.stop](report)}</p>
      {report.errors.length > 0 && (
        <ul className="list-disc pl-4 text-bad">
          {report.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {report.noValue.length > 0 && <p className="text-muted">Not in your résumé: {report.noValue.join(', ')}.</p>}
      {attach !== 'none' && report.resumeInputFound && !resume && <p className="text-muted">The résumé wasn’t attached (the field already has a file or doesn’t accept it).</p>}
      {report.stop === 'submit_ready' && <p className="text-muted">Nothing has been submitted yet.</p>}
    </div>
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
      <p className="text-[12px] text-muted">Grey text comes from your résumé. Type to use something else in forms. Clear a field to go back to the résumé value.</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {AUTOFILL_KEYS.map((k) => (
          <Field key={k} label={LABELS[k]}>
            {(id) => <CommitInput id={id} value={settings.overrides[k] ?? ''} placeholder={base[k] || 'Not in your résumé'} onCommit={(v) => commit(k, v)} />}
          </Field>
        ))}
      </div>
    </div>
  );
}

/** The panel's one action: fill the application in the current tab. */
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
                <AnswerRow key={u.label} label={u.label} required={u.required} busy={auto.answer.busy} onAnswer={(v, remember) => auto.answer.run(u.label, v, remember)} />
              ))}
          </ul>
        </div>
      )}
    </section>
  );
}

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import { AiError, resetUsage } from '../../lib/ai/client';
import { aiTestConnection } from '../../lib/ai/features';
import { PROVIDERS } from '../../lib/ai/providers';
import { applicationsToCsv, jobsToCsv } from '../../lib/export';
import { RESTRICTED_HOSTS, SUPPORTED_SITES, toCustomSitePattern } from '../../lib/extraction/sites';
import { COMPONENT_LABELS } from '../../lib/matching/engine';
import { matchJobs } from '../../lib/matching/service';
import { send } from '../../lib/messages';
import { downloadBlob } from '../../lib/resume/export';
import { clearCaches, deleteAllData, exportAll, importBackup, listApplications, listJobs, updateSettings } from '../../lib/storage/repo';
import { pullBackup, pushBackup } from '../../lib/sync';
import { AI_FEATURES, MatchWeights, type AiFeature, type AiProviderId, type Settings, type StandardQuestion } from '../../lib/types';
import { formatRelative, originPattern, uid } from '../../lib/util';
import { Alert, Badge, Button, Card, Checkbox, CommitInput, Dialog, Field, Input, Loading, PageHeader, Select, Tabs, useToast } from '../components';
import { useAction, useAiUsage, useSettings } from '../hooks';
import { Icon } from '../icons';
import { PermissionButton, useHasPermission } from '../permission';

type Section = 'sites' | 'matching' | 'applications' | 'notifications' | 'ai' | 'data' | 'privacy';

const save = (fn: (s: Settings) => Settings) => updateSettings(fn);

export function SettingsView() {
  const settings = useSettings();
  const [section, setSection] = useState<Section>('sites');
  if (!settings) return <Loading />;
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="mb-3">
        <Tabs
          label="Settings sections"
          value={section}
          onChange={setSection}
          tabs={[
            { id: 'sites', label: 'Job sites' },
            { id: 'matching', label: 'Matching' },
            { id: 'applications', label: 'Applications' },
            { id: 'notifications', label: 'Alerts' },
            { id: 'ai', label: 'AI' },
            { id: 'data', label: 'Data' },
            { id: 'privacy', label: 'Privacy' },
          ]}
        />
      </div>
      {section === 'sites' && <SitesSection settings={settings} />}
      {section === 'matching' && <MatchingSection settings={settings} />}
      {section === 'applications' && <ApplicationsSection settings={settings} />}
      {section === 'notifications' && <NotificationsSection settings={settings} />}
      {section === 'ai' && <AiSection settings={settings} />}
      {section === 'data' && <DataSection />}
      {section === 'privacy' && <PrivacySection />}
    </div>
  );
}

const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : fallback);

/* ----------------------------------------------------------------------------
 * Job sites
 * ------------------------------------------------------------------------- */

function SiteRow({ label, origins, detail, onRemoved }: { label: string; origins: string[]; detail: ReactNode; onRemoved?: () => Promise<unknown> }) {
  const has = useHasPermission({ origins });
  return (
    <li className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label}</p>
        <p className="truncate text-[12px] text-muted">{detail}</p>
      </div>
      {has === undefined ? null : has ? (
        <>
          <Badge tone="good">Enabled</Badge>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await browser.permissions.remove({ origins });
              await onRemoved?.();
            }}
          >
            {onRemoved ? 'Remove' : 'Disable'}
          </Button>
        </>
      ) : (
        <>
          <PermissionButton origins={origins} label="Enable" variant="secondary" />
          {onRemoved && (
            <Button size="sm" variant="ghost" onClick={() => void onRemoved()}>
              Remove
            </Button>
          )}
        </>
      )}
    </li>
  );
}

function SitesSection({ settings }: { settings: Settings }) {
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  return (
    <div className="flex flex-col gap-3">
      <Card title="Automatic detection" subtitle="On enabled sites, job pages are analyzed when they load. Everywhere else, nothing runs until you click Analyze.">
        <ul className="-mx-4 border-t border-line">
          {SUPPORTED_SITES.map((s) => (
            <SiteRow key={s.id} label={s.label} origins={s.origins} detail={s.example} />
          ))}
        </ul>
      </Card>
      <Card title="Company career sites" subtitle="Add a careers site to analyze its job pages automatically with the generic extractor.">
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            const pattern = toCustomSitePattern(custom);
            if (!pattern) return setError('Enter an https:// site such as careers.example.com. Restricted job boards cannot be added.');
            // The permission prompt must be the first await inside the user gesture.
            const ok = await browser.permissions.request({ origins: [pattern] });
            if (!ok) return setError('Permission was not granted.');
            await save((s) => ({ ...s, customSites: Array.from(new Set([...s.customSites, pattern])) }));
            setCustom('');
            toast('Site added', 'good');
          }}
        >
          <Input aria-label="Career site" placeholder="careers.example.com" value={custom} onChange={(e) => setCustom(e.target.value)} />
          <Button type="submit" variant="primary">
            Add
          </Button>
        </form>
        {error && (
          <div className="mt-2">
            <Alert tone="bad">{error}</Alert>
          </div>
        )}
        {settings.customSites.length > 0 && (
          <ul className="-mx-4 -mb-4 mt-3 border-t border-line">
            {settings.customSites.map((o) => (
              <SiteRow key={o} label={o.replace('https://', '').replace('/*', '')} origins={[o]} detail="Generic extractor" onRemoved={() => save((s) => ({ ...s, customSites: s.customSites.filter((x) => x !== o) }))} />
            ))}
          </ul>
        )}
      </Card>
      <Card title="On-page button">
        <Checkbox label="Show a small match button on detected job pages" hint="Detection still runs when this is off; results appear in the toolbar badge and side panel." checked={settings.showOnPageButton} onChange={(v) => void save((s) => ({ ...s, showOnPageButton: v }))} />
      </Card>
      <Alert tone="neutral" title="Not supported for automatic reading">
        {RESTRICTED_HOSTS.map((r) => r.label).join(', ')} prohibit automated extraction by add-ons in their terms. On those sites, select the job description, right-click and choose “Send selected text to Job Copilot”, or paste it in the Current Job view.
      </Alert>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Matching
 * ------------------------------------------------------------------------- */

function MatchingSection({ settings }: { settings: Settings }) {
  const defaults = MatchWeights.parse({});
  const keys = Object.keys(defaults) as Array<keyof typeof defaults>;
  const total = keys.reduce((a, k) => a + settings.weights[k], 0) || 1;
  return (
    <div className="flex flex-col gap-3">
      <Card title="Score weights" subtitle="Relative importance of each part of the score (0–10). Parts that don't apply to a job are left out and the rest are rescaled.">
        <div className="flex flex-col gap-2">
          {keys.map((k) => (
            <div key={k} className="flex items-center gap-3">
              <label htmlFor={`w-${k}`} className="flex-1 text-[13px]">
                {COMPONENT_LABELS[k]}
              </label>
              <span className="w-12 text-right text-[12px] text-muted tabular-nums">{Math.round((settings.weights[k] / total) * 100)}%</span>
              <div className="w-20">
                <CommitInput id={`w-${k}`} type="number" min={0} max={10} step={0.5} value={settings.weights[k]} onCommit={(v) => void save((s) => ({ ...s, weights: { ...s.weights, [k]: Math.min(10, Math.max(0, num(v, defaults[k]))) } }))} />
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="Score cap with a hard deal-breaker" hint="Sponsorship, work arrangement, salary or excluded keyword conflicts.">
            {(id, d) => <CommitInput id={id} aria-describedby={d} type="number" min={0} max={100} value={settings.dealBreakerCap} onCommit={(v) => void save((s) => ({ ...s, dealBreakerCap: Math.min(100, Math.max(0, num(v, 40))) }))} />}
          </Field>
          <Field label="Mark jobs stale after (days)" hint="Since the posting was last seen or verified.">
            {(id, d) => <CommitInput id={id} aria-describedby={d} type="number" min={1} value={settings.staleAfterDays} onCommit={(v) => void save((s) => ({ ...s, staleAfterDays: Math.max(1, Math.round(num(v, 21))) }))} />}
          </Field>
        </div>
        <div className="mt-3">
          <Button size="sm" variant="ghost" onClick={() => void save((s) => ({ ...s, weights: defaults, dealBreakerCap: 40, staleAfterDays: 21 }))}>
            Reset to defaults
          </Button>
        </div>
      </Card>
      <p className="text-[12px] text-muted">The score measures how well your profile covers what a posting asks for. It is not a prediction of whether you'll be hired.</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Notifications
 * ------------------------------------------------------------------------- */

/* ----------------------------------------------------------------------------
 * Application answers (autofill)
 * ------------------------------------------------------------------------- */

const STANDARD_FIELDS: Array<{ key: StandardQuestion; label: string; hint: string }> = [
  { key: 'workAuthorized', label: 'Are you legally authorized to work? (used for every country)', hint: 'Leave empty if it differs by country' },
  { key: 'sponsorship', label: 'Will you now or in the future require sponsorship?', hint: 'e.g. No' },
  { key: 'relocate', label: 'Are you willing to relocate?', hint: 'e.g. Yes' },
  { key: 'over18', label: 'Are you 18 or older?', hint: 'e.g. Yes' },
  { key: 'salary', label: 'Salary expectations', hint: 'e.g. $70,000–$80,000 CAD' },
  { key: 'startDate', label: 'Earliest start date / notice period', hint: 'e.g. Two weeks after an offer' },
  { key: 'yearsExperience', label: 'Years of professional experience', hint: 'e.g. 1' },
  { key: 'hearAbout', label: 'How did you hear about us?', hint: 'e.g. Company website' },
  { key: 'gender', label: 'Gender', hint: 'e.g. Decline to self-identify' },
  { key: 'race', label: 'Race / ethnicity', hint: 'e.g. Decline to self-identify' },
  { key: 'hispanic', label: 'Hispanic or Latino?', hint: 'e.g. Decline to self-identify' },
  { key: 'veteran', label: 'Veteran status', hint: 'e.g. I am not a protected veteran' },
  { key: 'disability', label: 'Disability status', hint: 'e.g. I do not wish to answer' },
  { key: 'pronouns', label: 'Pronouns', hint: 'Leave empty to skip' },
];

export function ApplicationsSection({ settings }: { settings: Settings }) {
  const a = settings.autofill;
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const setStandard = (key: StandardQuestion, v: string) =>
    void save((s) => {
      const standardAnswers = { ...s.autofill.standardAnswers };
      if (v.trim()) standardAnswers[key] = v.trim();
      else delete standardAnswers[key];
      return { ...s, autofill: { ...s.autofill, standardAnswers } };
    });
  const setSaved = (fn: (list: Settings['autofill']['savedAnswers']) => Settings['autofill']['savedAnswers']) => void save((s) => ({ ...s, autofill: { ...s.autofill, savedAnswers: fn(s.autofill.savedAnswers) } }));
  return (
    <div className="flex flex-col gap-3">
      <Alert tone="neutral">
        Autofill answers screening questions <b>only</b> with what you enter here or save from the side panel. An empty answer means the question is left for you. Answers are matched to the question’s wording, and for a choice the closest option is picked (“Yes”, “No”, “Decline to self-identify”…).
      </Alert>
      <Card title="Common questions">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {STANDARD_FIELDS.map((f) => (
            <Field key={f.key} label={f.label}>
              {(id) => <CommitInput id={id} value={a.standardAnswers[f.key] ?? ''} placeholder={f.hint} onCommit={(v) => setStandard(f.key, v)} />}
            </Field>
          ))}
        </div>
      </Card>
      <Card title="Saved answers" subtitle="Answers to other questions, matched by wording. Questions you answer in the side panel with “Remember” appear here.">
        {a.savedAnswers.length === 0 ? (
          <p className="text-[12.5px] text-muted">No saved answers yet.</p>
        ) : (
          <ul className="flex flex-col">
            {a.savedAnswers.map((s) => (
              <li key={s.id} className="flex flex-col gap-1.5 border-b border-line py-2 last:border-b-0">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 text-[12.5px] font-medium">{s.question}</p>
                  <Button size="sm" variant="ghost" icon={<Icon.Trash size={14} />} onClick={() => setSaved((list) => list.filter((x) => x.id !== s.id))}>
                    Remove
                  </Button>
                </div>
                <CommitInput aria-label={`Answer: ${s.question}`} value={s.answer} onCommit={(v) => setSaved((list) => list.map((x) => (x.id === s.id ? { ...x, answer: v } : x)))} />
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
          <Field label="Question">{(id) => <Input id={id} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Have you previously worked for this company?" />}</Field>
          <Field label="Answer">{(id) => <Input id={id} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="e.g. No" />}</Field>
          <div>
            <Button
              size="sm"
              icon={<Icon.Plus size={14} />}
              disabled={!question.trim() || !answer.trim()}
              onClick={() => {
                const q = question.trim();
                const v = answer.trim();
                setSaved((list) => [...list.filter((x) => x.question !== q), { id: uid('ans'), question: q, answer: v }]);
                setQuestion('');
                setAnswer('');
              }}
            >
              Add answer
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Acknowledgements">
        <Checkbox
          label="Tick “I agree / I acknowledge / I certify” boxes for me"
          hint="Off by default. These are your own statements (privacy notices, accuracy certifications), so turn this on only if you're happy to agree to them on every application."
          checked={a.tickConsent}
          onChange={(v) => void save((s) => ({ ...s, autofill: { ...s.autofill, tickConsent: v } }))}
        />
      </Card>
    </div>
  );
}

function NotificationsSection({ settings }: { settings: Settings }) {
  const has = useHasPermission({ permissions: ['notifications'] });
  const toast = useToast();
  const check = useAction(async () => {
    const due = await send<number>({ type: 'followups/check' });
    toast(due ? `${due} follow-up reminder(s) sent` : 'No follow-ups are due');
  });
  return (
    <div className="flex flex-col gap-3">
      {has === false && (
        <Alert tone="neutral" action={<PermissionButton permissions={['notifications']} label="Allow notifications" />}>
          Notifications are optional and off until you allow them.
        </Alert>
      )}
      <Card>
        <div className="flex flex-col gap-2.5">
          <Checkbox label="Remind me about follow-ups that are due" hint="Checked about once an hour while Chrome is running." disabled={!has} checked={settings.notifications.followUps} onChange={(v) => void save((s) => ({ ...s, notifications: { ...s.notifications, followUps: v } }))} />
          <Checkbox label="Tell me about strong new matches from job feeds" disabled={!has} checked={settings.notifications.newMatches} onChange={(v) => void save((s) => ({ ...s, notifications: { ...s.notifications, newMatches: v } }))} />
          <Field label="Minimum score for new-match alerts">
            {(id) => <CommitInput id={id} type="number" min={0} max={100} value={settings.discovery.notifyMinScore} onCommit={(v) => void save((s) => ({ ...s, discovery: { ...s.discovery, notifyMinScore: Math.min(100, Math.max(0, num(v, 80))) } }))} />}
          </Field>
        </div>
        {has && settings.notifications.followUps && (
          <div className="mt-3">
            <Button size="sm" busy={check.busy} onClick={() => void check.run()}>
              Check follow-ups now
            </Button>
          </div>
        )}
        {check.error && <Alert tone="bad">{check.error}</Alert>}
      </Card>
      <p className="text-[12px] text-muted">Chrome may delay scheduled checks while the browser is idle or closed. Job feed refresh is configured in Job Matches → Sources.</p>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * AI
 * ------------------------------------------------------------------------- */

const FEATURE_LABEL: Record<AiFeature, string> = {
  matchExplain: 'Match explanation',
  resumeTailor: 'Résumé bullet rewrites',
  coverLetter: 'Cover letter drafts',
  interviewPrep: 'Interview questions',
  applicationAnswers: 'Written answers in applications',
};
export const PROVIDER_LABEL: Record<AiProviderId, string> = { none: 'Off (built-in, no AI)', ollama: PROVIDERS.ollama.label, openai_compatible: PROVIDERS.openai_compatible.label, backend: PROVIDERS.backend.label };

function ProviderAccess({ baseUrl }: { baseUrl: string }) {
  const origin = originPattern(baseUrl);
  const has = useHasPermission({ origins: origin ? [origin] : [] });
  if (!origin) return <Alert tone="bad">This URL is not valid.</Alert>;
  if (has === undefined) return null;
  return has ? (
    <p className="flex items-center gap-1.5 text-[12px] text-good">
      <Icon.Check size={13} /> Access to {origin.replace('/*', '')} granted
    </p>
  ) : (
    <div className="flex flex-wrap items-center gap-2 text-[12px]">
      <span className="text-muted">The extension needs permission to reach {origin.replace('/*', '')}.</span>
      <PermissionButton origins={[origin]} label="Grant access" variant="secondary" />
    </div>
  );
}

function AiSection({ settings }: { settings: Settings }) {
  const ai = settings.ai;
  const usage = useAiUsage();
  const toast = useToast();
  const used = new Set(Object.values(ai.features));
  const setAi = (fn: (a: Settings['ai']) => Settings['ai']) => save((s) => ({ ...s, ai: fn(s.ai) }));
  const [tested, setTested] = useState<string | null>(null);
  const [permOrigin, setPermOrigin] = useState<string | null>(null);
  const test = useAction(async (feature: AiFeature) => {
    setTested(null);
    setPermOrigin(null);
    try {
      const r = await aiTestConnection(feature);
      setTested(`Connected to ${PROVIDER_LABEL[r.provider]} (${r.model}).`);
    } catch (e) {
      if (e instanceof AiError && e.code === 'permission' && e.origin) setPermOrigin(e.origin);
      throw e;
    }
  });
  const firstEnabled = AI_FEATURES.find((f) => ai.features[f] !== 'none');

  return (
    <div className="flex flex-col gap-3">
      <Alert tone="neutral">
        Every feature works without AI. When you turn AI on for a feature, it runs only when you press its AI button, and job and profile text is sent to the provider you choose. Outputs are checked against your profile and anything unsupported is flagged.
      </Alert>
      <Card title="Provider per feature">
        <div className="flex flex-col gap-2">
          {AI_FEATURES.map((f) => (
            <div key={f} className="flex flex-wrap items-center gap-2">
              <label htmlFor={`ai-${f}`} className="flex-1 text-[13px]">
                {FEATURE_LABEL[f]}
              </label>
              <Select id={`ai-${f}`} className="w-auto" value={ai.features[f]} onChange={(e) => {
                  // Read the value now: the updater runs after an await, when React has reset the controlled select.
                  const provider = e.target.value as AiProviderId;
                  void setAi((a) => ({ ...a, features: { ...a.features, [f]: provider } }));
                }}>
                {(Object.keys(PROVIDER_LABEL) as AiProviderId[]).map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
          ))}
        </div>
        {firstEnabled && (
          <div className="mt-3 flex flex-col gap-2">
            <div>
              <Button
                size="sm"
                icon={<Icon.Spark size={14} />}
                busy={test.busy}
                onClick={() => void test.run(firstEnabled)}
              >
                Test {PROVIDER_LABEL[ai.features[firstEnabled]]}
              </Button>
            </div>
            {tested && <Alert tone="good">{tested}</Alert>}
            {test.error && (
              <Alert tone="bad" action={permOrigin && <PermissionButton origins={[permOrigin]} label="Grant access" onGranted={() => void test.run(firstEnabled)} />}>
                {test.error}
              </Alert>
            )}
            <p className="text-[12px] text-muted">The test sends a tiny prompt with no personal data. It counts toward your request limit.</p>
          </div>
        )}
      </Card>

      {used.has('ollama') && (
        <Card title={PROVIDERS.ollama.label} subtitle={PROVIDERS.ollama.note}>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Server URL">{(id) => <CommitInput id={id} value={ai.ollama.baseUrl} onCommit={(v) => void setAi((a) => ({ ...a, ollama: { ...a.ollama, baseUrl: v.trim() } }))} />}</Field>
            <Field label="Model">{(id) => <CommitInput id={id} value={ai.ollama.model} onCommit={(v) => void setAi((a) => ({ ...a, ollama: { ...a.ollama, model: v.trim() } }))} />}</Field>
          </div>
          <div className="mt-2">
            <ProviderAccess baseUrl={ai.ollama.baseUrl} />
          </div>
        </Card>
      )}
      {used.has('openai_compatible') && (
        <Card title={PROVIDERS.openai_compatible.label} subtitle={PROVIDERS.openai_compatible.note}>
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <Field label="Server URL" hint="Must be http://localhost or http://127.0.0.1.">
              {(id, d) => <CommitInput id={id} aria-describedby={d} value={ai.openaiCompatible.baseUrl} onCommit={(v) => void setAi((a) => ({ ...a, openaiCompatible: { ...a.openaiCompatible, baseUrl: v.trim() } }))} />}
            </Field>
            <Field label="Model">{(id) => <CommitInput id={id} value={ai.openaiCompatible.model} onCommit={(v) => void setAi((a) => ({ ...a, openaiCompatible: { ...a.openaiCompatible, model: v.trim() } }))} />}</Field>
          </div>
          <div className="mt-2">
            <ProviderAccess baseUrl={ai.openaiCompatible.baseUrl} />
          </div>
        </Card>
      )}
      {(used.has('backend') || ai.backend.token) && <BackendCard settings={settings} />}

      <Card title="Limits & cost">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <Field label="Requests per day" hint="0 = no limit">
            {(id, d) => <CommitInput id={id} aria-describedby={d} type="number" min={0} value={ai.limits.dailyRequests} onCommit={(v) => void setAi((a) => ({ ...a, limits: { ...a.limits, dailyRequests: Math.max(0, Math.round(num(v, 40))) } }))} />}
          </Field>
          <Field label="Tokens per month" hint="0 = no limit">
            {(id, d) => <CommitInput id={id} aria-describedby={d} type="number" min={0} value={ai.limits.monthlyTokens} onCommit={(v) => void setAi((a) => ({ ...a, limits: { ...a.limits, monthlyTokens: Math.max(0, Math.round(num(v, 1_000_000))) } }))} />}
          </Field>
          <Field label="Timeout (seconds)">
            {(id) => <CommitInput id={id} type="number" min={5} max={300} value={ai.timeoutMs / 1000} onCommit={(v) => void setAi((a) => ({ ...a, timeoutMs: Math.min(300, Math.max(5, num(v, 90))) * 1000 }))} />}
          </Field>
          <Field label="Retries on network errors">
            {(id) => <CommitInput id={id} type="number" min={0} max={4} value={ai.maxRetries} onCommit={(v) => void setAi((a) => ({ ...a, maxRetries: Math.min(4, Math.max(0, Math.round(num(v, 2)))) }))} />}
          </Field>
          <Field label="Reuse identical results for (hours)" hint="0 disables the cache">
            {(id, d) => <CommitInput id={id} aria-describedby={d} type="number" min={0} value={ai.cacheTtlHours} onCommit={(v) => void setAi((a) => ({ ...a, cacheTtlHours: Math.max(0, num(v, 336)) }))} />}
          </Field>
        </div>
        {used.has('backend') && (
          <div className="mt-3">
            <p className="mb-1 text-[12.5px] font-medium">Prices for cost estimates (USD per 1M tokens)</p>
            <p className="mb-2 text-[12px] text-muted">Copy these from your provider's current pricing page. Estimates are only as accurate as these numbers; if your backend reports a cost, that is used instead.</p>
            <div className="grid grid-cols-2 gap-2.5">
              <Field label="Input">{(id) => <CommitInput id={id} type="number" min={0} step={0.01} value={ai.pricing.backend.inputPerMTok} onCommit={(v) => void setAi((a) => ({ ...a, pricing: { ...a.pricing, backend: { ...a.pricing.backend, inputPerMTok: Math.max(0, num(v, 0)) } } }))} />}</Field>
              <Field label="Output">{(id) => <CommitInput id={id} type="number" min={0} step={0.01} value={ai.pricing.backend.outputPerMTok} onCommit={(v) => void setAi((a) => ({ ...a, pricing: { ...a.pricing, backend: { ...a.pricing.backend, outputPerMTok: Math.max(0, num(v, 0)) } } }))} />}</Field>
            </div>
          </div>
        )}
      </Card>

      <Card
        title="Usage"
        actions={
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={async () => (await resetUsage(), toast('Usage reset'))}>
              Reset
            </Button>
            <Button size="sm" variant="ghost" onClick={async () => (await clearCaches(), toast('Caches cleared'))}>
              Clear cache
            </Button>
          </div>
        }
      >
        {!usage ? (
          <Loading />
        ) : (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[13px] sm:grid-cols-4">
              <Stat label="Today" value={`${usage.dayRequests}${ai.limits.dailyRequests ? ` / ${ai.limits.dailyRequests}` : ''} requests`} />
              <Stat label="This month" value={`${usage.monthTokens.toLocaleString()} tokens`} />
              <Stat label="Est. cost this month" value={`$${usage.monthCostUsd.toFixed(4)}`} />
              <Stat label="Cache hits" value={String(usage.totals.cacheHits)} />
            </dl>
            {usage.log.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-[12px]">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-2 font-medium">When</th>
                      <th className="py-1 pr-2 font-medium">Feature</th>
                      <th className="py-1 pr-2 font-medium">Model</th>
                      <th className="py-1 pr-2 font-medium">Tokens</th>
                      <th className="py-1 font-medium">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.log.slice(0, 15).map((e, i) => (
                      <tr key={i} className="border-t border-line">
                        <td className="py-1 pr-2 whitespace-nowrap">{formatRelative(e.at)}</td>
                        <td className="py-1 pr-2">{FEATURE_LABEL[e.feature] ?? e.feature}</td>
                        <td className="py-1 pr-2">{e.model}</td>
                        <td className="py-1 pr-2 tabular-nums">{e.inputTokens + e.outputTokens}</td>
                        <td className="py-1">{e.cached ? 'Cached' : e.ok ? 'OK' : <span className="text-bad" title={e.error}>Failed</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );

}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function BackendCard({ settings }: { settings: Settings }) {
  const b = settings.ai.backend;
  const setB = (patch: Partial<typeof b>) => save((s) => ({ ...s, ai: { ...s.ai, backend: { ...s.ai.backend, ...patch } } }));
  const toast = useToast();
  const push = useAction(async () => {
    const r = await pushBackup();
    toast(`Backup uploaded (${Math.round(r.bytes / 1024)} KB)`, 'good');
  });
  const pull = useAction(async () => {
    const r = await pullBackup();
    toast(`Restored ${r.imported} item(s)${r.rejected.length ? `, ${r.rejected.length} skipped` : ''}`, 'good');
  });
  const [showToken, setShowToken] = useState(false);
  return (
    <Card title={PROVIDERS.backend.label} subtitle={PROVIDERS.backend.note}>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Field label="Backend URL">{(id) => <CommitInput id={id} value={b.baseUrl} onCommit={(v) => void setB({ baseUrl: v.trim() })} />}</Field>
        <Field label="Model override" hint="Leave empty to use the server default.">
          {(id, d) => <CommitInput id={id} aria-describedby={d} value={b.model} onCommit={(v) => void setB({ model: v.trim() })} />}
        </Field>
        <Field label="Access token" hint="The APP_TOKEN you set on your backend. Provider API keys stay on the server.">
          {(id, d) => (
            <div className="flex gap-1.5">
              <CommitInput id={id} aria-describedby={d} type={showToken ? 'text' : 'password'} autoComplete="off" value={b.token} onCommit={(v) => void setB({ token: v.trim() })} />
              <Button size="sm" variant="ghost" onClick={() => setShowToken(!showToken)}>
                {showToken ? 'Hide' : 'Show'}
              </Button>
            </div>
          )}
        </Field>
      </div>
      <div className="mt-2">
        <ProviderAccess baseUrl={b.baseUrl} />
      </div>
      <div className="mt-3">
        <Checkbox
          label="I understand that when I press an AI button, the job text and relevant parts of my profile are sent to my backend and from there to the model provider it is configured with."
          checked={b.consented}
          onChange={(v) => void setB({ consented: v })}
        />
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <p className="mb-1 font-medium">Backup sync (optional)</p>
        <p className="mb-2 text-[12px] text-muted">Uploads or restores a full backup — profile, résumés, jobs and applications — to your backend. It only happens when you press a button.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<Icon.Upload size={14} />} busy={push.busy} disabled={!b.consented} onClick={() => void push.run()}>
            Upload backup
          </Button>
          <Button size="sm" icon={<Icon.Download size={14} />} busy={pull.busy} disabled={!b.consented} onClick={() => void pull.run()}>
            Restore from backend
          </Button>
        </div>
        {(push.error || pull.error) && (
          <div className="mt-2">
            <Alert tone="bad">{push.error ?? pull.error}</Alert>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------------------
 * Data
 * ------------------------------------------------------------------------- */

function DataSection() {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const imp = useAction(async (file: File) => {
    if (file.size > 50 * 1024 * 1024) throw new Error('That file is too large to be a backup.');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      throw new Error('That file is not valid JSON.');
    }
    const r = await importBackup(parsed, mode);
    await send({ type: 'sites/sync' });
    await send({ type: 'alarms/sync' });
    toast(`Imported ${r.imported} item(s)${r.rejected.length ? `; skipped ${r.rejected.length} invalid` : ''}`, 'good');
    return r;
  });

  return (
    <div className="flex flex-col gap-3">
      <Card title="Back up and restore" subtitle="Backups include your profile, résumés, jobs, applications and settings. Your backend token is never included.">
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" icon={<Icon.Download size={14} />} onClick={async () => downloadBlob(JSON.stringify(await exportAll(), null, 2), `job-copilot-backup-${new Date().toISOString().slice(0, 10)}.json`, 'application/json')}>
            Export backup
          </Button>
          <Select aria-label="Import mode" className="w-auto" value={mode} onChange={(e) => setMode(e.target.value as 'merge' | 'replace')}>
            <option value="merge">Import: merge with current data</option>
            <option value="replace">Import: replace all current data</option>
          </Select>
          <Button icon={<Icon.Upload size={14} />} busy={imp.busy} onClick={() => fileRef.current?.click()}>
            Import…
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void imp.run(f);
            }}
          />
        </div>
        {imp.error && (
          <div className="mt-2">
            <Alert tone="bad">{imp.error}</Alert>
          </div>
        )}
      </Card>
      <Card title="Spreadsheets">
        <div className="flex flex-wrap gap-2">
          <Button
            icon={<Icon.Table size={14} />}
            onClick={async () => {
              const jobs = await listJobs();
              downloadBlob(jobsToCsv(jobs, await matchJobs(jobs)), 'job-copilot-jobs.csv', 'text/csv');
            }}
          >
            Jobs CSV
          </Button>
          <Button icon={<Icon.Table size={14} />} onClick={async () => downloadBlob(applicationsToCsv(await listApplications(), new Map((await listJobs()).map((j) => [j.id, j]))), 'job-copilot-applications.csv', 'text/csv')}>
            Applications CSV
          </Button>
        </div>
      </Card>
      <Card title="Storage">
        <div className="flex flex-wrap gap-2">
          <Button onClick={async () => (await clearCaches(), toast('Caches cleared; scores will be recomputed'))}>Clear cached scores & AI results</Button>
          <Button variant="danger" icon={<Icon.Trash size={14} />} onClick={() => (setTyped(''), setConfirm(true))}>
            Delete all data
          </Button>
        </div>
      </Card>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete everything?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={typed !== 'DELETE'}
              onClick={async () => {
                await deleteAllData();
                await send({ type: 'sites/sync' }).catch(() => undefined);
                await send({ type: 'alarms/sync' }).catch(() => undefined);
                setConfirm(false);
                toast('All data deleted');
              }}
            >
              Delete all data
            </Button>
          </>
        }
      >
        <p className="mb-2">This permanently removes your profile, résumés, jobs, applications, settings and usage history from this browser. Export a backup first if you might need it.</p>
        <Field label="Type DELETE to confirm">{(id) => <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}</Field>
      </Dialog>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Privacy & permissions
 * ------------------------------------------------------------------------- */

const PERMISSION_INFO: Record<string, string> = {
  storage: 'Saves your profile, jobs and settings in this browser.',
  unlimitedStorage: 'Lets large résumés and many saved jobs fit without hitting the default quota.',
  sidePanel: 'Shows the main Job Copilot panel beside the page.',
  activeTab: 'Lets you analyze the current tab when you click Analyze — only that tab, only then.',
  scripting: 'Runs the job extractor on enabled sites or when you click Analyze.',
  alarms: 'Schedules job feed refreshes and follow-up checks.',
  contextMenus: 'Adds “Send selection to Job Copilot” to the right-click menu.',
  notifications: 'Optional: follow-up and new-match alerts.',
};

function PrivacySection() {
  const [perms, setPerms] = useState<{ permissions: string[]; origins: string[] }>();
  useEffect(() => {
    const load = () => void browser.permissions.getAll().then((p) => setPerms({ permissions: p.permissions ?? [], origins: p.origins ?? [] }));
    load();
    browser.permissions.onAdded.addListener(load);
    browser.permissions.onRemoved.addListener(load);
    return () => {
      browser.permissions.onAdded.removeListener(load);
      browser.permissions.onRemoved.removeListener(load);
    };
  }, []);
  return (
    <div className="flex flex-col gap-3">
      <Card title="How your data is handled">
        <ul className="list-disc space-y-1 pl-4 text-[13px]">
          <li>Everything is stored locally in this browser. There is no Job Copilot account or server unless you run your own backend.</li>
          <li>Job pages are read only on sites you enable, or when you click Analyze. Browsing history and other pages are never collected.</li>
          <li>Matching, tailoring, cover-letter templates and interview prep run on your device.</li>
          <li>Job and profile text leaves your device only when you press an AI button for a feature you configured, or when you press Upload backup.</li>
          <li>Job feeds fetch public job-board APIs for companies you add; only the company identifier is sent.</li>
          <li>Text from job pages is treated as untrusted: it is sanitized before display and fenced off from instructions when sent to an AI model.</li>
        </ul>
      </Card>
      <Card title="Permissions currently granted">
        {!perms ? (
          <Loading />
        ) : (
          <>
            <ul className="flex flex-col gap-1.5 text-[13px]">
              {perms.permissions.map((p) => (
                <li key={p}>
                  <span className="font-mono text-[12px]">{p}</span> — <span className="text-muted">{PERMISSION_INFO[p] ?? ''}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 mb-1 text-[12.5px] font-medium">Site access</p>
            {perms.origins.length ? (
              <ul className="flex flex-col gap-1 text-[12.5px]">
                {perms.origins.map((o) => (
                  <li key={o} className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono">{o}</span>
                    <Button size="sm" variant="ghost" onClick={() => void browser.permissions.remove({ origins: [o] })}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12.5px] text-muted">None. Job Copilot can only read a page when you click Analyze.</p>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

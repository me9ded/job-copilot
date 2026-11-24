import { useEffect, useMemo, useState } from 'react';
import { AiError } from '../lib/ai/client';
import { aiExplainMatch, type MatchExplain } from '../lib/ai/features';
import { formatSalary, parseSalaryText } from '../lib/extraction/salary';
import { finalizeJob } from '../lib/extraction/normalize';
import { COMPONENT_LABELS } from '../lib/matching/engine';
import { sanitizeHtml } from '../lib/sanitize';
import type { ExtractedJob, JobRecord, MatchResult, Profile, Settings, WorkArrangement } from '../lib/types';
import { formatDate } from '../lib/util';
import { Alert, Badge, Button, Card, Field, Input, Meter, ScoreRing, Select, TextArea, cx } from './components';
import { useAction } from './hooks';
import { Icon } from './icons';
import { ARRANGEMENT_LABEL, FIELD_LABEL } from './labels';
import { PermissionButton } from './permission';

/* ----------------------------------------------------------------------------
 * Job header
 * ------------------------------------------------------------------------- */

export function JobHeader({ job, actions }: { job: ExtractedJob | JobRecord; actions?: React.ReactNode }) {
  const salary = formatSalary(job.salary);
  const record = 'id' in job ? job : null;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <h2 className="text-[16px] leading-snug font-semibold">{job.title || 'Untitled role'}</h2>
        <p className="text-muted">
          {job.company || 'Unknown company'}
          {job.location ? ` · ${job.location}` : ''}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge>{ARRANGEMENT_LABEL[job.workArrangement]}</Badge>
        {job.employmentType && <Badge>{job.employmentType}</Badge>}
        {salary && <Badge tone="accent">{salary}</Badge>}
        {job.datePosted && <Badge>Posted {formatDate(job.datePosted)}</Badge>}
        {record?.lastVerifiedAt && <Badge title="Last time this listing was seen live">Verified {formatDate(record.lastVerifiedAt)}</Badge>}
      </div>
      {actions && <div className="flex flex-wrap gap-1.5 pt-1">{actions}</div>}
    </div>
  );
}

export function ExtractionWarnings({ job, onEdit }: { job: ExtractedJob; onEdit?: () => void }) {
  const important = job.missingFields.filter((f) => ['title', 'company', 'description', 'location', 'requirements'].includes(f));
  if (!important.length && !job.warnings.length) return null;
  return (
    <Alert
      tone="warn"
      title={important.length ? `Extraction incomplete (${Math.round(job.completeness * 100)}%)` : 'Please review'}
      action={
        onEdit && (
          <Button size="sm" icon={<Icon.Edit size={14} />} onClick={onEdit}>
            Correct details
          </Button>
        )
      }
    >
      {important.length > 0 && <p>Missing: {important.map((f) => FIELD_LABEL[f] ?? f).join(', ')}.</p>}
      {job.warnings.map((w) => (
        <p key={w}>{w}</p>
      ))}
    </Alert>
  );
}

export function Description({ job }: { job: ExtractedJob }) {
  const html = useMemo(() => (job.descriptionHtml ? sanitizeHtml(job.descriptionHtml) : ''), [job.descriptionHtml]);
  if (html) return <div className="prose-job text-[13px] break-words" dangerouslySetInnerHTML={{ __html: html }} />;
  return <pre className="font-sans text-[13px] break-words whitespace-pre-wrap">{job.descriptionText}</pre>;
}

/* ----------------------------------------------------------------------------
 * Match panel
 * ------------------------------------------------------------------------- */

function SkillChips({ items, tone }: { items: Array<{ label: string; title?: string; partial?: boolean }>; tone: 'good' | 'bad' | 'neutral' }) {
  if (!items.length) return <p className="text-[12.5px] text-muted">None</p>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <li key={s.label}>
          <Badge tone={s.partial ? 'warn' : tone} title={s.title}>
            {tone === 'good' && !s.partial && <Icon.Check size={12} />}
            {s.label}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

export function MatchPanel({ match, job, profile, settings, compact }: { match: MatchResult; job: ExtractedJob; profile: Profile; settings: Settings; compact?: boolean }) {
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex gap-3">
          <ScoreRing score={match.score} />
          <div className="min-w-0 text-[13px]">
            <p>{match.explanation}</p>
            <p className="mt-1 text-[12px] text-muted">Measures overlap between this posting and your profile. It is not a prediction of whether you will be hired.</p>
          </div>
        </div>
        {match.dealBreakers.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {match.dealBreakers.map((d) => (
              <li key={d.code}>
                <Alert tone={d.severity === 'hard' ? 'bad' : 'warn'}>
                  <span className="font-medium">{d.severity === 'hard' ? 'Deal-breaker: ' : 'Heads up: '}</span>
                  {d.message}
                </Alert>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="mt-3 flex items-center gap-1 text-[12.5px] font-medium text-accent" aria-expanded={showWhy} onClick={() => setShowWhy((v) => !v)}>
          <Icon.ChevronDown size={14} className={cx('transition-transform', showWhy && 'rotate-180')} /> How this score is calculated
        </button>
        {showWhy && (
          <div className="mt-2 flex flex-col gap-2.5">
            {match.components.map((c) => (
              <div key={c.key} className="text-[12.5px]">
                <div className="flex justify-between gap-2">
                  <span className="font-medium">{COMPONENT_LABELS[c.key]}</span>
                  <span className="text-muted tabular-nums">{c.score === null ? 'n/a' : `${Math.round(c.score * 100)}% × weight ${c.weight} → ${c.contribution.toFixed(1)} pts`}</span>
                </div>
                {c.score !== null && <Meter value={c.score} label={COMPONENT_LABELS[c.key]} />}
                <p className="text-muted">{c.detail}</p>
              </div>
            ))}
            <p className="text-[12px] text-muted">
              Score = Σ(component score × weight) ÷ Σ(weights of applicable components) × 100. Components that don’t apply are skipped and their weight is redistributed. A hard deal-breaker caps the score at {settings.dealBreakerCap}. Weights are adjustable in Settings → Matching.
            </p>
          </div>
        )}
      </Card>

      <Card title="Required skills" subtitle={match.inferredRequirements ? 'Inferred from the whole posting (no requirements section found)' : undefined}>
        <div className="flex flex-col gap-2">
          <SkillChips
            tone="good"
            items={match.requiredMatched.map((h) => ({
              label: h.relatedVia ? `${h.skill} (via ${h.relatedVia})` : h.skill,
              partial: h.credit < 1,
              title: h.relatedVia ? `Partial credit: you have the related skill ${h.relatedVia}` : `Found in: ${h.evidence.join('; ')}`,
            }))}
          />
          {match.requiredMissing.filter((s) => !match.requiredMatched.some((h) => h.skill === s)).length > 0 && (
            <>
              <p className="text-[12px] font-medium text-bad">Missing</p>
              <SkillChips tone="bad" items={match.requiredMissing.filter((s) => !match.requiredMatched.some((h) => h.skill === s)).map((s) => ({ label: s }))} />
            </>
          )}
        </div>
      </Card>

      {(match.preferredMatched.length > 0 || match.preferredMissing.length > 0) && (
        <Card title="Preferred / nice to have" subtitle="Missing these never rules a job out.">
          <div className="flex flex-col gap-2">
            <SkillChips tone="good" items={match.preferredMatched.map((h) => ({ label: h.relatedVia ? `${h.skill} (via ${h.relatedVia})` : h.skill, partial: h.credit < 1 }))} />
            {match.preferredMissing.length > 0 && <SkillChips tone="neutral" items={match.preferredMissing.filter((s) => !match.preferredMatched.some((h) => h.skill === s)).map((s) => ({ label: s }))} />}
          </div>
        </Card>
      )}

      {!compact && match.relevant.length > 0 && (
        <Card title="Your most relevant experience">
          <ul className="flex flex-col gap-1.5 text-[13px]">
            {match.relevant.map((r) => (
              <li key={r.id}>
                <span className="font-medium">{r.label}</span> <span className="text-muted">— {r.matchedSkills.join(', ')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!compact && match.suggestions.length > 0 && (
        <Card title="Suggested résumé improvements">
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-[13px]">
            {match.suggestions.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </Card>
      )}

      {!compact && <AiExplainCard job={job} profile={profile} match={match} settings={settings} />}
    </div>
  );
}

function AiExplainCard({ job, profile, match, settings }: { job: ExtractedJob; profile: Profile; match: MatchResult; settings: Settings }) {
  const [result, setResult] = useState<{ data: MatchExplain; cached: boolean } | null>(null);
  const [permOrigin, setPermOrigin] = useState<string | null>(null);
  const { run, busy, error } = useAction(async (fresh: boolean) => {
    setPermOrigin(null);
    try {
      const r = await aiExplainMatch(job, profile, match, fresh);
      setResult({ data: r.data, cached: r.cached });
    } catch (e) {
      if (e instanceof AiError && e.code === 'permission' && e.origin) setPermOrigin(e.origin);
      throw e;
    }
  });
  useEffect(() => setResult(null), [match.cacheKey]);
  const enabled = settings.ai.features.matchExplain !== 'none';
  return (
    <Card
      title="AI explanation"
      subtitle={enabled ? 'Optional semantic analysis. Runs only when you ask; results are cached.' : 'Off — choose a provider in Settings → AI to enable.'}
      actions={
        enabled && (
          <Button size="sm" icon={<Icon.Spark size={14} />} busy={busy} onClick={() => void run(!!result)}>
            {result ? 'Regenerate' : 'Explain with AI'}
          </Button>
        )
      }
    >
      {error && (
        <Alert tone="bad" action={permOrigin && <PermissionButton origins={[permOrigin]} label="Grant access" onGranted={() => void run(false)} />}>
          {error}
        </Alert>
      )}
      {!result && !error && <p className="text-[12.5px] text-muted">{enabled ? 'The deterministic score above never depends on AI.' : 'Everything above was computed locally without AI.'}</p>}
      {result && (
        <div className="flex flex-col gap-2 text-[13px]">
          {result.cached && <Badge>From cache</Badge>}
          <p>{result.data.summary}</p>
          {result.data.strengths.length > 0 && (
            <div>
              <p className="font-medium">Strengths</p>
              <ul className="list-disc pl-4">
                {result.data.strengths.map((s, i) => (
                  <li key={i}>
                    {s.point} <span className="text-muted">— “{s.evidence}”</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.data.semanticMatches.length > 0 && (
            <div>
              <p className="font-medium">Matches the keyword matcher missed</p>
              <ul className="list-disc pl-4">
                {result.data.semanticMatches.map((s, i) => (
                  <li key={i}>
                    {s.requirement} <span className="text-muted">— “{s.evidence}”</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.data.gaps.length > 0 && (
            <div>
              <p className="font-medium">Gaps</p>
              <ul className="list-disc pl-4">
                {result.data.gaps.map((g, i) => (
                  <li key={i}>
                    {g.requirement}: <span className="text-muted">{g.note}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.data.droppedUnsupported > 0 && (
            <p className="text-[12px] text-muted">{result.data.droppedUnsupported} claim(s) were hidden because their quoted evidence was not found in your profile.</p>
          )}
        </div>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------------------------
 * Job editing (correct extraction) and manual entry
 * ------------------------------------------------------------------------- */

export interface JobFormValue {
  title: string;
  company: string;
  location: string;
  workArrangement: WorkArrangement;
  employmentType: string;
  salaryText: string;
  descriptionText: string;
  url: string;
  applyUrl: string;
}

export function jobToForm(job?: Partial<ExtractedJob>): JobFormValue {
  return {
    title: job?.title ?? '',
    company: job?.company ?? '',
    location: job?.location ?? '',
    workArrangement: job?.workArrangement ?? 'unknown',
    employmentType: job?.employmentType ?? '',
    salaryText: formatSalary(job?.salary),
    descriptionText: job?.descriptionText ?? '',
    url: job?.url ?? '',
    applyUrl: job?.applyUrl ?? '',
  };
}

/** Builds an ExtractedJob from the form, re-running section detection on the edited text. */
export function formToJob(v: JobFormValue, adapter: string, previous?: ExtractedJob): ExtractedJob {
  const salary = v.salaryText.trim() ? (parseSalaryText(v.salaryText) ?? { text: v.salaryText.trim() }) : undefined;
  const sameText = previous && previous.descriptionText === v.descriptionText;
  const job = finalizeJob({
    title: v.title,
    company: v.company,
    location: v.location || undefined,
    workArrangement: v.workArrangement,
    employmentType: v.employmentType || undefined,
    salary,
    descriptionText: v.descriptionText,
    descriptionHtml: sameText ? previous?.descriptionHtml : undefined,
    datePosted: previous?.datePosted,
    validThrough: previous?.validThrough,
    url: v.url || previous?.url || `manual:${Date.now()}`,
    applyUrl: v.applyUrl || undefined,
    adapter,
  });
  return { ...job, warnings: job.warnings.filter((w) => !/review them/.test(w)) };
}

export function JobForm({ value, onChange, showUrl = true }: { value: JobFormValue; onChange: (v: JobFormValue) => void; showUrl?: boolean }) {
  const set = <K extends keyof JobFormValue>(k: K, v: JobFormValue[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
      <Field label="Job title">{(id) => <Input id={id} value={value.title} onChange={(e) => set('title', e.target.value)} required />}</Field>
      <Field label="Company">{(id) => <Input id={id} value={value.company} onChange={(e) => set('company', e.target.value)} />}</Field>
      <Field label="Location">{(id) => <Input id={id} value={value.location} onChange={(e) => set('location', e.target.value)} />}</Field>
      <Field label="Work arrangement">
        {(id) => (
          <Select id={id} value={value.workArrangement} onChange={(e) => set('workArrangement', e.target.value as WorkArrangement)}>
            {(['unknown', 'remote', 'hybrid', 'onsite'] as const).map((a) => (
              <option key={a} value={a}>
                {a === 'unknown' ? 'Not stated' : ARRANGEMENT_LABEL[a]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Employment type">{(id) => <Input id={id} value={value.employmentType} placeholder="Full-time" onChange={(e) => set('employmentType', e.target.value)} />}</Field>
      <Field label="Salary" hint="e.g. $120,000 – $150,000 or 60–75 USD per hour">
        {(id, d) => <Input id={id} aria-describedby={d} value={value.salaryText} onChange={(e) => set('salaryText', e.target.value)} />}
      </Field>
      {showUrl && (
        <>
          <Field label="Job URL">{(id) => <Input id={id} type="url" value={value.url} onChange={(e) => set('url', e.target.value)} />}</Field>
          <Field label="Application URL">{(id) => <Input id={id} type="url" value={value.applyUrl} onChange={(e) => set('applyUrl', e.target.value)} />}</Field>
        </>
      )}
      <Field label="Description" className="sm:col-span-2" hint="Keep headings such as “Requirements” and “Nice to have” on their own lines — they drive required vs preferred matching.">
        {(id, d) => <TextArea id={id} aria-describedby={d} rows={10} value={value.descriptionText} onChange={(e) => set('descriptionText', e.target.value)} />}
      </Field>
    </div>
  );
}

export function validateJobForm(v: JobFormValue): string | null {
  if (!v.title.trim()) return 'Add a job title.';
  if (v.descriptionText.trim().length < 50) return 'Paste the job description (at least a few sentences).';
  if (v.url && !/^https?:\/\//i.test(v.url) && !v.url.startsWith('manual:')) return 'The job URL must start with http:// or https://';
  return null;
}

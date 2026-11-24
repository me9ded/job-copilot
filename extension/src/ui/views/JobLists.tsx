import { browser } from 'wxt/browser';
import { useMemo, useState } from 'react';
import { jobFreshness } from '../../lib/jobs';
import { send, type DiscoveryRunSummary } from '../../lib/messages';
import { SOURCE_ADAPTERS } from '../../lib/discovery/sources';
import { jobsToCsv } from '../../lib/export';
import { downloadBlob } from '../../lib/resume/export';
import { setJobDismissed, setJobSaved, updateSettings } from '../../lib/storage/repo';
import { DiscoverySource, type DiscoverySourceKind, type JobRecord, type MatchResult, type Settings, type WorkArrangement } from '../../lib/types';
import { formatRelative, normalizeForCompare, uid } from '../../lib/util';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Field, IconButton, Input, Loading, PageHeader, ScorePill, Select, useToast } from '../components';
import { useAction, useJobs, useMatches, useProfile, useSettings } from '../hooks';
import { Icon } from '../icons';
import { ARRANGEMENT_LABEL } from '../labels';
import { PermissionButton, useHasPermission, useNav } from '../permission';
import { FreshnessBadge, JobDetail, SortSelect } from './JobDetail';
import { ManualJobDialog } from './ManualJob';

type SortKey = 'score' | 'saved' | 'posted' | 'company';

function JobRow({ job, match, settings, onOpen, actions }: { job: JobRecord; match?: MatchResult; settings: Settings; onOpen: () => void; actions?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3 border-b border-line px-3 py-2.5 last:border-b-0 hover:bg-subtle/60">
      <div className="pt-0.5">
        <ScorePill score={match?.score} />
      </div>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="truncate font-medium">{job.title}</p>
        <p className="truncate text-[12.5px] text-muted">
          {job.company}
          {job.location ? ` · ${job.location}` : ''}
          {job.workArrangement !== 'unknown' ? ` · ${ARRANGEMENT_LABEL[job.workArrangement]}` : ''}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12px] text-muted">
          <FreshnessBadge job={job} staleAfterDays={settings.staleAfterDays} />
          {match?.dealBreakers.some((d) => d.severity === 'hard') && <Badge tone="bad">Deal-breaker</Badge>}
          <span>{job.datePosted ? `Posted ${formatRelative(job.datePosted)}` : `Added ${formatRelative(job.createdAt)}`}</span>
        </div>
      </button>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </li>
  );
}

interface Filters {
  q: string;
  arrangement: WorkArrangement | 'any';
  minScore: number;
  hideExpired: boolean;
}

function applyFilters(jobs: JobRecord[], matches: Map<string, MatchResult>, f: Filters, sort: SortKey, staleDays: number): JobRecord[] {
  const q = normalizeForCompare(f.q);
  const out = jobs.filter((j) => {
    if (q && !normalizeForCompare(`${j.title} ${j.company} ${j.location ?? ''} ${j.notes}`).includes(q)) return false;
    if (f.arrangement !== 'any' && j.workArrangement !== f.arrangement) return false;
    if (f.minScore > 0 && (matches.get(j.id)?.score ?? 0) < f.minScore) return false;
    if (f.hideExpired && jobFreshness(j, staleDays).state === 'expired') return false;
    return true;
  });
  const score = (j: JobRecord) => matches.get(j.id)?.score ?? -1;
  return out.sort((a, b) => {
    if (sort === 'score') return score(b) - score(a);
    if (sort === 'company') return a.company.localeCompare(b.company);
    if (sort === 'posted') return (b.datePosted ?? b.createdAt).localeCompare(a.datePosted ?? a.createdAt);
    return (b.savedAt ?? b.createdAt).localeCompare(a.savedAt ?? a.createdAt);
  });
}

function FilterBar({ f, setF, sort, setSort, sortOptions }: { f: Filters; setF: (f: Filters) => void; sort: SortKey; setSort: (s: SortKey) => void; sortOptions: Array<[SortKey, string]> }) {
  return (
    <div className="mb-3 flex flex-col gap-2">
      <div className="relative">
        <Icon.Search size={15} className="pointer-events-none absolute top-2.5 left-2.5 text-muted" />
        <Input aria-label="Search jobs" placeholder="Search title, company, location, notes" className="pl-8" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Work arrangement" className="w-auto" value={f.arrangement} onChange={(e) => setF({ ...f, arrangement: e.target.value as Filters['arrangement'] })}>
          <option value="any">Any arrangement</option>
          {(['remote', 'hybrid', 'onsite', 'unknown'] as const).map((a) => (
            <option key={a} value={a}>
              {ARRANGEMENT_LABEL[a]}
            </option>
          ))}
        </Select>
        <Select aria-label="Minimum score" className="w-auto" value={f.minScore} onChange={(e) => setF({ ...f, minScore: Number(e.target.value) })}>
          {[0, 50, 65, 75, 85].map((s) => (
            <option key={s} value={s}>
              {s ? `Score ≥ ${s}` : 'Any score'}
            </option>
          ))}
        </Select>
        <SortSelect label="Sort by" value={sort} onChange={setSort} options={sortOptions} />
        <Checkbox label="Hide expired" checked={f.hideExpired} onChange={(v) => setF({ ...f, hideExpired: v })} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Saved jobs
 * ------------------------------------------------------------------------- */

export function SavedJobsView() {
  const jobs = useJobs();
  const profile = useProfile();
  const settings = useSettings();
  const nav = useNav();
  const [showDismissed, setShowDismissed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState<Filters>({ q: '', arrangement: 'any', minScore: 0, hideExpired: false });
  const [sort, setSort] = useState<SortKey>('saved');
  const pool = useMemo(() => jobs?.filter((j) => (showDismissed ? j.dismissed : j.saved && !j.dismissed)), [jobs, showDismissed]);
  const matches = useMatches(pool, profile, settings);
  const selected = nav.view === 'saved' && nav.jobId ? jobs?.find((j) => j.id === nav.jobId) : undefined;

  if (!jobs || !settings) return <Loading />;
  if (selected) return <JobDetail job={selected} onBack={() => nav.go('saved')} />;
  const list = applyFilters(pool ?? [], matches, f, sort, settings.staleAfterDays);

  const exportAs = (kind: 'csv' | 'json') => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (kind === 'csv') downloadBlob(jobsToCsv(list, matches), `saved-jobs-${stamp}.csv`, 'text/csv');
    else downloadBlob(JSON.stringify(list, null, 2), `saved-jobs-${stamp}.json`, 'application/json');
  };

  return (
    <div>
      <PageHeader
        title={showDismissed ? 'Dismissed jobs' : 'Saved jobs'}
        description={`${list.length} of ${pool?.length ?? 0} shown`}
        actions={
          <>
            <Button size="sm" variant="primary" icon={<Icon.Plus size={14} />} onClick={() => setAdding(true)}>
              Add job
            </Button>
            <Button size="sm" icon={<Icon.Download size={14} />} disabled={!list.length} onClick={() => exportAs('csv')}>
              CSV
            </Button>
            <Button size="sm" icon={<Icon.Download size={14} />} disabled={!list.length} onClick={() => exportAs('json')}>
              JSON
            </Button>
          </>
        }
      />
      <ManualJobDialog open={adding} onClose={() => setAdding(false)} />
      <FilterBar f={f} setF={setF} sort={sort} setSort={setSort} sortOptions={[['saved', 'Recently saved'], ['score', 'Match score'], ['posted', 'Date posted'], ['company', 'Company']]} />
      <div className="mb-2">
        <Checkbox label="Show dismissed jobs instead" checked={showDismissed} onChange={setShowDismissed} />
      </div>
      {!pool?.length ? (
        <EmptyState icon={<Icon.Bookmark size={28} />} title={showDismissed ? 'No dismissed jobs' : 'No saved jobs yet'}>
          Press Add job to paste one in, save jobs from Job Matches, or use the Job Copilot button on job sites you turn on in Settings → Job sites.
        </EmptyState>
      ) : !list.length ? (
        <EmptyState title="No jobs match these filters" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-line bg-surface">
          {list.map((j) => (
            <JobRow
              key={j.id}
              job={j}
              match={matches.get(j.id)}
              settings={settings}
              onOpen={() => nav.go('saved', j.id)}
              actions={
                showDismissed ? (
                  <IconButton label="Restore" onClick={() => void setJobDismissed(j.id, false)}>
                    <Icon.Refresh size={15} />
                  </IconButton>
                ) : (
                  <IconButton label="Unsave" onClick={() => void setJobSaved(j.id, false)}>
                    <Icon.X size={15} />
                  </IconButton>
                )
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Job matches (discovery)
 * ------------------------------------------------------------------------- */

export function MatchesView() {
  const jobs = useJobs();
  const profile = useProfile();
  const settings = useSettings();
  const nav = useNav();
  const toast = useToast();
  const [f, setF] = useState<Filters>({ q: '', arrangement: 'any', minScore: 0, hideExpired: true });
  const [sort, setSort] = useState<SortKey>('score');
  const [showSources, setShowSources] = useState(false);
  const pool = useMemo(() => jobs?.filter((j) => j.origin === 'discovery' && !j.saved && !j.dismissed), [jobs]);
  const matches = useMatches(pool, profile, settings);
  const refresh = useAction(async (sourceId?: string) => {
    const s = await send<DiscoveryRunSummary>({ type: 'discovery/run', sourceId });
    toast(`Fetched ${s.fetched} jobs: ${s.created} new, ${s.expired} closed${s.errors.length ? `, ${s.errors.length} error(s)` : ''}`, s.errors.length ? 'warn' : 'good');
    return s;
  });
  const selected = nav.view === 'matches' && nav.jobId ? jobs?.find((j) => j.id === nav.jobId) : undefined;

  if (!jobs || !settings) return <Loading />;
  if (selected) return <JobDetail job={selected} onBack={() => nav.go('matches')} />;
  const list = applyFilters(pool ?? [], matches, f, sort, settings.staleAfterDays);
  const sources = settings.discovery.sources;

  return (
    <div>
      <PageHeader
        title="Job matches"
        description="Jobs from company boards you follow, ranked against your profile."
        actions={
          <>
            <Button size="sm" icon={<Icon.Gear size={14} />} aria-expanded={showSources || !sources.length} onClick={() => setShowSources((v) => !v)}>
              Sources ({sources.length})
            </Button>
            <Button size="sm" variant="primary" icon={<Icon.Refresh size={14} />} busy={refresh.busy} disabled={!sources.some((s) => s.enabled)} onClick={() => void refresh.run()}>
              Refresh
            </Button>
          </>
        }
      />
      {refresh.error && (
        <div className="mb-3">
          <Alert tone="bad">{refresh.error}</Alert>
        </div>
      )}
      {(showSources || !sources.length) && <SourcesCard settings={settings} onRun={(id) => void refresh.run(id)} busy={refresh.busy} />}
      {sources.length > 0 && (
        <>
          <FilterBar f={f} setF={setF} sort={sort} setSort={setSort} sortOptions={[['score', 'Match score'], ['posted', 'Date posted'], ['company', 'Company']]} />
          {!pool?.length ? (
            <EmptyState icon={<Icon.Compass size={28} />} title="No discovered jobs yet" action={<Button variant="primary" busy={refresh.busy} onClick={() => void refresh.run()}>Fetch now</Button>}>
              Refresh to pull current openings from your sources.
            </EmptyState>
          ) : !list.length ? (
            <EmptyState title="No jobs match these filters" />
          ) : (
            <ul className="overflow-hidden rounded-lg border border-line bg-surface">
              {list.slice(0, 200).map((j) => (
                <JobRow
                  key={j.id}
                  job={j}
                  match={matches.get(j.id)}
                  settings={settings}
                  onOpen={() => nav.go('matches', j.id)}
                  actions={
                    <>
                      <IconButton label="Save" onClick={() => void setJobSaved(j.id, true).then(() => toast('Saved', 'good'))}>
                        <Icon.Bookmark size={15} />
                      </IconButton>
                      <IconButton label="Dismiss" onClick={() => void setJobDismissed(j.id, true)}>
                        <Icon.X size={15} />
                      </IconButton>
                    </>
                  }
                />
              ))}
            </ul>
          )}
          {list.length > 200 && <p className="mt-2 text-[12px] text-muted">Showing the top 200. Narrow the filters to see others.</p>}
        </>
      )}
    </div>
  );
}

function SourceRow({ source, onRun, busy }: { source: DiscoverySource; onRun: () => void; busy: boolean }) {
  const adapter = SOURCE_ADAPTERS[source.kind];
  const granted = useHasPermission({ origins: [adapter.apiOrigin] });
  const update = (patch: Partial<DiscoverySource>) =>
    void updateSettings((s) => ({ ...s, discovery: { ...s.discovery, sources: s.discovery.sources.map((x) => (x.id === source.id ? { ...x, ...patch } : x)) } }));
  return (
    <li className="flex flex-col gap-1.5 border-b border-line py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">
            {source.label || source.token} <span className="font-normal text-muted">· {adapter.label}</span>
          </p>
          <p className="text-[12px] text-muted">
            <a className="underline" href={adapter.boardUrl(source.token)} target="_blank" rel="noopener noreferrer">
              {source.token}
            </a>
            {source.titleFilter && ` · filter: ${source.titleFilter}`}
            {source.lastRunAt && ` · ${source.lastCount ?? 0} jobs, ${formatRelative(source.lastRunAt)}`}
          </p>
        </div>
        <div className="flex items-center gap-0.5">
          <Button size="sm" variant="ghost" disabled={busy || !granted} onClick={onRun}>
            Run
          </Button>
          <IconButton label={`Remove ${source.label || source.token}`} onClick={() => void updateSettings((s) => ({ ...s, discovery: { ...s.discovery, sources: s.discovery.sources.filter((x) => x.id !== source.id) } }))}>
            <Icon.Trash size={15} />
          </IconButton>
        </div>
      </div>
      <Checkbox label="Include in scheduled refresh" checked={source.enabled} onChange={(v) => update({ enabled: v })} />
      {granted === false && (
        <Alert tone="warn" action={<PermissionButton origins={[adapter.apiOrigin]} label={`Allow ${adapter.apiOrigin.replace('/*', '')}`} />}>
          Access to {adapter.label}’s public API is needed to fetch this board.
        </Alert>
      )}
      {source.lastError && <Alert tone="bad">{source.lastError}</Alert>}
    </li>
  );
}

function SourcesCard({ settings, onRun, busy }: { settings: Settings; onRun: (id: string) => void; busy: boolean }) {
  const [kind, setKind] = useState<DiscoverySourceKind>('greenhouse');
  const [token, setToken] = useState('');
  const [label, setLabel] = useState('');
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const d = settings.discovery;

  const add = async () => {
    setError(null);
    const t = token.trim().replace(/^https?:\/\/[^/]+\//, '').split(/[/?#]/)[0] ?? '';
    const parsed = DiscoverySource.safeParse({ id: `${kind}:${t.toLowerCase()}:${uid()}`, kind, token: t, label: label.trim(), titleFilter: filter.trim(), enabled: true });
    if (!parsed.success) return setError('Enter the board name from the URL (letters, numbers, dashes).');
    if (d.sources.some((s) => s.kind === kind && s.token.toLowerCase() === t.toLowerCase())) return setError('That board is already added.');
    // Requested inside the click gesture.
    const granted = await browser.permissions.request({ origins: [SOURCE_ADAPTERS[kind].apiOrigin] });
    if (!granted) return setError(`Job Copilot needs access to ${SOURCE_ADAPTERS[kind].apiOrigin.replace('/*', '')} to read this board.`);
    await updateSettings((s) => ({ ...s, discovery: { ...s.discovery, sources: [...s.discovery.sources, parsed.data] } }));
    setToken('');
    setLabel('');
    setFilter('');
  };

  return (
    <Card className="mb-3" title="Sources" subtitle="Public job-board APIs published by Greenhouse, Lever and Ashby. Only boards you add are fetched.">
      {d.sources.length > 0 && (
        <ul className="mb-3">
          {d.sources.map((s) => (
            <SourceRow key={s.id} source={s} busy={busy} onRun={() => onRun(s.id)} />
          ))}
        </ul>
      )}
      <form
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Field label="Board type">
          {(id) => (
            <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as DiscoverySourceKind)}>
              <option value="greenhouse">Greenhouse</option>
              <option value="lever">Lever</option>
              <option value="ashby">Ashby</option>
            </Select>
          )}
        </Field>
        <Field label="Board name" hint={`From the URL, e.g. ${SOURCE_ADAPTERS[kind].boardUrl('company')}`}>
          {(id, dsc) => <Input id={id} aria-describedby={dsc} value={token} required onChange={(e) => setToken(e.target.value)} placeholder="company" />}
        </Field>
        <Field label="Company name (optional)">{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} />}</Field>
        <Field label="Title filter (optional)" hint="Comma-separated; prefix with - to exclude. e.g. engineer, -manager">
          {(id, dsc) => <Input id={id} aria-describedby={dsc} value={filter} onChange={(e) => setFilter(e.target.value)} />}
        </Field>
        <div className="flex items-center gap-2 sm:col-span-2">
          <Button type="submit" variant="primary" icon={<Icon.Plus size={14} />}>
            Add board
          </Button>
          {error && <span className="text-[12.5px] text-bad">{error}</span>}
        </div>
      </form>
      <div className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        <Checkbox
          label="Refresh automatically in the background"
          hint="Uses chrome.alarms. Chrome may delay runs while the computer sleeps; a missed run happens once on wake."
          checked={d.enabled}
          onChange={(v) => void updateSettings((s) => ({ ...s, discovery: { ...s.discovery, enabled: v } }))}
        />
        <div className="flex items-center gap-2 text-[13px]">
          <label htmlFor="refresh-hours">Every</label>
          <Select id="refresh-hours" className="w-auto" value={d.refreshHours} disabled={!d.enabled} onChange={(e) => {
            const refreshHours = Number(e.target.value);
            void updateSettings((s) => ({ ...s, discovery: { ...s.discovery, refreshHours } }));
          }}>
            {[3, 6, 12, 24, 48].map((h) => (
              <option key={h} value={h}>
                {h} hours
              </option>
            ))}
          </Select>
          {d.lastRunAt && <span className="text-muted">Last run {formatRelative(d.lastRunAt)}</span>}
        </div>
      </div>
    </Card>
  );
}

import { browser } from 'wxt/browser';
import type { z } from 'zod';
import { getSettings, withLock } from '../storage/repo';
import { KEYS } from '../storage/schema';
import type { AiFeature, AiProviderId, AiSettings } from '../types';
import { hash, nowIso, originPattern, sleep } from '../util';
import { HttpError, PROVIDERS, type CompletionResult } from './providers';

/* ----------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------- */

export type AiErrorCode = 'disabled' | 'consent' | 'permission' | 'limit' | 'timeout' | 'network' | 'http' | 'auth' | 'invalid_output' | 'config';

export class AiError extends Error {
  constructor(
    public code: AiErrorCode,
    message: string,
    public origin?: string,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/* ----------------------------------------------------------------------------
 * Usage tracking
 * ------------------------------------------------------------------------- */

export interface UsageEntry {
  at: string;
  feature: AiFeature;
  provider: AiProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
  cached: boolean;
  error?: string;
}

export interface AiUsage {
  day: string;
  dayRequests: number;
  month: string;
  monthTokens: number;
  monthCostUsd: number;
  totals: { requests: number; inputTokens: number; outputTokens: number; costUsd: number; errors: number; cacheHits: number };
  log: UsageEntry[];
}

const today = () => new Date().toISOString().slice(0, 10);
const thisMonth = () => new Date().toISOString().slice(0, 7);

export function emptyUsage(): AiUsage {
  return { day: today(), dayRequests: 0, month: thisMonth(), monthTokens: 0, monthCostUsd: 0, totals: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: 0, cacheHits: 0 }, log: [] };
}

export async function getUsage(): Promise<AiUsage> {
  const u = ((await browser.storage.local.get(KEYS.aiUsage))[KEYS.aiUsage] as AiUsage | undefined) ?? emptyUsage();
  // Roll the daily / monthly windows forward.
  if (u.day !== today()) Object.assign(u, { day: today(), dayRequests: 0 });
  if (u.month !== thisMonth()) Object.assign(u, { month: thisMonth(), monthTokens: 0, monthCostUsd: 0 });
  return u;
}

async function recordUsage(entry: UsageEntry): Promise<void> {
  await withLock(KEYS.aiUsage, async () => {
    const u = await getUsage();
    if (entry.cached) u.totals.cacheHits++;
    else {
      u.dayRequests++;
      u.monthTokens += entry.inputTokens + entry.outputTokens;
      u.monthCostUsd += entry.costUsd;
      u.totals.requests++;
      u.totals.inputTokens += entry.inputTokens;
      u.totals.outputTokens += entry.outputTokens;
      u.totals.costUsd += entry.costUsd;
      if (!entry.ok) u.totals.errors++;
    }
    u.log = [entry, ...u.log].slice(0, 40);
    await browser.storage.local.set({ [KEYS.aiUsage]: u });
  });
}

export async function resetUsage(): Promise<void> {
  await browser.storage.local.set({ [KEYS.aiUsage]: emptyUsage() });
}

export function estimateCost(s: AiSettings, provider: Exclude<AiProviderId, 'none'>, inTok: number, outTok: number): number {
  const p = s.pricing[provider];
  return (inTok * p.inputPerMTok + outTok * p.outputPerMTok) / 1_000_000;
}

/** Rough token estimate (≈4 characters per token) for pre-flight budget checks. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/* ----------------------------------------------------------------------------
 * Cache
 * ------------------------------------------------------------------------- */

interface CacheEntry {
  at: string;
  value: unknown;
  feature: AiFeature;
}
const MAX_CACHE = 200;

async function cacheGet(key: string, ttlHours: number): Promise<unknown | undefined> {
  const cache = ((await browser.storage.local.get(KEYS.aiCache))[KEYS.aiCache] ?? {}) as Record<string, CacheEntry>;
  const e = cache[key];
  if (!e) return undefined;
  if (Date.now() - new Date(e.at).getTime() > ttlHours * 3_600_000) return undefined;
  return e.value;
}

async function cacheSet(key: string, feature: AiFeature, value: unknown): Promise<void> {
  await withLock(KEYS.aiCache, async () => {
    const cache = ((await browser.storage.local.get(KEYS.aiCache))[KEYS.aiCache] ?? {}) as Record<string, CacheEntry>;
    cache[key] = { at: nowIso(), value, feature };
    const entries = Object.entries(cache).sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, MAX_CACHE);
    await browser.storage.local.set({ [KEYS.aiCache]: Object.fromEntries(entries) });
  });
}

/* ----------------------------------------------------------------------------
 * JSON extraction
 * ------------------------------------------------------------------------- */

export function extractJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {
        /* fall through */
      }
    }
    throw new AiError('invalid_output', 'The model did not return valid JSON.');
  }
}

/* ----------------------------------------------------------------------------
 * Run
 * ------------------------------------------------------------------------- */

export interface AiTask<S extends z.ZodType> {
  feature: AiFeature;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  temperature?: number;
  /** Skip the cache (user pressed "Regenerate"). */
  fresh?: boolean;
}

export interface AiRunResult<T> {
  data: T;
  cached: boolean;
  provider: AiProviderId;
  model: string;
  usage?: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface ResolvedProvider {
  id: Exclude<AiProviderId, 'none'>;
  origin: string;
}

/** Checks configuration, consent and permission without calling the model. */
export async function resolveProvider(feature: AiFeature, settings?: AiSettings): Promise<ResolvedProvider> {
  const s = settings ?? (await getSettings()).ai;
  const id = s.features[feature];
  if (id === 'none') throw new AiError('disabled', 'AI is turned off for this feature. Choose a provider in Settings → AI.');
  const provider = PROVIDERS[id];
  const origin = originPattern(provider.baseUrl(s));
  if (!origin) throw new AiError('config', `The ${provider.label} URL is not valid.`);
  if (id === 'openai_compatible' && !/^http:\/\/(localhost|127\.0\.0\.1)\//.test(origin))
    throw new AiError('config', 'The OpenAI-compatible option is for local servers only. Use your backend for hosted providers so API keys stay server-side.');
  if (id === 'backend') {
    if (!s.backend.consented) throw new AiError('consent', 'Confirm in Settings → AI that you agree to send job and profile text to your backend and its model provider.');
    if (!s.backend.token) throw new AiError('config', 'Add your backend access token in Settings → AI.');
  }
  if (!(await browser.permissions.contains({ origins: [origin] }))) throw new AiError('permission', `Allow Job Copilot to reach ${origin.replace('/*', '')}.`, origin);
  return { id, origin };
}

function classify(err: unknown, timedOut: boolean): AiError {
  if (err instanceof AiError) return err;
  if (timedOut) return new AiError('timeout', 'The model took too long to respond.');
  if (err instanceof HttpError) {
    if (err.status === 401 || err.status === 403) return new AiError('auth', 'The provider rejected the request (check your backend token).');
    if (err.status === 429) return new AiError('limit', 'The provider is rate-limiting requests. Try again shortly.');
    return new AiError('http', `The provider returned an error (${err.message}).`);
  }
  return new AiError('network', 'Could not reach the AI provider. Is it running and reachable?');
}

const retriable = (e: unknown) => e instanceof AiError && (e.code === 'network' || e.code === 'timeout' || e.code === 'http' || (e.code === 'limit' && !e.message.startsWith('Daily')));

export async function runAi<S extends z.ZodType>(task: AiTask<S>, deps: { complete?: typeof PROVIDERS.ollama.complete } = {}): Promise<AiRunResult<z.infer<S>>> {
  const settings = await getSettings();
  const s = settings.ai;
  const { id } = await resolveProvider(task.feature, s);
  const provider = PROVIDERS[id];
  const model = provider.model(s);
  const key = hash(JSON.stringify([task.feature, id, model, task.system, task.user]));

  if (!task.fresh && s.cacheTtlHours > 0) {
    const hit = await cacheGet(key, s.cacheTtlHours);
    if (hit !== undefined) {
      const parsed = task.schema.safeParse(hit);
      if (parsed.success) {
        await recordUsage({ at: nowIso(), feature: task.feature, provider: id, model, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: true, cached: true });
        return { data: parsed.data, cached: true, provider: id, model };
      }
    }
  }

  const usage = await getUsage();
  if (s.limits.dailyRequests > 0 && usage.dayRequests >= s.limits.dailyRequests)
    throw new AiError('limit', `Daily AI request limit reached (${s.limits.dailyRequests}). Change it in Settings → AI.`);
  const estimate = estimateTokens(task.system + task.user) + (task.maxTokens ?? 1200);
  if (s.limits.monthlyTokens > 0 && usage.monthTokens + estimate > s.limits.monthlyTokens)
    throw new AiError('limit', `Monthly token budget would be exceeded (${s.limits.monthlyTokens.toLocaleString()} tokens). Change it in Settings → AI.`);

  const complete = deps.complete ?? provider.complete;
  let user = task.user;
  let lastError: AiError | null = null;
  const maxAttempts = 1 + s.maxRetries;
  let repaired = false;
  let retryAfterMs: number | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, s.timeoutMs);
    let result: CompletionResult | null = null;
    try {
      result = await complete(s, { system: task.system, user, maxTokens: task.maxTokens ?? 1200, temperature: task.temperature ?? 0.2, feature: task.feature }, ctrl.signal);
    } catch (err) {
      lastError = classify(err, timedOut);
      retryAfterMs = err instanceof HttpError ? err.retryAfterMs : undefined;
    } finally {
      clearTimeout(timer);
    }

    if (result) {
      const inTok = result.inputTokens ?? estimateTokens(task.system + user);
      const outTok = result.outputTokens ?? estimateTokens(result.text);
      const cost = result.costUsd ?? estimateCost(s, id, inTok, outTok);
      try {
        const parsed = task.schema.safeParse(extractJson(result.text));
        if (!parsed.success) throw new AiError('invalid_output', 'The model returned JSON that does not match the expected structure.');
        await recordUsage({ at: nowIso(), feature: task.feature, provider: id, model: result.model || model, inputTokens: inTok, outputTokens: outTok, costUsd: cost, ok: true, cached: false });
        if (s.cacheTtlHours > 0) await cacheSet(key, task.feature, parsed.data);
        return { data: parsed.data, cached: false, provider: id, model: result.model || model, usage: { inputTokens: inTok, outputTokens: outTok, costUsd: cost } };
      } catch (err) {
        lastError = err instanceof AiError ? err : new AiError('invalid_output', 'Invalid output');
        await recordUsage({ at: nowIso(), feature: task.feature, provider: id, model, inputTokens: inTok, outputTokens: outTok, costUsd: cost, ok: false, cached: false, error: lastError.message });
        // One repair attempt with an explicit reminder; further invalid output is final.
        if (repaired) break;
        repaired = true;
        user = `${task.user}\n\nYour previous reply was not valid JSON for the required structure. Reply with the JSON object only.`;
        continue;
      }
    }

    await recordUsage({ at: nowIso(), feature: task.feature, provider: id, model, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, cached: false, error: lastError?.message });
    if (!retriable(lastError) || attempt === maxAttempts - 1) break;
    await sleep(Math.min(10_000, retryAfterMs ?? 600 * 2 ** attempt + Math.random() * 250));
  }
  throw lastError ?? new AiError('network', 'AI request failed.');
}

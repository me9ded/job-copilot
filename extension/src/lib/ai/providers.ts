import type { AiProviderId, AiSettings } from '../types';

export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  feature: string;
}

export interface CompletionResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Cost reported by the user's backend, if it computes one. */
  costUsd?: number;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;

async function postJson(url: string, body: unknown, signal: AbortSignal, headers: Record<string, string> = {}): Promise<Json> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
    credentials: 'omit',
  });
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    let detail = '';
    try {
      const j = (await res.json()) as Json;
      detail = String((j.error as Json)?.message ?? j.detail ?? j.error ?? '');
    } catch {
      /* non-JSON error body */
    }
    throw new HttpError(res.status, `HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined);
  }
  return (await res.json()) as Json;
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');

export interface ProviderInfo {
  id: Exclude<AiProviderId, 'none'>;
  label: string;
  baseUrl(s: AiSettings): string;
  model(s: AiSettings): string;
  complete(s: AiSettings, req: CompletionRequest, signal: AbortSignal): Promise<CompletionResult>;
  /** Short note shown in Settings. */
  note: string;
}

export const PROVIDERS: Record<Exclude<AiProviderId, 'none'>, ProviderInfo> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    note: 'Runs on your computer. Start Ollama with OLLAMA_ORIGINS=chrome-extension://* so the extension may call it.',
    baseUrl: (s) => s.ollama.baseUrl,
    model: (s) => s.ollama.model,
    async complete(s, req, signal) {
      const j = await postJson(
        `${trimSlash(s.ollama.baseUrl)}/api/chat`,
        {
          model: s.ollama.model,
          stream: false,
          format: 'json',
          options: { temperature: req.temperature, num_predict: req.maxTokens },
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        },
        signal,
      );
      return {
        text: String((j.message as Json | undefined)?.content ?? ''),
        model: String(j.model ?? s.ollama.model),
        inputTokens: typeof j.prompt_eval_count === 'number' ? j.prompt_eval_count : undefined,
        outputTokens: typeof j.eval_count === 'number' ? j.eval_count : undefined,
      };
    },
  },
  openai_compatible: {
    id: 'openai_compatible',
    label: 'Local OpenAI-compatible server',
    note: 'LM Studio, llama.cpp server, vLLM or similar running on localhost. No API key is stored in the extension.',
    baseUrl: (s) => s.openaiCompatible.baseUrl,
    model: (s) => s.openaiCompatible.model,
    async complete(s, req, signal) {
      const j = await postJson(
        `${trimSlash(s.openaiCompatible.baseUrl)}/v1/chat/completions`,
        {
          model: s.openaiCompatible.model,
          temperature: req.temperature,
          max_tokens: req.maxTokens,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
        },
        signal,
      );
      const choice = Array.isArray(j.choices) ? (j.choices[0] as Json | undefined) : undefined;
      const usage = j.usage as Json | undefined;
      return {
        text: String((choice?.message as Json | undefined)?.content ?? ''),
        model: String(j.model ?? s.openaiCompatible.model),
        inputTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
        outputTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : undefined,
      };
    },
  },
  backend: {
    id: 'backend',
    label: 'Your Job Copilot backend',
    note: 'Your own FastAPI server holds hosted-provider API keys server-side. Hosting it may cost money; hosted model usage is billed by the provider.',
    baseUrl: (s) => s.backend.baseUrl,
    model: (s) => s.backend.model || 'server default',
    async complete(s, req, signal) {
      const j = await postJson(
        `${trimSlash(s.backend.baseUrl)}/v1/complete`,
        { feature: req.feature, system: req.system, user: req.user, max_tokens: req.maxTokens, temperature: req.temperature, model: s.backend.model || undefined, json: true },
        signal,
        { Authorization: `Bearer ${s.backend.token}` },
      );
      const usage = j.usage as Json | undefined;
      return {
        text: String(j.text ?? ''),
        model: String(j.model ?? ''),
        inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
        outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
        costUsd: typeof j.cost_usd === 'number' ? j.cost_usd : undefined,
      };
    },
  },
};

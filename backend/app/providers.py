"""Model provider adapters. API keys live only in the server environment."""

import json
from dataclasses import dataclass
from typing import Protocol

import anthropic
import httpx

from .config import Settings


@dataclass
class CompletionRequest:
    feature: str
    system: str
    user: str
    max_tokens: int
    model: str | None = None
    temperature: float = 0.2


@dataclass
class Completion:
    text: str
    model: str
    input_tokens: int
    output_tokens: int


class ProviderError(Exception):
    """A failure talking to the upstream provider, mapped to an HTTP status for the extension."""

    def __init__(self, status: int, message: str, retry_after: int | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.retry_after = retry_after


class Provider(Protocol):
    name: str

    async def complete(self, req: CompletionRequest) -> Completion: ...


class MockProvider:
    """Deterministic, offline provider for development and tests. Returns valid JSON per feature."""

    name = "mock"

    async def complete(self, req: CompletionRequest) -> Completion:
        bodies: dict[str, object] = {
            "matchExplain": {"summary": "Mock explanation.", "strengths": [], "gaps": [], "semanticMatches": []},
            "resumeTailor": {"bullets": []},
            "coverLetter": {"body": "Mock cover letter. Replace AI_PROVIDER=mock with a real provider to generate drafts. " * 2},
            "interviewPrep": {"items": []},
            "applicationAnswers": {"answer": "Mock answer. Replace AI_PROVIDER=mock with a real provider to generate drafts.", "evidence": []},
        }
        text = json.dumps(bodies.get(req.feature, {"ok": True}))
        return Completion(text=text, model="mock", input_tokens=len(req.system + req.user) // 4, output_tokens=len(text) // 4)


class AnthropicProvider:
    name = "anthropic"

    def __init__(self, s: Settings):
        # The SDK retries 408/409/429/5xx and connection errors itself.
        self.client = anthropic.AsyncAnthropic(api_key=s.anthropic_api_key, timeout=s.request_timeout_seconds, max_retries=2)
        self.model = s.anthropic_model
        self.effort = s.anthropic_effort

    async def complete(self, req: CompletionRequest) -> Completion:
        try:
            response = await self.client.beta.messages.create(
                model=req.model or self.model,
                # Thinking tokens count toward max_tokens, so leave headroom beyond the visible answer.
                max_tokens=max(req.max_tokens, 16_000),
                system=req.system,
                messages=[{"role": "user", "content": req.user}],
                output_config={"effort": self.effort},
                # On a policy decline the API retries on a suitable fallback model within the same call.
                betas=["server-side-fallback-2026-07-01"],
                fallbacks="default",
            )
        except anthropic.AuthenticationError as e:
            raise ProviderError(502, "The server's Anthropic API key was rejected.") from e
        except anthropic.PermissionDeniedError as e:
            raise ProviderError(502, "The server's Anthropic API key lacks permission for this model.") from e
        except anthropic.NotFoundError as e:
            raise ProviderError(400, f"Unknown model '{req.model or self.model}'.") from e
        except anthropic.RateLimitError as e:
            raise ProviderError(429, "Anthropic is rate-limiting requests.", _retry_after(e.response.headers)) from e
        except anthropic.BadRequestError as e:
            raise ProviderError(400, f"Anthropic rejected the request: {e.message}"[:300]) from e
        except anthropic.APIStatusError as e:
            raise ProviderError(502 if e.status_code < 500 else 503, f"Anthropic error ({e.status_code}).") from e
        except anthropic.APITimeoutError as e:
            raise ProviderError(504, "Anthropic did not respond in time.") from e
        except anthropic.APIConnectionError as e:
            raise ProviderError(503, "Could not reach Anthropic.") from e

        if response.stop_reason == "refusal":
            raise ProviderError(422, "The model declined this request.")
        text = "".join(b.text for b in response.content if b.type == "text")
        return Completion(text=text, model=response.model, input_tokens=response.usage.input_tokens, output_tokens=response.usage.output_tokens)


class OpenAICompatibleProvider:
    """Any chat-completions API (OpenAI or a compatible host)."""

    name = "openai"

    def __init__(self, s: Settings):
        self.base = s.openai_base_url.rstrip("/")
        self.key = s.openai_api_key
        self.model = s.openai_model
        self.timeout = s.request_timeout_seconds

    async def complete(self, req: CompletionRequest) -> Completion:
        body = {
            "model": req.model or self.model,
            "max_tokens": req.max_tokens,
            "temperature": req.temperature,
            "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": req.system}, {"role": "user", "content": req.user}],
        }
        j = await _post_json(f"{self.base}/v1/chat/completions", body, {"Authorization": f"Bearer {self.key}"}, self.timeout, "the OpenAI-compatible API")
        choice = (j.get("choices") or [{}])[0]
        usage = j.get("usage") or {}
        return Completion(
            text=str((choice.get("message") or {}).get("content") or ""),
            model=str(j.get("model") or body["model"]),
            input_tokens=int(usage.get("prompt_tokens") or 0),
            output_tokens=int(usage.get("completion_tokens") or 0),
        )


class OllamaProvider:
    name = "ollama"

    def __init__(self, s: Settings):
        self.base = s.ollama_base_url.rstrip("/")
        self.model = s.ollama_model
        self.timeout = s.request_timeout_seconds

    async def complete(self, req: CompletionRequest) -> Completion:
        body = {
            "model": req.model or self.model,
            "stream": False,
            "format": "json",
            "options": {"temperature": req.temperature, "num_predict": req.max_tokens},
            "messages": [{"role": "system", "content": req.system}, {"role": "user", "content": req.user}],
        }
        j = await _post_json(f"{self.base}/api/chat", body, {}, self.timeout, "Ollama")
        return Completion(
            text=str((j.get("message") or {}).get("content") or ""),
            model=str(j.get("model") or body["model"]),
            input_tokens=int(j.get("prompt_eval_count") or 0),
            output_tokens=int(j.get("eval_count") or 0),
        )


def _retry_after(headers: httpx.Headers | object) -> int | None:
    try:
        value = headers.get("retry-after")  # type: ignore[attr-defined]
        return int(float(value)) if value else None
    except (TypeError, ValueError):
        return None


async def _post_json(url: str, body: dict, headers: dict[str, str], timeout: float, label: str) -> dict:
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            res = await client.post(url, json=body, headers=headers)
    except httpx.TimeoutException as e:
        raise ProviderError(504, f"{label} did not respond in time.") from e
    except httpx.HTTPError as e:
        raise ProviderError(503, f"Could not reach {label}.") from e
    if res.status_code == 429:
        raise ProviderError(429, f"{label} is rate-limiting requests.", _retry_after(res.headers))
    if res.status_code in (401, 403):
        raise ProviderError(502, f"{label} rejected the server's credentials.")
    if res.status_code >= 400:
        raise ProviderError(502 if res.status_code < 500 else 503, f"{label} returned HTTP {res.status_code}.")
    try:
        return res.json()
    except ValueError as e:
        raise ProviderError(502, f"{label} returned a non-JSON response.") from e


def build_provider(s: Settings) -> Provider:
    match s.ai_provider:
        case "anthropic":
            return AnthropicProvider(s)
        case "openai":
            return OpenAICompatibleProvider(s)
        case "ollama":
            return OllamaProvider(s)
        case _:
            return MockProvider()

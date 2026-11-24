import json

import anthropic
import httpx
import httpx2
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.providers import AnthropicProvider, Completion, CompletionRequest, MockProvider, OllamaProvider, ProviderError

TOKEN = "test-token-0123456789-abcdefghij"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


def settings(tmp_path, **kw) -> Settings:
    return Settings(app_token=TOKEN, database_url=f"sqlite:///{tmp_path}/t.db", **kw)


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(settings(tmp_path), MockProvider())) as c:
        yield c


def complete(c, **kw):
    body = {"feature": "coverLetter", "system": "sys", "user": "hello", "max_tokens": 200, **kw}
    return c.post("/v1/complete", json=body, headers=AUTH)


def test_health_needs_no_auth(client):
    assert client.get("/health").json() == {"ok": True, "provider": "mock"}


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong-token"}, {"Authorization": TOKEN}])
def test_rejects_missing_or_wrong_token(client, headers):
    r = client.post("/v1/complete", json={"feature": "coverLetter", "system": "s", "user": "u"}, headers=headers)
    assert r.status_code == 401
    assert client.get("/v1/sync", headers=headers).status_code == 401


def test_complete_returns_extension_shape_and_logs_usage(client):
    r = complete(client)
    assert r.status_code == 200
    j = r.json()
    assert set(j) == {"text", "model", "provider", "usage", "cost_usd"}
    assert json.loads(j["text"])["body"].startswith("Mock cover letter")
    assert j["cost_usd"] is None  # no prices configured
    u = client.get("/v1/usage", headers=AUTH).json()
    assert u["today"]["requests"] == 1
    assert u["recent"][0]["feature"] == "coverLetter"
    assert "hello" not in json.dumps(u)  # prompts are never stored


def test_validates_input(client):
    assert complete(client, feature="anything").status_code == 400
    assert complete(client, user="x" * 70_000).status_code == 413
    assert complete(client, max_tokens=0).status_code == 422


def test_daily_limit(tmp_path):
    with TestClient(create_app(settings(tmp_path, daily_request_limit=2), MockProvider())) as c:
        assert complete(c).status_code == 200
        assert complete(c).status_code == 200
        r = complete(c)
        assert r.status_code == 429
        assert "Daily request limit" in r.json()["detail"]


def test_cost_reported_when_prices_configured(tmp_path):
    with TestClient(create_app(settings(tmp_path, price_input_per_mtok=1.0, price_output_per_mtok=2.0), MockProvider())) as c:
        j = complete(c).json()
        expected = (j["usage"]["input_tokens"] * 1.0 + j["usage"]["output_tokens"] * 2.0) / 1_000_000
        assert j["cost_usd"] == pytest.approx(expected)


class FailingProvider:
    name = "fail"

    def __init__(self, err: ProviderError):
        self.err = err

    async def complete(self, req: CompletionRequest) -> Completion:
        raise self.err


def test_provider_errors_map_to_status_and_retry_after(tmp_path):
    with TestClient(create_app(settings(tmp_path), FailingProvider(ProviderError(429, "slow down", 7)))) as c:
        r = complete(c)
        assert r.status_code == 429
        assert r.headers["retry-after"] == "7"
        assert r.json()["detail"] == "slow down"
        assert c.get("/v1/usage", headers=AUTH).json()["recent"][0]["ok"] is False


def test_output_tokens_are_capped_by_server(tmp_path):
    seen: list[int] = []

    class Capture(MockProvider):
        async def complete(self, req):
            seen.append(req.max_tokens)
            return await super().complete(req)

    with TestClient(create_app(settings(tmp_path, max_output_tokens=500), Capture())) as c:
        complete(c, max_tokens=5000)
    assert seen == [500]


def test_sync_roundtrip_and_validation(client):
    assert client.get("/v1/sync", headers=AUTH).status_code == 404
    backup = {"format": "job-copilot-backup", "schemaVersion": 2, "exportedAt": "x", "data": {"profile": {}}}
    assert client.put("/v1/sync", content=json.dumps(backup), headers=AUTH).json()["ok"] is True
    assert client.get("/v1/sync", headers=AUTH).json() == backup
    assert client.put("/v1/sync", content=b"not json", headers=AUTH).status_code == 400
    assert client.put("/v1/sync", content=json.dumps({"hello": 1}), headers=AUTH).status_code == 400
    assert client.delete("/v1/sync", headers=AUTH).json() == {"ok": True}
    assert client.get("/v1/sync", headers=AUTH).status_code == 404


def test_sync_size_limit(tmp_path):
    with TestClient(create_app(settings(tmp_path, max_sync_bytes=1000), MockProvider())) as c:
        big = {"format": "job-copilot-backup", "data": {"x": "y" * 2000}}
        assert c.put("/v1/sync", content=json.dumps(big), headers=AUTH).status_code == 413


def test_settings_reject_weak_tokens_and_missing_keys(tmp_path):
    with pytest.raises(ValueError):
        Settings(app_token="short")
    with pytest.raises(ValueError):
        Settings(app_token="a" * 30)
    s = settings(tmp_path, ai_provider="anthropic")
    with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
        s.check_provider()


# --- Provider adapters against mocked HTTP -------------------------------------------------


def anthropic_provider(tmp_path, handler) -> AnthropicProvider:
    p = AnthropicProvider(settings(tmp_path, ai_provider="anthropic", anthropic_api_key="sk-test"))
    p.client = anthropic.AsyncAnthropic(api_key="sk-test", max_retries=0, http_client=anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler)))
    return p


REQ = CompletionRequest(feature="coverLetter", system="sys", user="hi", max_tokens=300)


async def test_anthropic_adapter_request_and_response(tmp_path):
    seen: dict = {}

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen["body"] = json.loads(request.content)
        seen["beta"] = request.headers.get("anthropic-beta")
        seen["key"] = request.headers.get("x-api-key") or request.headers.get("authorization", "").removeprefix("Bearer ")
        return httpx2.Response(
            200,
            json={
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-opus-5-5",
                "content": [{"type": "thinking", "thinking": "", "signature": "s"}, {"type": "text", "text": '{"body": "hi"}'}],
                "stop_reason": "end_turn",
                "stop_sequence": None,
                "usage": {"input_tokens": 12, "output_tokens": 5},
            },
        )

    out = await anthropic_provider(tmp_path, handler).complete(REQ)
    assert out == Completion(text='{"body": "hi"}', model="claude-opus-5-5", input_tokens=12, output_tokens=5)
    body = seen["body"]
    assert body["model"] == "claude-opus-5-5"
    assert body["max_tokens"] >= 16_000
    assert body["output_config"] == {"effort": "low"}
    assert body["fallbacks"] == "default"
    assert "temperature" not in body and "thinking" not in body
    assert "server-side-fallback-2026-07-01" in seen["beta"]
    assert seen["key"] == "sk-test"


@pytest.mark.parametrize(
    ("status", "headers", "expected", "retry_after"),
    [(401, {}, 502, None), (429, {"retry-after": "12"}, 429, 12), (404, {}, 400, None), (529, {}, 503, None)],
)
async def test_anthropic_adapter_error_mapping(tmp_path, status, headers, expected, retry_after):
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(status, headers=headers, json={"type": "error", "error": {"type": "x", "message": "nope"}})

    with pytest.raises(ProviderError) as e:
        await anthropic_provider(tmp_path, handler).complete(REQ)
    assert e.value.status == expected
    assert e.value.retry_after == retry_after


async def test_anthropic_refusal_is_reported(tmp_path):
    def handler(_: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"id": "m", "type": "message", "role": "assistant", "model": "claude-opus-5-5", "content": [], "stop_reason": "refusal", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 0}})

    with pytest.raises(ProviderError) as e:
        await anthropic_provider(tmp_path, handler).complete(REQ)
    assert e.value.status == 422


async def test_ollama_adapter(tmp_path, monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["format"] == "json" and body["stream"] is False
        return httpx.Response(200, json={"model": "llama3.1:8b", "message": {"content": "{}"}, "prompt_eval_count": 9, "eval_count": 2})

    real = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    out = await OllamaProvider(settings(tmp_path)).complete(REQ)
    assert (out.text, out.input_tokens, out.output_tokens) == ("{}", 9, 2)

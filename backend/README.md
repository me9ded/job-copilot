# Job Copilot backend (optional)

A small FastAPI service you run yourself. The extension works fully without it. Use it when you want to:

- use a **hosted model** (Anthropic, OpenAI or any OpenAI-compatible host) without putting an API key in the browser extension;
- enforce **server-side limits** and keep a usage log;
- keep a **backup** of your extension data on a machine you control.

Prompts and completions are never stored. The usage log records feature, model, token counts, cost estimate and error category.

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | — | Liveness, configured provider name |
| POST | `/v1/complete` | Bearer | `{feature, system, user, max_tokens, model?}` → `{text, model, provider, usage{input_tokens, output_tokens}, cost_usd}` |
| GET | `/v1/usage` | Bearer | Today / month counters, limits, last 20 calls |
| PUT / GET / DELETE | `/v1/sync` | Bearer | Store / fetch / delete the latest extension backup |

Errors return `{"detail": "..."}`. Upstream rate limits return `429` with `Retry-After`. A rejected provider key returns `502`, so the extension doesn't confuse it with a wrong `APP_TOKEN` (`401`).

## Run locally

```bash
cd backend
python3.13 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env
# edit .env: APP_TOKEN (random, ≥24 chars), AI_PROVIDER, provider key
.venv/bin/uvicorn --factory app.main:create_app --host 127.0.0.1 --port 8787
.venv/bin/python -m pytest      # tests (no network, no keys needed)
```

`AI_PROVIDER=mock` returns canned JSON, which is useful for trying the wiring without a key.

## Run with Docker Compose

```bash
cp .env.example .env              # fill it in
docker compose up --build         # SQLite in a named volume, http://127.0.0.1:8787
docker compose --profile postgres up --build   # with PostgreSQL; set DATABASE_URL and POSTGRES_PASSWORD
```

The port is bound to `127.0.0.1`. To reach it from another device, put it behind a TLS reverse proxy (Caddy, nginx) and use the `https://` URL in the extension. Don't expose plain HTTP.

## Providers

| `AI_PROVIDER` | Settings | Notes |
|---|---|---|
| `mock` | — | Offline, deterministic |
| `anthropic` | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `ANTHROPIC_EFFORT` (default `low`) | Official `anthropic` SDK. Server-side refusal fallback enabled (`fallbacks: "default"`). For lower cost, set a smaller model such as `claude-haiku-5-5` or `claude-sonnet-5-5`. |
| `openai` | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_BASE_URL` | Any chat-completions-compatible API; requests JSON output |
| `ollama` | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | Ollama on the server |

Hosted usage is billed by the provider to your key. This project doesn't state prices. To get cost estimates, copy current prices from the provider's pricing page into `PRICE_INPUT_PER_MTOK` / `PRICE_OUTPUT_PER_MTOK` (or into the extension's Settings → AI).

## Connect the extension

Settings → AI:
1. Pick **Your Job Copilot backend** for one or more features.
2. Enter the backend URL and the `APP_TOKEN`.
3. Press **Grant access** for that origin.
4. Tick the consent checkbox.
5. Press **Test** to confirm.

Backup sync (**Upload backup** / **Restore from backend**) is on the same card.

## Security notes

- `APP_TOKEN` is required at startup. Placeholder or low-entropy values are rejected.
- The token is compared in constant time.
- Request size, output tokens, daily requests and monthly tokens are capped server-side.
- The Docker image runs as an unprivileged user.
- Single-user by design: anyone with the token can use your provider quota and read your backup. Keep it secret and rotate it if it leaks.

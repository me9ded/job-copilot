"""Job Copilot backend: optional companion for the browser extension.

- POST /v1/complete  hosted-model completions; provider keys stay server-side
- GET  /v1/usage     usage summary and limits
- GET/PUT /v1/sync   store / fetch the latest extension backup
- GET  /health       liveness (no auth)

Run with: uvicorn --factory app.main:create_app

Prompts and completions are never written to the database or logs.
"""

import hmac
import json
import logging
from collections.abc import Iterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings, get_settings
from .db import SyncBlob, UsageLog, make_engine, make_sessionmaker, usage_since, utcnow
from .providers import CompletionRequest, Provider, ProviderError, build_provider

log = logging.getLogger("job_copilot")

FEATURES = {"matchExplain", "resumeTailor", "coverLetter", "interviewPrep", "applicationAnswers"}


class CompleteIn(BaseModel):
    feature: str = Field(max_length=40)
    system: str = Field(max_length=20_000)
    user: str
    max_tokens: int = Field(1200, ge=1, le=32_000)
    temperature: float = Field(0.2, ge=0, le=1)
    model: str | None = Field(None, max_length=120)
    json_output: bool = Field(True, alias="json")


class UsageOut(BaseModel):
    input_tokens: int
    output_tokens: int


class CompleteOut(BaseModel):
    text: str
    model: str
    provider: str
    usage: UsageOut
    cost_usd: float | None


def create_app(settings: Settings | None = None, provider: Provider | None = None) -> FastAPI:
    s = settings or get_settings()
    engine = make_engine(s.database_url)
    SessionLocal = make_sessionmaker(engine)
    prov = provider or build_provider(s)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        log.info("Job Copilot backend started with provider=%s", prov.name)
        yield
        engine.dispose()

    # No CORS middleware: extension pages with host permission for this origin are not
    # subject to CORS, and websites have no reason to call this API.
    app = FastAPI(title="Job Copilot backend", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None)
    bearer = HTTPBearer(auto_error=False)

    def db() -> Iterator[Session]:
        with SessionLocal() as session:
            yield session

    def auth(creds: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]) -> None:
        if creds is None or not hmac.compare_digest(creds.credentials.encode(), s.app_token.encode()):
            raise HTTPException(401, "Invalid or missing access token.", headers={"WWW-Authenticate": "Bearer"})

    DB = Annotated[Session, Depends(db)]

    def windows() -> tuple[datetime, datetime]:
        now = datetime.now(timezone.utc)
        day = now.replace(hour=0, minute=0, second=0, microsecond=0)
        return day, day.replace(day=1)

    def cost(input_tokens: int, output_tokens: int) -> float | None:
        if not (s.price_input_per_mtok or s.price_output_per_mtok):
            return None
        return (input_tokens * s.price_input_per_mtok + output_tokens * s.price_output_per_mtok) / 1_000_000

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "provider": prov.name}

    @app.post("/v1/complete", dependencies=[Depends(auth)])
    async def complete(body: CompleteIn, session: DB) -> CompleteOut:
        if body.feature not in FEATURES:
            raise HTTPException(400, f"Unknown feature '{body.feature}'.")
        if len(body.system) + len(body.user) > s.max_input_chars:
            raise HTTPException(413, f"Input is larger than this server allows ({s.max_input_chars} characters).")
        day, month = windows()
        if s.daily_request_limit and usage_since(session, day)[0] >= s.daily_request_limit:
            raise HTTPException(429, f"Daily request limit reached ({s.daily_request_limit}).")
        if s.monthly_token_limit and usage_since(session, month)[1] >= s.monthly_token_limit:
            raise HTTPException(429, f"Monthly token limit reached ({s.monthly_token_limit}).")

        req = CompletionRequest(
            feature=body.feature,
            system=body.system,
            user=body.user,
            max_tokens=min(body.max_tokens, s.max_output_tokens),
            model=body.model,
            temperature=body.temperature,
        )
        try:
            out = await prov.complete(req)
        except ProviderError as e:
            session.add(UsageLog(feature=body.feature, provider=prov.name, model=body.model or "", ok=False, error=e.message[:200]))
            session.commit()
            headers = {"Retry-After": str(e.retry_after)} if e.retry_after else None
            raise HTTPException(e.status, e.message, headers=headers) from e

        c = cost(out.input_tokens, out.output_tokens)
        session.add(UsageLog(feature=body.feature, provider=prov.name, model=out.model, input_tokens=out.input_tokens, output_tokens=out.output_tokens, cost_usd=c or 0.0, ok=True))
        session.commit()
        return CompleteOut(text=out.text, model=out.model, provider=prov.name, usage=UsageOut(input_tokens=out.input_tokens, output_tokens=out.output_tokens), cost_usd=c)

    @app.get("/v1/usage", dependencies=[Depends(auth)])
    def usage(session: DB) -> dict:
        day, month = windows()
        day_requests, day_tokens = usage_since(session, day)
        month_requests, month_tokens = usage_since(session, month)
        recent = session.scalars(select(UsageLog).order_by(UsageLog.id.desc()).limit(20)).all()
        return {
            "provider": prov.name,
            "today": {"requests": day_requests, "tokens": day_tokens, "limit": s.daily_request_limit},
            "month": {"requests": month_requests, "tokens": month_tokens, "limit": s.monthly_token_limit},
            "recent": [
                {"at": r.at.isoformat(), "feature": r.feature, "model": r.model, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens, "cost_usd": r.cost_usd, "ok": r.ok, "error": r.error}
                for r in recent
            ],
        }

    @app.put("/v1/sync", dependencies=[Depends(auth)])
    async def put_sync(request: Request, session: DB) -> dict:
        raw = await request.body()
        if len(raw) > s.max_sync_bytes:
            raise HTTPException(413, "Backup is larger than this server accepts.")
        try:
            data = json.loads(raw)
        except ValueError as e:
            raise HTTPException(400, "Body must be JSON.") from e
        if not isinstance(data, dict) or data.get("format") != "job-copilot-backup":
            raise HTTPException(400, "Body is not a Job Copilot backup.")
        blob = session.get(SyncBlob, 1)
        text = raw.decode("utf-8")
        if blob is None:
            session.add(SyncBlob(id=1, data=text, size=len(raw)))
        else:
            blob.data, blob.size, blob.updated_at = text, len(raw), utcnow()
        session.commit()
        return {"ok": True, "size": len(raw)}

    @app.get("/v1/sync", dependencies=[Depends(auth)])
    def get_sync(session: DB) -> Response:
        blob = session.get(SyncBlob, 1)
        if blob is None:
            raise HTTPException(404, "No backup stored yet.")
        return Response(blob.data, media_type="application/json", headers={"Last-Modified": blob.updated_at.strftime("%a, %d %b %Y %H:%M:%S GMT")})

    @app.delete("/v1/sync", dependencies=[Depends(auth)])
    def delete_sync(session: DB) -> dict:
        blob = session.get(SyncBlob, 1)
        if blob is not None:
            session.delete(blob)
            session.commit()
        return {"ok": True}

    return app


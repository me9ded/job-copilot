from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Boolean, DateTime, Float, Integer, String, Text, create_engine, func, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class UsageLog(Base):
    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    feature: Mapped[str] = mapped_column(String(40))
    provider: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(120))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    ok: Mapped[bool] = mapped_column(Boolean, default=True)
    # Error category only; prompts and outputs are never stored.
    error: Mapped[str | None] = mapped_column(String(200), nullable=True)


class SyncBlob(Base):
    """The latest backup uploaded by the extension (single-user backend)."""

    __tablename__ = "sync_blob"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[str] = mapped_column(Text)
    size: Mapped[int] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite:///"):
        path = url.removeprefix("sqlite:///")
        if path and path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        return create_engine(url, connect_args={"check_same_thread": False})
    return create_engine(url, pool_pre_ping=True)


def make_sessionmaker(engine: Engine) -> sessionmaker[Session]:
    Base.metadata.create_all(engine)
    return sessionmaker(engine, expire_on_commit=False)


def usage_since(db: Session, since: datetime) -> tuple[int, int]:
    """(requests, tokens) for successful and failed calls since a moment."""
    row = db.execute(
        select(func.count(UsageLog.id), func.coalesce(func.sum(UsageLog.input_tokens + UsageLog.output_tokens), 0)).where(UsageLog.at >= since)
    ).one()
    return int(row[0]), int(row[1])

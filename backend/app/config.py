from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_token: str = Field(min_length=24, description="Bearer token the extension must send.")
    database_url: str = "sqlite:///./data/job_copilot.db"

    ai_provider: Literal["mock", "anthropic", "openai", "ollama"] = "mock"

    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5-5"
    anthropic_effort: Literal["low", "medium", "high", "xhigh", "max"] = "low"

    openai_api_key: str = ""
    openai_base_url: str = "https://api.openai.com"
    openai_model: str = ""

    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1:8b"

    daily_request_limit: int = Field(200, ge=0)
    monthly_token_limit: int = Field(2_000_000, ge=0)
    max_input_chars: int = Field(60_000, ge=1_000)
    max_output_tokens: int = Field(4_000, ge=64)
    request_timeout_seconds: float = Field(120, gt=0)
    max_sync_bytes: int = Field(20_000_000, ge=1_000)

    price_input_per_mtok: float = Field(0, ge=0)
    price_output_per_mtok: float = Field(0, ge=0)

    @field_validator("app_token")
    @classmethod
    def _not_placeholder(cls, v: str) -> str:
        if v.lower() in {"change-me", "changeme", "replace-me"} or len(set(v)) < 8:
            raise ValueError("APP_TOKEN looks like a placeholder; generate a random token")
        return v

    def check_provider(self) -> None:
        """Fail fast at startup instead of on the first request."""
        if self.ai_provider == "anthropic" and not self.anthropic_api_key:
            raise ValueError("AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY")
        if self.ai_provider == "openai" and not (self.openai_api_key and self.openai_model):
            raise ValueError("AI_PROVIDER=openai requires OPENAI_API_KEY and OPENAI_MODEL")


@lru_cache
def get_settings() -> Settings:
    s = Settings()  # type: ignore[call-arg]
    s.check_provider()
    return s

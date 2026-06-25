import os
import warnings
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

_LEGACY = {"fake": "replay", "openrouter": "live", "real": "live"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    mongo_url: str = "mongodb://localhost:27017"
    mongo_db: str = "bloom_studio"
    openrouter_api_key: str = ""
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    default_model: str = "openai/gpt-4o-mini"
    available_models: str = "openai/gpt-4o-mini,meta-llama/llama-3.2-3b-instruct:free"
    provider_mode: Literal["live", "replay"] = "live"
    replay_token_delay: float = 0.0
    comfyui_url: str = "http://127.0.0.1:8188"
    media_dir: str = "var/media"
    simulator_bin: str = ""  # optional path to a prebuilt curate_json; "" => cargo run
    tuner_bin: str = ""  # optional path to a prebuilt tune_json; "" => cargo run
    skills_dir: str = str(
        (__import__("pathlib").Path(__file__).resolve().parents[3] / "skills")
    )


def _apply_legacy(settings: Settings) -> Settings:
    raws = [os.environ.get("LLM_BACKEND"), os.environ.get("COMFY_BACKEND")]
    mapped = {_LEGACY[r.lower()] for r in raws if r and r.lower() in _LEGACY}
    if not mapped:
        return settings
    warnings.warn(
        "LLM_BACKEND/COMFY_BACKEND are deprecated; use PROVIDER_MODE=live|replay",
        DeprecationWarning,
        stacklevel=2,
    )
    mode = "replay" if "replay" in mapped else "live"
    return settings.model_copy(update={"provider_mode": mode})


def get_settings() -> Settings:
    return _apply_legacy(Settings())

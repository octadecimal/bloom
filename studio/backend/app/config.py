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
    default_model: str = "openai/gpt-5.5"
    # Vision composition critic (Plan 2). Direct structured+image call via the
    # SceneCritic seam — an OpenRouter slug, tunable without code changes. See
    # docs/.../vision-in-the-loop-scene-composition-design.md (decided: sonnet-4-6).
    critic_model: str = "anthropic/claude-sonnet-4-6"
    # Short timeout for the real-frame capture used by the art/effects grade
    # (sub-project B). A live browser client answers in well under a second; the
    # short bound lets a HEADLESS rebuild (no client) fail fast and skip the art
    # stage instead of blocking on the broker's 10s default.
    art_capture_timeout: float = 3.0
    available_models: str = "openai/gpt-5.5,openai/gpt-4o-mini,meta-llama/llama-3.2-3b-instruct:free"
    provider_mode: Literal["live", "replay"] = "live"
    replay_token_delay: float = 0.0
    comfyui_url: str = "http://127.0.0.1:8188"
    upscale_model: str = "4x-UltraSharp.pth"  # filename in ComfyUI/models/upscale_models
    media_dir: str = "var/media"
    simulator_bin: str = ""  # optional path to a prebuilt curate_json; "" => cargo run
    tuner_bin: str = ""  # optional path to a prebuilt tune_json; "" => cargo run
    # Runaway-guard for the curation subprocess (a numerically-degenerate model can
    # drive the kernel's free-spins retrigger into unbounded memory — see
    # docs/superpowers/followups/2026-06-25-unbounded-free-spins-retrigger.md).
    # The watchdog hard-kills the process tree if either bound is crossed.
    curation_mem_cap_mb: float = 1024.0  # resident-memory cap for the proc tree
    curation_timeout_s: float = 120.0  # wall-clock cap (backstop)
    tuner_mem_cap_mb: float = 4096.0  # resident-memory cap for the tuner proc tree
    # (honest cargo-run tunes can approach ~1.2 GiB; 4 GiB gives headroom while
    #  still catching unbounded runaways that grow to many GB)
    tuner_timeout_s: float = 120.0  # wall-clock cap (backstop)
    compose_bin: str = ""  # optional path to a prebuilt compose_json; "" => cargo run
    compose_timeout_s: float = 180.0
    packages_dir: str = "var/packages"  # repo-root-relative; runtime server dir mode reads it
    runtime_server_url: str = ""  # "" => http://localhost:{9000+BLOOM_PORT_OFFSET}; e2e replay backend points at the 9300-family server
    asset_regen_retries: int = 2        # max regenerate->re-judge cycles (matches ComposeBounds)
    asset_floor_regen_budget: int = 2   # bounded regen budget for an ad-hoc direct generate
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

# Test/real Environment Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the degenerate fake providers (`echo:`, 1×1 PNG) with recorded-real "replay" fixtures, make the active provider mode honest and visible end-to-end, and assert real output in the e2e suite — so the test and user environments stay in parity and nobody can be silently handed a fake stack.

**Architecture:** Both external-provider seams already expose a `Protocol` + `build_provider(settings)` factory. We collapse the two mode knobs into one `provider_mode: "live" | "replay"`, swap each degenerate fake for a `Replay*Provider` that serves real captured output, surface the mode on `/health` + an in-app badge + a serve preflight, add a durable chat error affordance, and tighten the e2e to assert realness. A small `record-fixtures` step regenerates cassettes from the live providers.

**Tech Stack:** Python 3.12 / FastAPI / pydantic-settings / python-socketio / httpx / websockets (backend); React 18 / hookstate / Vite / Vitest / Testing-Library (frontend); Playwright (e2e); `just` recipes; `uv` for Python.

## Global Constraints

- **Commits:** Conventional Commits, imperative mood (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`). Branch off `main` (protected); land via squash PR.
- **Commit trailers:** every commit ends with the two lines:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01SBdVTfLwCZhiY1QDuQzRzt`.
- **TDD mandatory:** RED → GREEN → REFACTOR. Write the failing test first, watch it fail, then minimal code.
- **TS interfaces use an `I` prefix** (`IHealth`, `IModeBadgeProps`). (docs/coding-standards.md)
- **Wire models are camelCase** — the health field is `providerMode` (not `provider_mode`) over the wire.
- **Prettier is a CI gate** — run `npx prettier --write <changed files>` before every commit that touches JS/TS/MD/JSON.
- **Frontend pre-push gates** (run all four before any PR): `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`.
- **Playwright is NOT in CI** (cost) — e2e is local/on-demand and remains the behavioural source of truth. (AGENTS.md)
- **Provider mode default is `live`** — the safe default for a human.
- **Error sentinel model id:** `bloom/force-error` — recognised by the replay LLM provider (raises) and invalid for live OpenRouter (also raises). Drives the error-path test identically in both tiers.
- **Cassette location:** `studio/backend/tests/fixtures/replay/` (`llm/*.json`, `comfy/default.json` + `comfy/default.png`). Committed.
- **Run backend tests:** from `studio/backend`, `uv run pytest -m "not e2e"` (or a specific file). **Run frontend unit tests:** from repo root, `npx nx test frontend`. **Run e2e:** `npx playwright test --config=studio/frontend/playwright.config.ts <file>`.

---

### Task 1: Unify provider config to one `provider_mode` knob

**Files:**

- Modify: `studio/backend/app/config.py`
- Modify: `studio/backend/.env`, `studio/backend/.env.example`
- Test: `studio/backend/tests/test_config.py` (create)

**Interfaces:**

- Produces: `Settings.provider_mode: Literal["live","replay"]` (default `"live"`); `Settings.replay_token_delay: float` (default `0.0`); `get_settings()` applies legacy `LLM_BACKEND`/`COMFY_BACKEND` mapping (`fake→replay`, `openrouter|real→live`) with a `DeprecationWarning`, choosing `replay` if any legacy var maps to replay. Retains: `openrouter_api_key`, `openrouter_base_url`, `default_model`, `available_models`, `comfyui_url`, `media_dir`, `mongo_url`, `mongo_db`. Removes: `llm_backend`, `comfy_backend`, `fake_token_delay`.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_config.py
import warnings
from app.config import Settings, get_settings


def test_default_mode_is_live():
    assert Settings().provider_mode == "live"


def test_legacy_fake_maps_to_replay(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "fake")
    monkeypatch.setenv("COMFY_BACKEND", "fake")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert get_settings().provider_mode == "replay"


def test_legacy_openrouter_maps_to_live(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "openrouter")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert get_settings().provider_mode == "live"


def test_legacy_emits_deprecation_warning(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "fake")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        get_settings()
    assert any(issubclass(w.category, DeprecationWarning) for w in caught)


def test_disagreement_prefers_replay(monkeypatch):
    monkeypatch.setenv("LLM_BACKEND", "openrouter")  # live
    monkeypatch.setenv("COMFY_BACKEND", "fake")       # replay
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        assert get_settings().provider_mode == "replay"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_config.py -v`
Expected: FAIL (`provider_mode` doesn't exist / `get_settings` ignores legacy vars).

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/config.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_config.py -v`
Expected: PASS (5 tests).

- [ ] **Step 5: Update env files**

In `studio/backend/.env` and `.env.example`, replace the `LLM_BACKEND=...`, `COMFY_BACKEND` (if present), and `FAKE_TOKEN_DELAY=...` lines with:

```
# Provider mode: "live" = real OpenRouter + real ComfyUI; "replay" = recorded-real fixtures (offline, deterministic).
PROVIDER_MODE=live
REPLAY_TOKEN_DELAY=0.0
```

Keep the existing `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `DEFAULT_MODEL`, `AVAILABLE_MODELS`, `MONGO_*`, and `COMFYUI_URL` lines.

- [ ] **Step 6: Run full backend unit suite (expect references to the removed fields to fail — that's Tasks 4 & 5)**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: failures only in `test_providers.py` / `test_comfy.py` (they reference `llm_backend`/`comfy_backend`). Note them; they are fixed in Tasks 4–5. All other tests pass.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/config.py studio/backend/tests/test_config.py studio/backend/.env studio/backend/.env.example
git commit  # message: "refactor(backend): unify provider config into provider_mode (live|replay)"
```

---

### Task 2: `/health` reports the active provider mode

**Files:**

- Modify: `studio/backend/app/rest.py:15-17`
- Test: `studio/backend/tests/test_health.py`

**Interfaces:**

- Consumes: `request.app.state.settings.provider_mode` (set in `app/main.py:61`).
- Produces: `GET /health` → `{"status": "ok", "providerMode": "live"|"replay"}`.

- [ ] **Step 1: Write the failing test** (append to `tests/test_health.py`)

```python
def test_health_reports_provider_mode():
    from fastapi.testclient import TestClient
    from app.config import Settings
    from app.main import build

    ctx = build(Settings(provider_mode="replay"))
    client = TestClient(ctx.fastapi_app)
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["providerMode"] == "replay"
```

(If `test_health.py`'s existing test already builds an app/client, mirror its construction instead of the snippet above — keep one construction style in the file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_health.py -v`
Expected: FAIL (`KeyError: 'providerMode'`).

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/rest.py  — replace the health() handler
@router.get("/health")
async def health(request: Request) -> dict:
    settings = request.app.state.settings
    return {"status": "ok", "providerMode": settings.provider_mode}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_health.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/rest.py studio/backend/tests/test_health.py
git commit  # message: "feat(backend): expose providerMode on /health"
```

---

### Task 3: Cassette load helpers (`app/replay/`)

**Files:**

- Create: `studio/backend/app/replay/__init__.py`
- Create: `studio/backend/app/replay/cassette.py`
- Test: `studio/backend/tests/test_replay.py` (create)

**Interfaces:**

- Produces:
  - `DEFAULT_FIXTURES_DIR: Path` = `studio/backend/tests/fixtures/replay`
  - `normalize_prompt(text: str) -> str` (lowercased, stripped, internal whitespace collapsed)
  - `load_llm_cassettes(dir: Path) -> dict[str, list[str]]` — maps `normalize_prompt(prompt)` → ordered chunk list, loaded from every `dir/llm/*.json` (`{"prompt": str, "chunks": [str,...]}`). The file named `default.json` is also stored under the key `"__default__"`.
  - `load_comfy_cassette(dir: Path) -> tuple[list[tuple[int,int]], bytes]` — reads `dir/comfy/default.json` (`{"progress": [[v,max],...], "image": "default.png"}`) and the referenced PNG bytes.

- [ ] **Step 1: Write the failing test**

```python
# studio/backend/tests/test_replay.py
import json
from app.replay.cassette import (
    normalize_prompt, load_llm_cassettes, load_comfy_cassette,
)


def test_normalize_prompt_collapses_ws():
    assert normalize_prompt("  Hello   There  ") == "hello there"


def test_load_llm_cassettes_keys_by_prompt_and_default(tmp_path):
    d = tmp_path / "llm"
    d.mkdir()
    (d / "greet.json").write_text(json.dumps({"prompt": "Hi there", "chunks": ["Hi", " back"]}))
    (d / "default.json").write_text(json.dumps({"prompt": "anything", "chunks": ["Sure", "."]}))
    cas = load_llm_cassettes(tmp_path)
    assert cas[normalize_prompt("Hi there")] == ["Hi", " back"]
    assert cas["__default__"] == ["Sure", "."]


def test_load_comfy_cassette(tmp_path):
    c = tmp_path / "comfy"
    c.mkdir()
    (c / "default.png").write_bytes(b"\x89PNG\r\n\x1a\n" + b"x" * 100)
    (c / "default.json").write_text(json.dumps({"progress": [[1, 2], [2, 2]], "image": "default.png"}))
    progress, image = load_comfy_cassette(tmp_path)
    assert progress == [(1, 2), (2, 2)]
    assert image.startswith(b"\x89PNG")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_replay.py -v`
Expected: FAIL (module `app.replay.cassette` not found).

- [ ] **Step 3: Write minimal implementation**

```python
# studio/backend/app/replay/__init__.py
```

```python
# studio/backend/app/replay/cassette.py
import json
import re
from pathlib import Path

DEFAULT_FIXTURES_DIR = Path(__file__).resolve().parent.parent.parent / "tests" / "fixtures" / "replay"


def normalize_prompt(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def load_llm_cassettes(fixtures_dir: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    llm_dir = fixtures_dir / "llm"
    for path in sorted(llm_dir.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        out[normalize_prompt(data["prompt"])] = list(data["chunks"])
        if path.name == "default.json":
            out["__default__"] = list(data["chunks"])
    return out


def load_comfy_cassette(fixtures_dir: Path) -> tuple[list[tuple[int, int]], bytes]:
    comfy_dir = fixtures_dir / "comfy"
    meta = json.loads((comfy_dir / "default.json").read_text(encoding="utf-8"))
    progress = [(int(v), int(m)) for v, m in meta["progress"]]
    image = (comfy_dir / meta["image"]).read_bytes()
    return progress, image
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_replay.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/replay/ studio/backend/tests/test_replay.py
git commit  # message: "feat(backend): add replay cassette load helpers"
```

---

### Task 4: Replay LLM provider + live rename + mode factory

**Files:**

- Modify: `studio/backend/app/providers.py`
- Test: `studio/backend/tests/test_providers.py`

**Interfaces:**

- Consumes: `Settings.provider_mode`, `Settings.replay_token_delay`, `load_llm_cassettes`, `normalize_prompt`, `DEFAULT_FIXTURES_DIR`.
- Produces: `ERROR_SENTINEL_MODEL = "bloom/force-error"`; `LiveOpenRouterProvider` (renamed from `LangchainOpenRouterProvider`); `ReplayLLMProvider(cassettes: dict[str, list[str]], delay: float = 0.0)` whose `stream(turns, model)` raises `RuntimeError` if `model == ERROR_SENTINEL_MODEL`, else yields the chunks for the last turn's normalized prompt (falling back to `"__default__"`); `build_provider(settings)` returns `ReplayLLMProvider` when `provider_mode == "replay"` else `LiveOpenRouterProvider`.

- [ ] **Step 1: Write the failing tests** (replace the `FakeProvider` tests; keep any live-provider construction test)

```python
# studio/backend/tests/test_providers.py
import pytest
from app.config import Settings
from app.providers import (
    ReplayLLMProvider, LiveOpenRouterProvider, build_provider, ERROR_SENTINEL_MODEL,
)

CASSETTES = {"hi there": ["Hi", " back"], "__default__": ["Sure", " thing"]}


async def _collect(provider, turns, model):
    return "".join([c async for c in provider.stream(turns, model)])


async def test_replay_returns_recorded_chunks_not_echo():
    p = ReplayLLMProvider(CASSETTES)
    out = await _collect(p, [{"role": "user", "content": "Hi there"}], "m")
    assert out == "Hi back"
    assert not out.startswith("echo:")


async def test_replay_falls_back_to_default():
    p = ReplayLLMProvider(CASSETTES)
    out = await _collect(p, [{"role": "user", "content": "unknown prompt"}], "m")
    assert out == "Sure thing"


async def test_replay_raises_on_sentinel_model():
    p = ReplayLLMProvider(CASSETTES)
    with pytest.raises(RuntimeError):
        await _collect(p, [{"role": "user", "content": "x"}], ERROR_SENTINEL_MODEL)


def test_factory_selects_by_mode():
    assert isinstance(build_provider(Settings(provider_mode="replay")), ReplayLLMProvider)
    assert isinstance(build_provider(Settings(provider_mode="live")), LiveOpenRouterProvider)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_providers.py -v`
Expected: FAIL (`ReplayLLMProvider` / `ERROR_SENTINEL_MODEL` not defined).

- [ ] **Step 3: Write minimal implementation** (rewrite `providers.py`)

```python
# studio/backend/app/providers.py
import asyncio
from typing import AsyncIterator, Protocol

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR, load_llm_cassettes, normalize_prompt,
)

ERROR_SENTINEL_MODEL = "bloom/force-error"


class LLMProvider(Protocol):
    def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]: ...


class ReplayLLMProvider:
    """Replays recorded-real streamed completions captured from the live provider."""

    def __init__(self, cassettes: dict[str, list[str]], delay: float = 0.0):
        self._cassettes = cassettes
        self._delay = delay

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        if model == ERROR_SENTINEL_MODEL:
            raise RuntimeError("forced replay error (sentinel model)")
        last = turns[-1]["content"] if turns else ""
        chunks = self._cassettes.get(normalize_prompt(last)) or self._cassettes.get("__default__") or []
        for chunk in chunks:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield chunk


class LiveOpenRouterProvider:
    """Streams via langchain-openai's ChatOpenAI pointed at OpenRouter."""

    def __init__(self, api_key: str, base_url: str):
        self._api_key = api_key
        self._base_url = base_url

    async def stream(self, turns: list[dict], model: str) -> AsyncIterator[str]:
        from langchain_core.messages import AIMessage, HumanMessage
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=model, api_key=self._api_key, base_url=self._base_url, streaming=True)
        lc_messages = [
            HumanMessage(t["content"]) if t["role"] == "user" else AIMessage(t["content"])
            for t in turns
        ]
        async for chunk in llm.astream(lc_messages):
            text = chunk.content
            if text:
                yield text


def build_provider(settings: Settings) -> LLMProvider:
    if settings.provider_mode == "replay":
        return ReplayLLMProvider(
            load_llm_cassettes(DEFAULT_FIXTURES_DIR),
            delay=settings.replay_token_delay,
        )
    return LiveOpenRouterProvider(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_providers.py -v`
Expected: PASS. (The factory `replay` branch calls `load_llm_cassettes(DEFAULT_FIXTURES_DIR)`; if the real fixtures dir is empty until Task 6, the factory still constructs — `load_llm_cassettes` returns `{}` for a missing/empty dir. Add the `llm/` dir now if needed: `mkdir -p studio/backend/tests/fixtures/replay/llm`.)

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/providers.py studio/backend/tests/test_providers.py
git commit  # message: "feat(backend): replace FakeProvider with recorded-real ReplayLLMProvider"
```

---

### Task 5: Replay Comfy provider + live rename + mode factory

**Files:**

- Modify: `studio/backend/app/assets/comfy.py`
- Test: `studio/backend/tests/test_comfy.py`

**Interfaces:**

- Consumes: `Settings.provider_mode`, `load_comfy_cassette`, `DEFAULT_FIXTURES_DIR`.
- Produces: `LiveComfyProvider` (renamed from `RealComfyProvider`); `ReplayComfyProvider(progress: list[tuple[int,int]], image: bytes, delay: float = 0.05)` whose `generate(graph)` yields the recorded `ProgressEvent`s then one `ImageEvent`; `build_provider(settings)` returns `ReplayComfyProvider` when `provider_mode == "replay"` else `LiveComfyProvider`.

- [ ] **Step 1: Write the failing tests** (replace the `FakeComfyProvider` tests)

```python
# studio/backend/tests/test_comfy.py
from app.config import Settings
from app.assets.comfy import (
    ReplayComfyProvider, LiveComfyProvider, ProgressEvent, ImageEvent, build_provider,
)

REAL_PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 500


async def test_replay_yields_recorded_progress_then_image():
    p = ReplayComfyProvider(progress=[(1, 2), (2, 2)], image=REAL_PNG, delay=0.0)
    events = [e async for e in p.generate({})]
    assert [type(e) for e in events] == [ProgressEvent, ProgressEvent, ImageEvent]
    assert events[-1].data == REAL_PNG
    assert len(events[-1].data) > 70  # not the old 1x1 fake


def test_factory_selects_by_mode(tmp_path, monkeypatch):
    # live branch needs no fixtures
    assert isinstance(build_provider(Settings(provider_mode="live")), LiveComfyProvider)
```

(Add a replay-factory assertion only after Task 6 commits real fixtures, or point `build_provider`'s replay branch at a tmp dir in a separate test; keep this task's factory test to the `live` branch to avoid depending on un-recorded fixtures.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_comfy.py -v`
Expected: FAIL (`ReplayComfyProvider` not defined).

- [ ] **Step 3: Write minimal implementation** (edit `comfy.py`: delete `FAKE_PNG` + `FakeComfyProvider`, rename `RealComfyProvider`→`LiveComfyProvider`, add `ReplayComfyProvider`, rewrite `build_provider`)

```python
# at top of comfy.py, drop the base64 import + FAKE_PNG constant.
# keep ProgressEvent, ImageEvent, ComfyEvent, ComfyProvider Protocol unchanged.

class ReplayComfyProvider:
    """Replays a recorded-real generation: captured progress ticks then a real PNG."""

    def __init__(self, progress: list[tuple[int, int]], image: bytes, delay: float = 0.05):
        self._progress = progress
        self._image = image
        self._delay = delay

    async def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]:
        import asyncio
        for value, maximum in self._progress:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield ProgressEvent(value=value, max=maximum)
        yield ImageEvent(data=self._image)


# rename class RealComfyProvider -> LiveComfyProvider (body unchanged)

def build_provider(settings) -> ComfyProvider:
    from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_comfy_cassette
    if settings.provider_mode == "replay":
        progress, image = load_comfy_cassette(DEFAULT_FIXTURES_DIR)
        return ReplayComfyProvider(progress=progress, image=image, delay=0.05)
    return LiveComfyProvider(base_url=settings.comfyui_url)
```

Also update the import + signature: `def build_provider(settings: Settings) -> ComfyProvider:` and ensure `from app.config import Settings` stays.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_comfy.py -v`
Expected: PASS. (`main.py` imports `build_provider as build_comfy_provider` — name unchanged, so app still boots.)

- [ ] **Step 5: Run full non-e2e suite**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS (config refs to old fields are gone).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/assets/comfy.py studio/backend/tests/test_comfy.py
git commit  # message: "feat(backend): replace FakeComfyProvider with recorded-real ReplayComfyProvider"
```

---

### Task 6: Recording tooling + capture & commit real cassettes

**Files:**

- Create: `studio/backend/app/replay/record.py`
- Create (by running): `studio/backend/tests/fixtures/replay/llm/default.json`, `studio/backend/tests/fixtures/replay/comfy/default.json`, `studio/backend/tests/fixtures/replay/comfy/default.png`
- Modify: `justfile`
- Test: `studio/backend/tests/test_fixtures_committed.py` (create)

**Interfaces:**

- Consumes: `LiveOpenRouterProvider`, `LiveComfyProvider`, `build_graph`.
- Produces: `python -m app.replay.record` writes the three fixture files by calling the **live** providers once (needs `OPENROUTER_API_KEY` + ComfyUI up on `:8188`). Records the LLM `default.json` for the prompt `"Reply with exactly: PONG"` and the Comfy `default` at 512×512 via workflow `schnell-transparent`.

- [ ] **Step 1: Write the record script**

```python
# studio/backend/app/replay/record.py
import asyncio
import json
from pathlib import Path

from app.assets.comfy import ImageEvent, LiveComfyProvider, ProgressEvent
from app.assets.graph import build_graph
from app.config import get_settings
from app.providers import LiveOpenRouterProvider
from app.replay.cassette import DEFAULT_FIXTURES_DIR

LLM_PROMPT = "Reply with exactly: PONG"
COMFY_DIMS = (512, 512)
COMFY_WORKFLOW = "schnell-transparent"


async def _record_llm(settings, out: Path) -> None:
    provider = LiveOpenRouterProvider(settings.openrouter_api_key, settings.openrouter_base_url)
    chunks = [c async for c in provider.stream([{"role": "user", "content": LLM_PROMPT}], settings.default_model)]
    out.mkdir(parents=True, exist_ok=True)
    (out / "default.json").write_text(json.dumps({"prompt": LLM_PROMPT, "chunks": chunks}, indent=2))
    print(f"LLM cassette: {len(chunks)} chunks -> {''.join(chunks)!r}")


async def _record_comfy(settings, out: Path) -> None:
    provider = LiveComfyProvider(base_url=settings.comfyui_url)
    graph = build_graph(COMFY_WORKFLOW, "a glowing wild slot symbol, neon", *COMFY_DIMS, 42)
    progress: list[list[int]] = []
    image = b""
    async for ev in provider.generate(graph):
        if isinstance(ev, ProgressEvent):
            progress.append([ev.value, ev.max])
        elif isinstance(ev, ImageEvent):
            image = ev.data
    out.mkdir(parents=True, exist_ok=True)
    (out / "default.png").write_bytes(image)
    (out / "default.json").write_text(json.dumps({"progress": progress, "image": "default.png"}, indent=2))
    print(f"Comfy cassette: {len(progress)} ticks, {len(image)} image bytes")


async def main() -> None:
    settings = get_settings()
    await _record_llm(settings, DEFAULT_FIXTURES_DIR / "llm")
    await _record_comfy(settings, DEFAULT_FIXTURES_DIR / "comfy")


if __name__ == "__main__":
    asyncio.run(main())
```

- [ ] **Step 2: Add the justfile recipe**

```
# Regenerate recorded-real replay fixtures from the LIVE providers.
# Requires OPENROUTER_API_KEY in .env and ComfyUI running on :8188.
record-fixtures:
    cd studio/backend && PROVIDER_MODE=live uv run python -m app.replay.record
```

- [ ] **Step 3: Run the recorder against live providers**

Pre-req: ComfyUI up (`run_api.bat`), `.env` has a real `OPENROUTER_API_KEY`, MongoDB not required.
Run: `just record-fixtures`
Expected: prints a non-`echo:` LLM reply and a Comfy image of tens of KB; writes the three fixture files.

- [ ] **Step 4: Write the failing test asserting fixtures are real & committed**

```python
# studio/backend/tests/test_fixtures_committed.py
from app.replay.cassette import DEFAULT_FIXTURES_DIR, load_comfy_cassette, load_llm_cassettes


def test_llm_default_cassette_is_real():
    cas = load_llm_cassettes(DEFAULT_FIXTURES_DIR)
    assert "__default__" in cas
    text = "".join(cas["__default__"])
    assert text and not text.startswith("echo:")


def test_comfy_default_cassette_is_a_real_png():
    progress, image = load_comfy_cassette(DEFAULT_FIXTURES_DIR)
    assert image.startswith(b"\x89PNG")
    assert len(image) > 5_000  # a real generation, not the old ~70-byte 1x1
    assert len(progress) >= 1
```

- [ ] **Step 5: Run test to verify it passes** (fails first if Step 3 wasn't run)

Run: `cd studio/backend && uv run pytest tests/test_fixtures_committed.py -v`
Expected: PASS.

- [ ] **Step 6: Confirm fixtures are not gitignored, then commit**

Run: `git check-ignore studio/backend/tests/fixtures/replay/comfy/default.png || echo "not ignored"`
Expected: `not ignored`. (If ignored, add a negation to `.gitignore`.)

```bash
git add studio/backend/app/replay/record.py studio/backend/tests/fixtures/replay/ studio/backend/tests/test_fixtures_committed.py justfile
git commit  # message: "feat(backend): record-fixtures tooling + committed recorded-real cassettes"
```

---

### Task 7: Frontend mode badge (LIVE / REPLAY) from `/health`

**Files:**

- Create: `studio/frontend/src/host/health.ts`
- Create: `studio/frontend/src/app/ModeBadge.tsx`
- Create: `studio/frontend/src/app/ModeBadge.spec.tsx`
- Modify: `studio/frontend/src/app/Workbench.tsx:23-26`

**Interfaces:**

- Produces: `IHealth { status: string; providerMode: 'live' | 'replay' }`; `getHealth(): Promise<IHealth>`; `<ModeBadge />` rendering `<span data-testid="mode-badge" data-mode={mode}>` showing `LIVE`/`REPLAY` (and `data-mode="unknown"` before load / on error).

- [ ] **Step 1: Write the failing test**

```tsx
// studio/frontend/src/app/ModeBadge.spec.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModeBadge } from './ModeBadge';

afterEach(() => vi.restoreAllMocks());

describe('ModeBadge', () => {
  it('shows REPLAY when /health reports replay mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok', providerMode: 'replay' }), { status: 200 }));
    render(<ModeBadge />);
    await waitFor(() => expect(screen.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'replay'));
    expect(screen.getByTestId('mode-badge')).toHaveTextContent(/replay/i);
  });

  it('shows LIVE when /health reports live mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok', providerMode: 'live' }), { status: 200 }));
    render(<ModeBadge />);
    await waitFor(() => expect(screen.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'live'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- ModeBadge`
Expected: FAIL (module not found).

- [ ] **Step 3: Write minimal implementation**

```ts
// studio/frontend/src/host/health.ts
const BACKEND_URL: string = (import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';

export interface IHealth {
  status: string;
  providerMode: 'live' | 'replay';
}

export async function getHealth(): Promise<IHealth> {
  const res = await fetch(`${BACKEND_URL}/health`);
  if (!res.ok) throw new Error(`health ${res.status}`);
  return (await res.json()) as IHealth;
}
```

```tsx
// studio/frontend/src/app/ModeBadge.tsx
import { useEffect, useState } from 'react';
import { getHealth } from '../host/health';

export function ModeBadge() {
  const [mode, setMode] = useState<'live' | 'replay' | 'unknown'>('unknown');

  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => alive && setMode(h.providerMode))
      .catch(() => alive && setMode('unknown'));
    return () => {
      alive = false;
    };
  }, []);

  const isReplay = mode === 'replay';
  return (
    <span
      data-testid="mode-badge"
      data-mode={mode}
      title={isReplay ? 'Recorded-real fixtures — not live providers' : 'Live providers'}
      style={{
        fontSize: '0.7rem',
        fontWeight: 600,
        padding: '2px 6px',
        borderRadius: 4,
        textTransform: 'uppercase',
        background: isReplay ? '#a3551b' : '#1b5e20',
        color: 'white',
      }}
    >
      {mode === 'unknown' ? '…' : mode}
    </span>
  );
}
```

- [ ] **Step 4: Wire it into the chrome** (`Workbench.tsx`, right-hand header div)

```tsx
import { ModeBadge } from './ModeBadge';
// ...
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <ModeBadge />
  <SwitchUser />
  <ThemeToggle />
</div>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx nx test frontend -- ModeBadge`
Expected: PASS.

- [ ] **Step 6: Prettier + commit**

```bash
npx prettier --write studio/frontend/src/host/health.ts studio/frontend/src/app/ModeBadge.tsx studio/frontend/src/app/ModeBadge.spec.tsx studio/frontend/src/app/Workbench.tsx
git add studio/frontend/src/host/health.ts studio/frontend/src/app/ModeBadge.tsx studio/frontend/src/app/ModeBadge.spec.tsx studio/frontend/src/app/Workbench.tsx
git commit  # message: "feat(studio): mode badge (LIVE/REPLAY) from /health"
```

---

### Task 8: Durable chat error affordance

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/state.ts`
- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.ts:24-28,60-63`
- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts` (extend existing)

**Interfaces:**

- Produces: `ILlmChatState.lastError: string | null` (initial `null`); socket `error` handler sets `chatSlice().lastError.set(message)` (in addition to the existing toast); `message_created` for the active room clears it (`lastError.set(null)`); `ChatRoomPane` renders `<div data-testid="chat-error" role="alert">` when `lastError` is non-null and a room is active.

- [ ] **Step 1: Write the failing test** (add to `socketClient.spec.ts`; mirror its existing fake-socket harness)

```ts
it('sets lastError on socket error and clears it on the next message_created', () => {
  // ... using the file's existing helper that builds a fake ISocketLike and active room ...
  emit('error', { roomId: ACTIVE, message: 'generation failed' });
  expect(chatSlice().lastError.get()).toBe('generation failed');

  emit('message_created', { message: makeMessage({ roomId: ACTIVE }) });
  expect(chatSlice().lastError.get()).toBeNull();
});
```

(If `socketClient.spec.ts` lacks an `emit(event, payload)` helper that invokes a registered handler, add one mirroring how the file already drives `message_created`/`token` in its existing tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- socketClient`
Expected: FAIL (`lastError` undefined).

- [ ] **Step 3: Implement state + handler + render**

`state.ts` — add field + initial value:

```ts
// in ILlmChatState
  lastError: string | null;
// in makeInitialState(...)
    lastError: null,
```

`socketClient.ts` — clear on `message_created`, set on `error`:

```ts
s.on('message_created', (p) => {
  const { message } = p as { message: IMessage };
  if (!isActive(message.roomId)) return;
  slice().lastError.set(null);
  slice().messages.set(upsertMessage(read(), message));
});
// ...
s.on('error', (p) => {
  const { message } = p as { message: string };
  slice().lastError.set(message ?? 'chat error');
  notify.error(message ?? 'chat error');
});
```

`ChatRoomPane.tsx` — render a banner (add inside the room pane, above `MessageList`):

```tsx
function ErrorBanner() {
  const s = llmChatHooks.usePluginState();
  const err = s.lastError.get();
  if (!err) return null;
  return (
    <div data-testid="chat-error" role="alert" style={{ color: '#b00020', fontSize: '0.85rem' }}>
      ⚠ {err}
    </div>
  );
}
// ...inside ChatRoomPane's returned tree, after <PresenceLine /> and before <MessageList />:
<ErrorBanner />;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend -- socketClient`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/socketClient.spec.ts
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/socketClient.spec.ts
git commit  # message: "feat(studio): durable chat error banner (data-testid=chat-error)"
```

---

### Task 9: Strengthen chat & assets e2e to assert realness

**Files:**

- Modify: `studio/frontend/e2e/llm-chat.spec.ts:24-36`
- Modify: `studio/frontend/e2e/assets.spec.ts:39-58`

**Interfaces:**

- Consumes: a running backend (replay or live) + frontend. The chat cassette default reply (from Task 6) for `"Reply with exactly: PONG"` is `PONG`-ish; the comfy cassette is a 512×512 real PNG.

- [ ] **Step 1: Strengthen the chat assertion** — replace the prompt + assertions in the first `llm-chat.spec.ts` test:

```ts
await page.getByTestId('chat-composer').fill('Reply with exactly: PONG');
await page.getByTestId('chat-send').click();

await expect(page.getByTestId('chat-messages')).toContainText('Reply with exactly: PONG');
const assistant = page.locator('[data-role="assistant"]').last();
await expect(assistant).toHaveAttribute('data-status', 'complete', { timeout: 15_000 });
const text = (await assistant.textContent())?.toLowerCase() ?? '';
expect(text).not.toContain('echo:'); // would catch the degenerate fake
expect(text).toContain('pong'); // real (or recorded-real) answer
```

- [ ] **Step 2: Strengthen the assets assertion** — in `assets.spec.ts`, ensure `addAsset` requests 512×512 (matching the cassette) and assert real dimensions. Update `addAsset` to set explicit size if the form exposes width/height; otherwise rely on the asset default. Replace the image assertion:

```ts
await page.getByRole('button', { name: 'Generate' }).click();
await expect(page.getByTestId('asset-progress')).toBeVisible();
const img = page.getByTestId('asset-selected-image');
await expect(img).toBeVisible({ timeout: 30_000 });
// Real image, not a 1x1 fake: natural dimensions are substantial.
await expect(async () => {
  const w = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
  const h = await img.evaluate((el) => (el as HTMLImageElement).naturalHeight);
  expect(w).toBeGreaterThan(64);
  expect(h).toBeGreaterThan(64);
}).toPass({ timeout: 30_000 });
```

- [ ] **Step 3: Run against a replay backend**

Start backend in replay mode, then run:

```bash
# terminal 1:
cd studio/backend && PROVIDER_MODE=replay uv run uvicorn app.main:app --port 8000
# terminal 2:
npx playwright test --config=studio/frontend/playwright.config.ts llm-chat assets
```

Expected: PASS — chat reply contains `pong` and not `echo:`; asset image natural dims > 64.

- [ ] **Step 4: Commit**

```bash
npx prettier --write studio/frontend/e2e/llm-chat.spec.ts studio/frontend/e2e/assets.spec.ts
git add studio/frontend/e2e/llm-chat.spec.ts studio/frontend/e2e/assets.spec.ts
git commit  # message: "test(e2e): assert real output (non-echo reply, real image dims)"
```

---

### Task 10: Error-path e2e + health guard for the suite

**Files:**

- Create: `studio/frontend/e2e/provider-errors.spec.ts`
- Create: `studio/frontend/e2e/global-setup.ts`
- Modify: `studio/frontend/playwright.config.ts`

**Interfaces:**

- Consumes: backend `/health` (`providerMode`); the `bloom/force-error` sentinel model; `chat-error` testid (Task 8); `chat-ai-status` `data-state`.
- Produces: a global setup that fails fast if `/health` lacks `providerMode` (i.e. an old/degenerate backend), and asserts `providerMode === 'live'` when `BLOOM_E2E_TIER=live`.

- [ ] **Step 1: Write the global setup**

```ts
// studio/frontend/e2e/global-setup.ts
const BACKEND_URL = process.env.VITE_BLOOM_BACKEND_URL ?? 'http://localhost:8000';

export default async function globalSetup() {
  const res = await fetch(`${BACKEND_URL}/health`).catch(() => null);
  if (!res || !res.ok) throw new Error(`e2e: backend not reachable at ${BACKEND_URL}/health — start it first`);
  const body = (await res.json()) as { providerMode?: string };
  if (!body.providerMode) {
    throw new Error('e2e: backend has no providerMode on /health — it is too old or not the parity build. Refusing to run against an unknown stack.');
  }
  if (process.env.BLOOM_E2E_TIER === 'live' && body.providerMode !== 'live') {
    throw new Error(`e2e-live requires PROVIDER_MODE=live, but /health says "${body.providerMode}"`);
  }
}
```

- [ ] **Step 2: Register the global setup** (`playwright.config.ts`)

```ts
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:4200', trace: 'on-first-retry' },
  // ...unchanged...
});
```

- [ ] **Step 3: Write the error-path test**

```ts
// studio/frontend/e2e/provider-errors.spec.ts
import { test, expect } from '@playwright/test';
import { seedLocalStorage } from './helpers';

const BACKEND_URL = process.env.VITE_BLOOM_BACKEND_URL ?? 'http://localhost:8000';

// A provider failure must surface a VISIBLE error, not a frozen "generating" state.
// The room is created with the sentinel model id, which both the replay provider
// (raises) and live OpenRouter (rejects) turn into the backend's `error` event.
test('a failed generation shows a visible chat error, not a frozen state', async ({ page, request }) => {
  const room = await request.post(`${BACKEND_URL}/rooms`, { data: { name: `Err ${Date.now()}`, model: 'bloom/force-error' } }).then((r) => r.json());

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'alice' } }));
  await page.goto(`/room/${room.id}`);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  await page.getByTestId('chat-composer').fill('this will fail');
  await page.getByTestId('chat-send').click();

  await expect(page.getByTestId('chat-error')).toBeVisible({ timeout: 15_000 });
  // and the AI status must not be stuck generating
  await expect(page.getByTestId('chat-ai-status')).not.toHaveAttribute('data-state', 'generating', { timeout: 15_000 });
});
```

- [ ] **Step 4: Run against a replay backend**

```bash
# backend in replay mode + frontend (Playwright starts the frontend)
cd studio/backend && PROVIDER_MODE=replay uv run uvicorn app.main:app --port 8000   # terminal 1
npx playwright test --config=studio/frontend/playwright.config.ts provider-errors    # terminal 2
```

Expected: PASS — `chat-error` becomes visible; AI status not `generating`.

- [ ] **Step 5: Verify the guard bites** — stop the backend and re-run; expect the global setup to fail with the "backend not reachable" message (confirms the guard works). Restart backend afterwards.

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/e2e/provider-errors.spec.ts studio/frontend/e2e/global-setup.ts studio/frontend/playwright.config.ts
git add studio/frontend/e2e/provider-errors.spec.ts studio/frontend/e2e/global-setup.ts studio/frontend/playwright.config.ts
git commit  # message: "test(e2e): visible-error path + /health parity guard"
```

---

### Task 11: Serve preflight, recipes, and docs

**Files:**

- Modify: `justfile`
- Modify: `studio/backend/README.md`, `AGENTS.md`

**Interfaces:**

- Produces: `just preflight` (PowerShell) that reads `/health` and prints `LIVE`/`REPLAY`, exiting non-zero on `replay`; updated `e2e`/`e2e-live` recipes; replacement of the legacy `backend-serve-fake`/`e2e-chat`/`e2e-assets` recipes with the `PROVIDER_MODE` model.

- [ ] **Step 1: Replace the fake-backend recipes** in `justfile`

```
# Serve the backend in replay mode (recorded-real fixtures; offline, no API key/GPU).
backend-serve-replay:
    cd studio/backend && PROVIDER_MODE=replay uv run uvicorn app.main:app --port 8000

# Preflight: refuse to "serve to a human" if the backend is in replay mode.
preflight:
    powershell -NoProfile -Command "$h = Invoke-RestMethod http://localhost:8000/health; Write-Host ('Provider mode: ' + $h.providerMode.ToUpper()); if ($h.providerMode -ne 'live') { Write-Error 'Backend is in REPLAY mode — not safe to hand to a user. Start it with PROVIDER_MODE=live.'; exit 1 }"

# Deterministic e2e against a replay backend (start `just backend-serve-replay` first).
e2e:
    npx playwright test --config=studio/frontend/playwright.config.ts

# Live e2e: same specs against LIVE providers (start a live backend + ComfyUI first). Never in CI.
e2e-live:
    cd studio/frontend && set BLOOM_E2E_TIER=live && npx playwright test --config=playwright.config.ts
```

Remove the old `backend-serve-fake`, `e2e-chat`, and `e2e-assets` recipes (their fake env vars are superseded; the legacy mapping in Task 1 keeps any stragglers working with a warning).

- [ ] **Step 2: Verify the preflight both ways**

```bash
# live backend:
cd studio/backend && PROVIDER_MODE=live uv run uvicorn app.main:app --port 8000   # terminal 1
just preflight   # expect: "Provider mode: LIVE", exit 0
# replay backend: restart with PROVIDER_MODE=replay, then:
just preflight   # expect: error "Backend is in REPLAY mode…", exit 1
```

- [ ] **Step 3: Document the modes & tiers** — add a section to `studio/backend/README.md` and a note in `AGENTS.md` (Testing section) describing: `PROVIDER_MODE=live|replay`, the `mode-badge`, `just preflight` before any human session, `just record-fixtures` to refresh cassettes, and `just e2e` (replay, deterministic) vs `just e2e-live` (on-demand, never CI). Keep each to a few lines.

- [ ] **Step 4: Commit**

```bash
npx prettier --write AGENTS.md studio/backend/README.md
git add justfile AGENTS.md studio/backend/README.md
git commit  # message: "docs+chore: serve preflight, replay/live recipes, mode docs"
```

---

### Final verification (before PR)

- [ ] Backend suite green: `cd studio/backend && uv run pytest -m "not e2e" -q`
- [ ] Frontend gates green: `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`
- [ ] Replay e2e green: `just backend-serve-replay` (terminal 1) + `just e2e` (terminal 2) — chat is non-echo, image dims real, error path visible
- [ ] Live smoke green (manual, on-demand): live backend + ComfyUI up + `just e2e-live`
- [ ] Open PR: `gh pr create` then `gh pr merge --squash --delete-branch`

---

## Self-Review

**Spec coverage:**

- §3.1 parity not "more tests" → the whole plan (replay = recorded-real) ✓
- §3.2 replace fakes with recorded-real replay → Tasks 4, 5, 6 ✓
- §3.3 regenerate from live on demand → Task 6 (`record-fixtures`) ✓
- §3.4 honest visible mode (`/health` + badge + serve preflight) → Tasks 2, 7, 11 ✓
- §3.5 rename to `live`/`replay`, one knob → Task 1 ✓
- §3.6 tests+runtime share flows; replay strict + `@live` same flows → Tasks 9, 10, 11 (tier via backend + `BLOOM_E2E_TIER`) ✓
- §3.7 coverage = 2 happy + 1 error, browser-level → Tasks 9, 10 ✓
- §4.2 single knob, legacy mapping + disagreement warning, default live → Task 1 ✓
- §4.3 cassette format + recording → Tasks 3, 6 ✓
- §4.4 `/health` no secrets, badge, serve preflight → Tasks 2, 7, 11 ✓
- §8 risks (drift, over-fitting, flakiness, legacy) → covered by `@live` refresh (6), default fallback + shape assertions (4, 9), sentinel + dims/bytes asserts (9, 10), legacy mapping (1) ✓

**Placeholder scan:** no TBD/TODO; every code step has concrete code; the two "mirror the existing harness" notes (Task 8 Step 1, Task 2 Step 1) point at named existing patterns rather than leaving logic unspecified.

**Type consistency:** `provider_mode` (Python snake) vs `providerMode` (wire/TS) used deliberately and consistently; `ERROR_SENTINEL_MODEL = "bloom/force-error"` identical in backend (Task 4) and e2e (Task 10); `ReplayLLMProvider`/`LiveOpenRouterProvider`/`ReplayComfyProvider`/`LiveComfyProvider` names consistent across Tasks 4, 5, 6; `lastError` / `chat-error` / `mode-badge` testids consistent across Tasks 7, 8, 10.

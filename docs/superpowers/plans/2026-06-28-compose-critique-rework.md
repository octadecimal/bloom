# Composition critique rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the compose-loop critic actually run — headlessly and reliably — by replacing the flaky live-engine frame capture with a backend scene compositor, adding a per-asset quality gate that catches empty/cut-off art, surfacing every verdict in chat, and proving it with a backend replay e2e that asserts the critic ran.

**Architecture:** Two judgments, two inputs. A new pure `SceneCompositor` (Pillow) renders the canonical scene document to a PNG — replacing `SceneCaptureBroker.request_capture` as the source of the composition frame, so no open browser pane is needed. A new `AssetCritic` seam judges each generated asset image on its own (a deterministic heuristic catches degenerate art before any vision call). `run_compose` is rewired: `place → asset-gate → composite → composition-critique → edits`. The live capture broker is demoted out of the critical path (kept for a future enhancement).

**Tech Stack:** Python 3 / FastAPI backend, Pillow (PIL) for compositing, Pydantic v2, MongoDB (motor), LangChain `ChatOpenAI` structured output (live critic), pytest + pytest-asyncio. Backend-only; no frontend changes. The authoritative new test is a non-browser replay e2e.

## Global Constraints

Copied from `AGENTS.md`, `docs/coding-standards.md`, and the spec. Every task implicitly includes these.

- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, then refactor.
- **Semantic (Conventional Commits)** for every commit — `feat(scope): …`, imperative mood, ~50-char subject.
- **Worktree:** this work happens in `C:\code\bloom.wt\compose-critique` on branch `feat/compose-critique` with `BLOOM_PORT_OFFSET=1` (backend `:8001`). Run all commands from inside the worktree. Run `just bootstrap` once before the first test (the worktree was created fresh: `npm install` + `uv sync`).
- **Backend unit tests:** `cd studio/backend && uv run pytest -m "not e2e"` — requires a `mongod` on `:27017` (shared singleton; tests use DB `bloom_studio_test`). Pure-logic tests touch no Mongo/network.
- **Backend e2e (non-browser, replay):** `cd studio/backend && uv run pytest -m e2e` — spins a real uvicorn at `PROVIDER_MODE=replay` via the `live_server` fixture (`tests/e2e/conftest.py`). This tier IS the authoritative behavioral contract.
- **Reuse existing seams:** placement via `build_generate_and_place_tool`; transforms via `build_adjust_element_tool`; regeneration via `build_regenerate_element_tool`; element/texture joining via `_placed_elements` / `_texture_of`; critic schema in `app/scene/critic.py`; cassette loaders in `app/replay/cassette.py`; critic/asset-critic selection mirrors `build_scene_critic(settings)`. Do NOT hand-roll node walking, Mongo writes, or a second critic path.
- **Pillow** is a new backend dependency — add it to `studio/backend/pyproject.toml` and `uv sync` (Task 1).
- **Engine layout parity:** the compositor MUST match `runtime/client/src/render/pixiRenderer.ts`: a Sprite's `position` is where its `anchor` point lands; rendered size = `texture_size * scale`; sprites paint in ascending `zIndex`; canvas size comes from the Root node's `width`/`height`; background is `#0b0b0c` (RGB 11,11,12). `fit` is baked into `scale` at placement time (the engine renderer applies no separate fit), so the compositor only consumes `scale`.

---

## File Structure

- `studio/backend/app/scene/compositor.py` — **create.** Pure `composite_scene(document, images)` (Pillow) + `collect_scene_images(document, media_dir)` (resolve texture srcs → bytes) + a small `_texture_of` helper. No Mongo, no network.
- `studio/backend/app/scene/asset_critic.py` — **create.** `AssetVerdict`, `AssetCritiqueRequest`, `asset_heuristic(...)` (pure), `AssetCritic` protocol, `ReplayAssetCritic`, `LiveAssetCritic`, `build_asset_critic(settings)`.
- `studio/backend/app/replay/cassette.py` — **modify.** Add `load_asset_cassettes(fixtures_dir)` mirroring `load_critic_cassettes`.
- `studio/backend/app/scene/compose_loop.py` — **modify.** `ComposeDeps.capture()` → `render_scene()`; add `critique_asset(...)`; add asset-gate to `run_compose`; `ComposeResult.assets_regenerated`; fail-loud render note.
- `studio/backend/app/agent_tools.py` — **modify.** Add `ToolContext.asset_critic`; rewire `_SceneComposeDeps` (`render_scene`, `critique_asset`, drop capture dependency); `compose_scene` tool requires critic + asset_critic (not broker).
- `studio/backend/app/room_hub.py` — **modify.** Accept + forward `asset_critic`.
- `studio/backend/app/main.py` — **modify.** `build_asset_critic(settings)`; pass into `RoomHub`.
- `studio/backend/tests/test_compositor.py` — **create.** Golden-layout unit tests.
- `studio/backend/tests/test_asset_critic.py` — **create.** Heuristic + replay unit tests (incl. the real 7.6 KB empty PNG fixture).
- `studio/backend/tests/test_compose_loop.py` — **modify.** New asset-gate + render_scene behavior (fake deps).
- `studio/backend/tests/test_compose_scene_tool.py` — **modify.** `_SceneComposeDeps.render_scene`/`critique_asset` against real Mongo + fakes; registry still builds.
- `studio/backend/tests/fixtures/empty_reel_frame.png` — **create.** A near-empty PNG fixture (the degenerate-asset case).
- `studio/backend/tests/fixtures/replay/asset/*.json` — **create.** Asset-critic cassettes for the e2e.
- `studio/backend/tests/fixtures/replay/run/compose-critique-loop.json`, `tests/fixtures/replay/critic/*.json` — **create.** e2e run + composition-critic cassettes.
- `studio/backend/tests/e2e/test_compose_critique.py` — **create.** Authoritative replay e2e: real compositing, asserts `passes > 0`, asset regenerated, transform applied, converges.

---

### Task 1: `SceneCompositor` — render the canonical scene to a PNG

The robust replacement for the live capture. A pure function over `(document, {texture_id: png_bytes})` plus a media-backed image collector. Golden-layout tests pin engine parity.

**Files:**

- Create: `studio/backend/app/scene/compositor.py`
- Create: `studio/backend/tests/test_compositor.py`
- Modify: `studio/backend/pyproject.toml` (add `pillow`)

**Interfaces:**

- Consumes (existing): the scene-document shape — `document["nodes"]` is `{id: {type, props}}` with `Sprite` props `position{x,y}`, `scale{x,y}`, `anchor{x,y}`, `zIndex`; `Texture` props `src` (`/media/{game}/{asset}/{gen}.png`); a `Root` node props `width`/`height`. `document["edges"]` carries `{type:"data", from:{node:texId}, to:{node:sprId, port:"texture"}}`.
- Produces (relied on by Tasks 3–6, e2e): `composite_scene(document: dict, images: dict[str, bytes], *, background: tuple[int,int,int,int] = (11,11,12,255)) -> bytes` (PNG); `collect_scene_images(document: dict, media_dir: str) -> dict[str, bytes]` (texture-id → file bytes, skipping unreadable/unbound); `_texture_of(document: dict, sprite_id: str) -> str | None`.

- [ ] **Step 1: Add the Pillow dependency**

In `studio/backend/pyproject.toml`, add `"pillow>=10.0"` to the `dependencies` list (next to the existing runtime deps). Then:

Run: `cd studio/backend && uv sync`
Expected: resolves and installs `pillow`.

- [ ] **Step 2: Write the failing tests**

Create `studio/backend/tests/test_compositor.py`:

```python
from io import BytesIO

from PIL import Image

from app.scene.compositor import collect_scene_images, composite_scene, _texture_of


def _png(w: int, h: int, color) -> bytes:
    buf = BytesIO()
    Image.new("RGBA", (w, h), color).save(buf, format="PNG")
    return buf.getvalue()


def _doc():
    # canvas 200x100; one opaque red bg (full), one 40x40 blue sprite centered at (150,50)
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 200, "height": 100}},
            "spr.bg": {"id": "spr.bg", "type": "Sprite", "props": {
                "position": {"x": 100, "y": 50}, "anchor": {"x": 0.5, "y": 0.5},
                "scale": {"x": 1.0, "y": 1.0}, "zIndex": 0}},
            "tex.bg": {"id": "tex.bg", "type": "Texture", "props": {"src": "/media/g/bg/1.png"}},
            "spr.logo": {"id": "spr.logo", "type": "Sprite", "props": {
                "position": {"x": 150, "y": 50}, "anchor": {"x": 0.5, "y": 0.5},
                "scale": {"x": 1.0, "y": 1.0}, "zIndex": 5}},
            "tex.logo": {"id": "tex.logo", "type": "Texture", "props": {"src": "/media/g/logo/1.png"}},
        },
        "edges": [
            {"type": "data", "from": {"node": "tex.bg", "port": "data"}, "to": {"node": "spr.bg", "port": "texture"}},
            {"type": "data", "from": {"node": "tex.logo", "port": "data"}, "to": {"node": "spr.logo", "port": "texture"}},
        ],
    }


def test_texture_of_finds_bound_texture():
    assert _texture_of(_doc(), "spr.bg") == "tex.bg"
    assert _texture_of(_doc(), "spr.none") is None


def test_composite_places_sprites_by_anchor_and_zorder():
    images = {"tex.bg": _png(200, 100, (255, 0, 0, 255)),
              "tex.logo": _png(40, 40, (0, 0, 255, 255))}
    out = composite_scene(_doc(), images)
    img = Image.open(BytesIO(out)).convert("RGBA")
    assert img.size == (200, 100)
    # background red where the logo isn't
    assert img.getpixel((10, 50))[:3] == (255, 0, 0)
    # logo (40x40 centered at 150,50) => spans x 130..170, y 30..70 => blue at its center
    assert img.getpixel((150, 50))[:3] == (0, 0, 255)
    # just outside the logo box stays background
    assert img.getpixel((128, 50))[:3] == (255, 0, 0)


def test_composite_applies_scale():
    # scale the logo 2x => 80x80 centered at 150,50 spans x 110..190
    doc = _doc()
    doc["nodes"]["spr.logo"]["props"]["scale"] = {"x": 2.0, "y": 2.0}
    images = {"tex.bg": _png(200, 100, (255, 0, 0, 255)),
              "tex.logo": _png(40, 40, (0, 0, 255, 255))}
    img = Image.open(BytesIO(composite_scene(doc, images))).convert("RGBA")
    assert img.getpixel((115, 50))[:3] == (0, 0, 255)  # inside the scaled box


def test_composite_skips_unbound_or_missing_images():
    doc = _doc()
    # only bg image present; logo image missing => logo skipped, no crash
    img = Image.open(BytesIO(composite_scene(doc, {"tex.bg": _png(200, 100, (255, 0, 0, 255))}))).convert("RGBA")
    assert img.getpixel((150, 50))[:3] == (255, 0, 0)


def test_collect_scene_images_reads_media(tmp_path):
    # lay a media file matching tex.bg's src under media_dir
    (tmp_path / "g" / "bg").mkdir(parents=True)
    (tmp_path / "g" / "bg" / "1.png").write_bytes(_png(8, 8, (1, 2, 3, 255)))
    images = collect_scene_images(_doc(), str(tmp_path))
    assert "tex.bg" in images and images["tex.bg"]
    assert "tex.logo" not in images  # file absent => skipped
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_compositor.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.scene.compositor'`.

- [ ] **Step 4: Write `app/scene/compositor.py`**

Create `studio/backend/app/scene/compositor.py`:

```python
"""Backend scene compositor — renders the canonical scene document to a PNG.

Replaces the live-engine frame capture as the source of the composition-critic's
image (see docs/superpowers/specs/2026-06-28-compose-critique-rework-design.md).
Pure: given the document + each texture's image bytes it composites a frame with
Pillow, matching the engine's layout math (anchor-positioned, scaled, z-ordered).
It deliberately reproduces only the *layout* (not engine filters/blend/responsive
scaling) — the composition critic acts on layout, and the canonical document is
the source of truth.
"""

from io import BytesIO
from pathlib import Path

from PIL import Image

# Match runtime/client/src/render/pixiRenderer.ts BACKGROUND_COLOR '#0b0b0c'.
BACKGROUND_RGBA = (11, 11, 12, 255)


def _texture_of(document: dict, sprite_id: str) -> str | None:
    """The Texture node id bound to a sprite's `texture` port, or None.

    Mirrors `app.agent_tools._texture_of` (kept local to avoid an import cycle
    into the agent-tools module).
    """
    for e in document.get("edges", []):
        to = e.get("to") or {}
        if (e.get("type") == "data" and to.get("node") == sprite_id
                and to.get("port") == "texture"):
            return (e.get("from") or {}).get("node")
    return None


def collect_scene_images(document: dict, media_dir: str) -> dict[str, bytes]:
    """Read each bound texture's file from `media_dir`, keyed by texture-id.

    A texture whose `src` file is missing/unreadable is skipped (the compositor
    then renders the scene without it).
    """
    root = Path(media_dir)
    out: dict[str, bytes] = {}
    for nid, n in (document.get("nodes") or {}).items():
        if n.get("type") != "Texture":
            continue
        src = (n.get("props") or {}).get("src")
        if not src or not src.startswith("/media/"):
            continue
        path = root / src[len("/media/"):]
        try:
            out[nid] = path.read_bytes()
        except OSError:
            continue
    return out


def composite_scene(
    document: dict,
    images: dict[str, bytes],
    *,
    background: tuple[int, int, int, int] = BACKGROUND_RGBA,
) -> bytes:
    """Composite the canonical scene to PNG bytes.

    `images` maps texture-id -> PNG bytes. A sprite whose texture is unbound or
    absent from `images` is skipped. Sprites paint in ascending zIndex; each is
    scaled by its `scale` and positioned so its `anchor` point lands at
    `position`.
    """
    nodes = document.get("nodes") or {}
    root = next((n for n in nodes.values() if n.get("type") == "Root"), None)
    rp = (root or {}).get("props") or {}
    cw = int(rp.get("width", 1280) or 1280)
    ch = int(rp.get("height", 720) or 720)
    canvas = Image.new("RGBA", (cw, ch), background)

    sprites = [(nid, n) for nid, n in nodes.items() if n.get("type") == "Sprite"]
    sprites.sort(key=lambda it: int((it[1].get("props") or {}).get("zIndex", 0) or 0))

    for nid, n in sprites:
        tex_id = _texture_of(document, nid)
        if tex_id is None or tex_id not in images:
            continue
        try:
            sprite = Image.open(BytesIO(images[tex_id])).convert("RGBA")
        except Exception:
            continue
        props = n.get("props") or {}
        scale = props.get("scale") or {}
        sx = float(scale.get("x", 1.0) or 1.0)
        sy = float(scale.get("y", 1.0) or 1.0)
        rw = max(1, round(sprite.width * sx))
        rh = max(1, round(sprite.height * sy))
        if (rw, rh) != (sprite.width, sprite.height):
            sprite = sprite.resize((rw, rh))
        anchor = props.get("anchor") or {}
        ax = float(anchor.get("x", 0.5))
        ay = float(anchor.get("y", 0.5))
        pos = props.get("position") or {}
        px = float(pos.get("x", cw / 2))
        py = float(pos.get("y", ch / 2))
        tlx = round(px - ax * rw)
        tly = round(py - ay * rh)
        # Paste onto a full-canvas transparent layer (clips off-canvas regions),
        # then alpha-composite so partial transparency blends correctly.
        layer = Image.new("RGBA", (cw, ch), (0, 0, 0, 0))
        layer.paste(sprite, (tlx, tly))
        canvas = Image.alpha_composite(canvas, layer)

    out = BytesIO()
    canvas.save(out, format="PNG")
    return out.getvalue()
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_compositor.py -v`
Expected: PASS (all five tests).

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/compositor.py studio/backend/tests/test_compositor.py studio/backend/pyproject.toml studio/backend/uv.lock
git commit -m "feat(scene): backend scene compositor (Pillow) for headless critique"
```

---

### Task 2: `AssetCritic` — per-asset quality gate

Judges a single generated asset image. A deterministic heuristic catches degenerate art (the 7.6 KB empty reel frame) before any vision call; a swappable vision stage judges quality/cropping/theme.

**Files:**

- Create: `studio/backend/app/scene/asset_critic.py`
- Modify: `studio/backend/app/replay/cassette.py` (add `load_asset_cassettes`)
- Create: `studio/backend/tests/test_asset_critic.py`
- Create: `studio/backend/tests/fixtures/empty_reel_frame.png` (a near-empty transparent PNG)

**Interfaces:**

- Consumes (existing): `Settings` (`app/config.py`: `provider_mode`, `openrouter_api_key`, `openrouter_base_url`, `critic_model`); `app/replay/cassette.py` `DEFAULT_FIXTURES_DIR`, `normalize_prompt`, and the `load_critic_cassettes` pattern; `langchain_openai.ChatOpenAI` (live).
- Produces (relied on by Tasks 3–6, e2e): `AssetVerdict(BaseModel){ ok: bool=True, action: Literal["keep","regenerate"]="keep", reason: str="" }`; `AssetCritiqueRequest` (frozen dataclass) `{ image_png: bytes, role: str, description: str="", theme: str="", transparent: bool=True }`; `asset_heuristic(image_png: bytes, *, transparent: bool) -> AssetVerdict | None` (a regenerate verdict for degenerate art, else None); `AssetCritic` Protocol with `async critique(request) -> AssetVerdict`; `ReplayAssetCritic`, `LiveAssetCritic`, `build_asset_critic(settings) -> AssetCritic`; `load_asset_cassettes(fixtures_dir) -> dict[str, dict]`.

- [ ] **Step 1: Create the empty-asset fixture**

Create the degenerate PNG fixture with a one-off script (run once, then it's a committed binary):

Run:

```bash
cd studio/backend && uv run python -c "from PIL import Image; Image.new('RGBA',(256,256),(0,0,0,0)).save('tests/fixtures/empty_reel_frame.png')"
```

Expected: writes a fully-transparent 256×256 PNG (~hundreds of bytes) — the degenerate case.

- [ ] **Step 2: Write the failing tests**

Create `studio/backend/tests/test_asset_critic.py`:

```python
import asyncio
from io import BytesIO
from pathlib import Path

from PIL import Image

from app.scene.asset_critic import (
    AssetCritiqueRequest,
    AssetVerdict,
    ReplayAssetCritic,
    asset_heuristic,
)


def _png(color, size=(64, 64)) -> bytes:
    buf = BytesIO()
    Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


def test_heuristic_flags_fully_transparent_cutout():
    empty = Path("tests/fixtures/empty_reel_frame.png").read_bytes()
    v = asset_heuristic(empty, transparent=True)
    assert v is not None and v.action == "regenerate"
    assert "empty" in v.reason.lower() or "covered" in v.reason.lower()


def test_heuristic_flags_flat_opaque_image():
    v = asset_heuristic(_png((20, 20, 20, 255)), transparent=False)
    assert v is not None and v.action == "regenerate"


def test_heuristic_passes_a_rich_transparent_asset():
    # half-opaque/half-transparent, varied => not degenerate
    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    for x in range(64):
        for y in range(32):
            img.putpixel((x, y), (x * 4 % 256, y * 8 % 256, 128, 255))
    buf = BytesIO(); img.save(buf, format="PNG")
    assert asset_heuristic(buf.getvalue(), transparent=True) is None


def test_replay_asset_critic_returns_keyed_verdict():
    critic = ReplayAssetCritic({"reel_frame": {"ok": False, "action": "regenerate", "reason": "empty frame"}})
    req = AssetCritiqueRequest(image_png=_png((5, 6, 7, 255), (64, 64)), role="reel_frame", transparent=True)
    # a rich image passes the heuristic, so the cassette decides
    v = asyncio.get_event_loop().run_until_complete(critic.critique(req))
    assert v.action == "regenerate" and v.reason == "empty frame"


def test_replay_asset_critic_heuristic_short_circuits_before_cassette():
    # degenerate image => heuristic flags it even with a "keep" cassette
    empty = Path("tests/fixtures/empty_reel_frame.png").read_bytes()
    critic = ReplayAssetCritic({"reel_frame": {"ok": True, "action": "keep", "reason": "fine"}})
    req = AssetCritiqueRequest(image_png=empty, role="reel_frame", transparent=True)
    v = asyncio.get_event_loop().run_until_complete(critic.critique(req))
    assert v.action == "regenerate"


def test_replay_asset_critic_defaults_to_keep_when_no_cassette():
    critic = ReplayAssetCritic({})
    req = AssetCritiqueRequest(image_png=_png((5, 6, 7, 255)), role="logo", transparent=True)
    v = asyncio.get_event_loop().run_until_complete(critic.critique(req))
    assert v.action == "keep"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_asset_critic.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.scene.asset_critic'`.

- [ ] **Step 4: Add `load_asset_cassettes` to `app/replay/cassette.py`**

Find `load_critic_cassettes` (around line 64) and add a sibling below it (it mirrors the same shape — `default.json` → `"__default__"`, files with a `role`/`target` keyed by `normalize_prompt`):

```python
def load_asset_cassettes(fixtures_dir: Path) -> dict[str, dict]:
    """Recorded per-role asset verdicts from ``tests/fixtures/replay/asset/``.

    ``default.json`` becomes ``"__default__"``. Files with a ``role`` (or
    ``target``) key are also keyed by ``normalize_prompt(role)``. Each value is
    an ``AssetVerdict`` dict ``{ok, action, reason}``.
    """
    out: dict[str, dict] = {}
    base = fixtures_dir / "asset"
    if not base.is_dir():
        return out
    for path in sorted(base.glob("*.json")):
        data = json.loads(path.read_text())
        verdict = {k: v for k, v in data.items() if k not in ("role", "target")}
        if path.stem == "default":
            out["__default__"] = verdict
        key = data.get("role") or data.get("target")
        if key:
            out[normalize_prompt(key)] = verdict
    return out
```

(If `json` / `normalize_prompt` / `Path` aren't already imported at the top of `cassette.py`, they are — `load_critic_cassettes` uses them.)

- [ ] **Step 5: Write `app/scene/asset_critic.py`**

Create `studio/backend/app/scene/asset_critic.py`:

```python
"""Per-asset quality critic — swappable seam.

Judges ONE generated asset image (is it empty / cut off / low quality / off
theme?), independent of the composed scene. A deterministic heuristic catches
degenerate art (near-empty cutouts, flat fills) before any vision call; the
vision stage (replay cassette or a direct claude-sonnet-4-6 image call) judges
quality/cropping/theme. See
docs/superpowers/specs/2026-06-28-compose-critique-rework-design.md.
"""

import base64
import json
from dataclasses import dataclass
from io import BytesIO
from typing import Literal, Protocol

from PIL import Image
from pydantic import BaseModel

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR,
    load_asset_cassettes,
    normalize_prompt,
)

# Heuristic thresholds (constants so they're greppable / tunable).
EMPTY_BYTE_FLOOR = 12_000          # PNGs smaller than this are almost always degenerate
MIN_ALPHA_COVERAGE = 0.02          # transparent cutout must cover >2% of the frame
MIN_OPAQUE_ENTROPY = 1.5           # flat/near-single-colour opaque image is degenerate
_ALPHA_VISIBLE = 16                # alpha above this counts as "visible"


class AssetVerdict(BaseModel):
    ok: bool = True
    action: Literal["keep", "regenerate"] = "keep"
    reason: str = ""


@dataclass(frozen=True)
class AssetCritiqueRequest:
    image_png: bytes
    role: str
    description: str = ""
    theme: str = ""
    transparent: bool = True


def asset_heuristic(image_png: bytes, *, transparent: bool) -> AssetVerdict | None:
    """Cheap, deterministic degenerate-art detector.

    Returns a ``regenerate`` verdict for an empty / near-empty / flat image, or
    ``None`` to defer to the vision stage.
    """
    if len(image_png) < EMPTY_BYTE_FLOOR:
        return AssetVerdict(ok=False, action="regenerate",
                            reason=f"near-empty image ({len(image_png)} bytes)")
    try:
        img = Image.open(BytesIO(image_png)).convert("RGBA")
    except Exception:
        return AssetVerdict(ok=False, action="regenerate", reason="unreadable image")
    total = max(1, img.width * img.height)
    if transparent:
        alpha_hist = img.getchannel("A").histogram()
        visible = sum(alpha_hist[_ALPHA_VISIBLE + 1:])
        frac = visible / total
        if frac < MIN_ALPHA_COVERAGE:
            return AssetVerdict(ok=False, action="regenerate",
                                reason=f"transparent asset almost fully empty "
                                       f"({frac:.1%} covered)")
    else:
        entropy = img.convert("L").entropy()
        if entropy < MIN_OPAQUE_ENTROPY:
            return AssetVerdict(ok=False, action="regenerate",
                                reason=f"flat/near-blank image (entropy {entropy:.2f})")
    return None


class AssetCritic(Protocol):
    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict: ...


class ReplayAssetCritic:
    """Offline asset critic: heuristic first, then a recorded per-role verdict."""

    def __init__(self, cassettes: dict[str, dict]):
        self._cassettes = cassettes

    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict:
        flagged = asset_heuristic(request.image_png, transparent=request.transparent)
        if flagged is not None:
            return flagged
        data = (self._cassettes.get(normalize_prompt(request.role))
                or self._cassettes.get("__default__"))
        return AssetVerdict(**data) if data else AssetVerdict()


ASSET_SYSTEM_PROMPT = (
    "You are a slot-game ASSET quality critic. You are shown a SINGLE generated "
    "asset image (not the composed scene) and told its intended role. Judge ONLY "
    "this asset on its own: is it empty, cut off at the edges, low quality, or "
    "clearly wrong for its stated role/theme? Backgrounds should be full scenes; "
    "logos/props/characters should be clean, complete, and (when transparent) cut "
    "out cleanly. Return {ok, action, reason} where action is 'keep' if the asset "
    "is usable, or 'regenerate' if it must be remade. Prefer 'keep' unless the "
    "asset is clearly unusable."
)


def _data_url(image_png: bytes) -> str:
    return f"data:image/png;base64,{base64.b64encode(image_png).decode('ascii')}"


def build_asset_messages(request: AssetCritiqueRequest):
    from langchain_core.messages import HumanMessage, SystemMessage

    text = (
        f"Judge this asset.\nRole: {request.role}\n"
        f"Intended description: {request.description}\nTheme: {request.theme}\n"
        f"Expected transparent cutout: {request.transparent}"
    )
    return [
        SystemMessage(ASSET_SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": _data_url(request.image_png)}},
        ]),
    ]


class LiveAssetCritic:
    """Live asset critic: heuristic first, then a direct structured+image call."""

    def __init__(self, api_key: str, base_url: str, model: str):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict:
        flagged = asset_heuristic(request.image_png, transparent=request.transparent)
        if flagged is not None:
            return flagged
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=self._model, api_key=self._api_key, base_url=self._base_url)
        structured = llm.with_structured_output(AssetVerdict)
        return await structured.ainvoke(build_asset_messages(request))


def build_asset_critic(settings: Settings) -> AssetCritic:
    """Select the asset-critic impl by provider mode — mirrors build_scene_critic."""
    if settings.provider_mode == "replay":
        return ReplayAssetCritic(load_asset_cassettes(DEFAULT_FIXTURES_DIR))
    return LiveAssetCritic(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        model=settings.critic_model,
    )
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_asset_critic.py -v`
Expected: PASS (all six tests).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/scene/asset_critic.py studio/backend/app/replay/cassette.py studio/backend/tests/test_asset_critic.py studio/backend/tests/fixtures/empty_reel_frame.png
git commit -m "feat(scene): per-asset quality critic with degenerate-art heuristic"
```

---

### Task 3: Rewire `run_compose` — asset gate + compositor frame

Change the loop's frame source from a live capture to `render_scene()`, add the per-asset quality gate before the composition passes, and make a render failure a _visible_ note (fail-loud). Pure logic, exhaustively unit-tested with fakes.

**Files:**

- Modify: `studio/backend/app/scene/compose_loop.py`
- Modify: `studio/backend/tests/test_compose_loop.py`

**Interfaces:**

- Consumes: `AssetVerdict` (Task 2); `Critique`, `CritiqueRequest`, `EditParams` (existing).
- Produces (relied on by Task 4): `ComposeDeps` with `render_scene(self) -> bytes` (replaces `capture`) and `critique_asset(self, target_handle: str) -> AssetVerdict` (new); `ComposeResult.assets_regenerated: int`; `run_compose` order `place → critique_asset (regenerate if needed, shared regen budget) → [render_scene → critique → edits] × passes`.

- [ ] **Step 1: Update the unit tests (the failing spec for the new behavior)**

In `studio/backend/tests/test_compose_loop.py`, update `FakeDeps` and add asset-gate tests. Replace the `capture`/`captures` parts of `FakeDeps` and add the asset hooks:

```python
# --- in FakeDeps.__init__ add: ---
        self.renders = 0
        self.asset_verdicts = asset_verdicts or {}   # handle -> AssetVerdict

# --- replace capture() with render_scene(): ---
    async def render_scene(self) -> bytes:
        self.renders += 1
        target = self.placements[-1]
        if target in self._capture_fail:   # reuse the set, now "render fail"
            raise RuntimeError("render failed")
        return b"\x89PNG-fake-frame"

# --- add: ---
    async def critique_asset(self, target_handle: str):
        from app.scene.asset_critic import AssetVerdict
        return self.asset_verdicts.get(target_handle, AssetVerdict())
```

Update `FakeDeps.__init__`'s signature to accept `asset_verdicts=None` (default), and update the existing `test_capture_failure_skips_critique_for_that_element` to call it a render failure (rename to `test_render_failure_skips_critique_with_visible_note`) and assert the note says it could not render (not "no frame"). Then add:

```python
@pytest.mark.asyncio
async def test_bad_asset_is_regenerated_before_composition():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"logo": [Critique(done=True)]},
        asset_verdicts={"logo": AssetVerdict(ok=False, action="regenerate", reason="empty")},
    )
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.regens == ["logo"]                 # asset gate regenerated it
    assert result.assets_regenerated == 1
    assert result.regens_spent == 1                # shared budget
    assert any("empty" in n for n in result.notes)


@pytest.mark.asyncio
async def test_bad_asset_regenerate_respects_shared_budget():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"a": [Critique(done=True)], "b": [Critique(done=True)]},
        asset_verdicts={
            "a": AssetVerdict(ok=False, action="regenerate", reason="empty a"),
            "b": AssetVerdict(ok=False, action="regenerate", reason="empty b"),
        },
    )
    result = await run_compose([_el("a"), _el("b")], "pirate", deps, ComposeBounds(regen_budget=1))
    assert deps.regens == ["a"]                     # only the first is funded
    assert result.assets_regenerated == 1
    assert any("budget" in n for n in result.notes) # b's regen refused, noted
```

(Keep the existing window/budget/transform composition tests; they still pass — the composition phase is unchanged except its frame comes from `render_scene`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_compose_loop.py -v`
Expected: FAIL — `AttributeError`/`TypeError` on `render_scene`/`critique_asset`/`assets_regenerated` not yet existing.

- [ ] **Step 3: Rewrite `run_compose`**

In `studio/backend/app/scene/compose_loop.py`:

(a) Add the import at the top (next to the critic import):

```python
from app.scene.asset_critic import AssetVerdict
from app.scene.critic import Critique, CritiqueRequest, EditParams
```

(b) In `ComposeResult`, add the counter:

```python
@dataclass
class ComposeResult:
    passes: int = 0
    edits_applied: int = 0
    regens_spent: int = 0
    assets_regenerated: int = 0
    rejected: int = 0
    elements_placed: int = 0
    notes: list[str] = field(default_factory=list)
```

(c) Replace the `ComposeDeps` protocol's `capture` with `render_scene` and add `critique_asset`:

```python
class ComposeDeps(Protocol):
    async def place(self, element: BuildElement) -> str: ...
    async def placed_handles(self) -> list[str]: ...
    async def scene_context(self) -> dict: ...
    async def render_scene(self) -> bytes: ...
    async def critique_asset(self, target_handle: str) -> AssetVerdict: ...
    async def critique(self, request: CritiqueRequest) -> Critique: ...
    async def adjust(self, handle: str, params: EditParams) -> str: ...
    async def regenerate(self, handle: str) -> str: ...
```

(d) Rewrite the body of `run_compose`'s per-element loop. Replace everything from `target = handles[-1]` through the end of the `for element` body with:

```python
        target = handles[-1]
        k = len(handles) - 1
        window = handles[max(0, k - bounds.look_behind):k + 1]
        result.notes.append(f"placed {target} (window={window})")

        # Per-asset quality gate (before composition): regenerate degenerate art.
        verdict = await deps.critique_asset(target)
        if verdict.action == "regenerate":
            if regen_left > 0:
                regen_left -= 1
                result.regens_spent += 1
                result.assets_regenerated += 1
                await deps.regenerate(target)
                result.notes.append(f"{target}: {verdict.reason} -> regenerated")
            else:
                result.notes.append(
                    f"{target}: {verdict.reason} (regen budget exhausted, kept)")
        else:
            result.notes.append(f"{target}: asset ok")

        # Composition passes: critique the composited scene and apply edits.
        for pass_index in range(bounds.max_passes):
            try:
                frame = await deps.render_scene()
            except Exception as exc:
                # Fail-loud (NOT silent): a render failure is surfaced, not hidden.
                result.notes.append(f"{target}: could not render scene for review ({exc})")
                logger.warning("compose: render_scene failed for %s: %s", target, exc)
                break

            scene = await deps.scene_context()
            critique = await deps.critique(CritiqueRequest(
                frame_png=frame, scene=scene, target_handle=target,
                window=window, theme=theme, regen_budget_left=regen_left,
                pass_index=pass_index,
            ))
            result.passes += 1
            if critique.done or not critique.edits:
                break

            for edit in critique.edits:
                if edit.target_handle not in window:
                    result.rejected += 1
                    result.notes.append(
                        f"rejected {edit.action} on {edit.target_handle} "
                        f"(outside window {window})")
                    continue
                if edit.action == "regenerate":
                    if regen_left <= 0:
                        result.rejected += 1
                        result.notes.append(
                            f"refused regenerate {edit.target_handle} "
                            f"(budget exhausted)")
                        continue
                    regen_left -= 1
                    result.regens_spent += 1
                    await deps.regenerate(edit.target_handle)
                    result.notes.append(
                        f"regenerated {edit.target_handle}: {edit.why}")
                else:
                    await deps.adjust(edit.target_handle, edit.params)
                    result.notes.append(
                        f"{edit.action} {edit.target_handle}: {edit.why}")
                result.edits_applied += 1
```

Also update the module docstring's first paragraph to say "composite the canonical scene" instead of "capture the real rendered frame".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_loop.py -v`
Expected: PASS — the new asset-gate tests plus all retained composition/window/budget tests.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): compose loop uses compositor + per-asset gate, fail-loud"
```

---

### Task 4: Wire real deps — `_SceneComposeDeps`, `ToolContext`, `RoomHub`, `main`

Supply the real `render_scene` (compositor over the canonical document + media) and `critique_asset` (asset critic over the target's latest generation image), thread the asset critic through to the tool, and demote the live capture broker from the loop's critical path.

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (`ToolContext`, `_SceneComposeDeps`, `compose_scene` guard)
- Modify: `studio/backend/app/room_hub.py` (`__init__` + `_run_skill` ctx)
- Modify: `studio/backend/app/main.py` (build + pass `asset_critic`)
- Modify: `studio/backend/tests/test_compose_scene_tool.py`

**Interfaces:**

- Consumes: `composite_scene`, `collect_scene_images` (Task 1); `build_asset_critic`, `AssetCritiqueRequest` (Task 2); `render_scene`/`critique_asset` deps contract (Task 3); existing `ToolContext`, `_placed_elements`, `_texture_of`, `get_settings().media_dir`, `asset_store.list_assets`, `asset_store.get_by_slot`, the `Asset` model (`app/assets/models.py`: `generations: list[Generation]`, each generation's `image_ref` is the `/media/...` url; `role`/`slot`/`transparent`).
- Produces: a `compose_scene` tool that runs the bounded loop with compositor + asset critic and no dependency on `capture_broker`.

- [ ] **Step 1: Write the failing tests**

In `studio/backend/tests/test_compose_scene_tool.py`, add deps tests (the file already has the `mongo_db`, `GameSceneStore`, `GameSceneHub`, `_seed_sprite`, `_SilentSio`, `_NoAssets` helpers). Add a fake asset critic + media-backed render test:

```python
import json as _json
from io import BytesIO
from PIL import Image

from app.scene.asset_critic import AssetVerdict
from app.agent_tools import ToolContext, _SceneComposeDeps


class _FakeAssetCritic:
    def __init__(self, verdict):
        self.verdict = verdict
        self.calls = []

    async def critique(self, request):
        self.calls.append(request.role)
        return self.verdict


def _png_bytes(color, size=(32, 32)):
    buf = BytesIO(); Image.new("RGBA", size, color).save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_render_scene_composites_from_media(mongo_db, tmp_path, monkeypatch):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "background", "background")
    # bind a texture node + edge and lay a media file matching its src
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "tex.background", "type": "Texture",
         "props": {"src": "/media/g1/background/1.png"}},
        {"kind": "connect", "edgeId": "e.tex.background", "type": "data",
         "from": {"node": "tex.background", "port": "data"},
         "to": {"node": "spr.background", "port": "texture"}},
    ])
    media = tmp_path / "g1" / "background"; media.mkdir(parents=True)
    (media / "1.png").write_bytes(_png_bytes((255, 0, 0, 255), (1280, 720)))

    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub)
    monkeypatch.setattr("app.agent_tools.get_settings",
                        lambda: type("S", (), {"media_dir": str(tmp_path)})())
    deps = _SceneComposeDeps(ctx)
    png = await deps.render_scene()
    img = Image.open(BytesIO(png)).convert("RGBA")
    assert img.size == (1280, 720)
    assert img.getpixel((640, 360))[:3] == (255, 0, 0)
    await mongo_db["game_scenes"].delete_many({})


@pytest.mark.asyncio
async def test_critique_asset_calls_asset_critic_with_latest_generation(mongo_db, tmp_path, monkeypatch):
    await mongo_db["game_scenes"].delete_many({})
    store = GameSceneStore(mongo_db)
    hub = GameSceneHub(_SilentSio(), store)
    await _seed_sprite(hub, "g1", "reel_frame", "reel frame")
    await hub.apply_batch("g1", [
        {"kind": "addNode", "id": "tex.reel_frame", "type": "Texture",
         "props": {"src": "/media/g1/reel_frame/1.png"}},
        {"kind": "connect", "edgeId": "e.tex.reel_frame", "type": "data",
         "from": {"node": "tex.reel_frame", "port": "data"},
         "to": {"node": "spr.reel_frame", "port": "texture"}},
    ])
    media = tmp_path / "g1" / "reel_frame"; media.mkdir(parents=True)
    (media / "1.png").write_bytes(_png_bytes((9, 9, 9, 255)))

    fake = _FakeAssetCritic(AssetVerdict(ok=False, action="regenerate", reason="x"))
    ctx = ToolContext("r1", "g1", _NoAssets(), None, scene_store=store, scene_hub=hub,
                      asset_critic=fake)
    monkeypatch.setattr("app.agent_tools.get_settings",
                        lambda: type("S", (), {"media_dir": str(tmp_path)})())
    deps = _SceneComposeDeps(ctx)
    verdict = await deps.critique_asset("reel_frame")
    assert verdict.action == "regenerate"
    assert fake.calls == ["reel frame"]   # role passed through
    await mongo_db["game_scenes"].delete_many({})


def test_tool_context_carries_asset_critic():
    sentinel = object()
    ctx = ToolContext("r1", "g1", None, None, asset_critic=sentinel)
    assert ctx.asset_critic is sentinel
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py -v`
Expected: FAIL — `ToolContext` has no `asset_critic`; `_SceneComposeDeps` has no `render_scene`/`critique_asset`.

- [ ] **Step 3: Add `ToolContext.asset_critic`**

In `studio/backend/app/agent_tools.py`, in the `ToolContext` dataclass (next to `scene_critic` / `capture_broker` added in #119), add:

```python
    scene_critic: object = None
    capture_broker: object = None
    asset_critic: object = None
```

- [ ] **Step 4: Rewire `_SceneComposeDeps`**

In `studio/backend/app/agent_tools.py`, add imports near the other scene imports:

```python
from app.scene.compositor import collect_scene_images, composite_scene
from app.scene.asset_critic import AssetCritiqueRequest
```

Replace `_SceneComposeDeps.capture` with `render_scene` and add `critique_asset` (leave `place`/`placed_handles`/`scene_context`/`critique`/`adjust`/`regenerate` unchanged):

```python
    async def render_scene(self) -> bytes:
        document = await self._ctx.scene_store.get_document(self._ctx.game_id)
        if not document:
            raise RuntimeError("no scene document to render")
        media_dir = get_settings().media_dir
        images = collect_scene_images(document, media_dir)
        return composite_scene(document, images)

    async def critique_asset(self, target_handle: str):
        # The target's bound texture image (latest generation) + its build intent.
        document = await self._ctx.scene_store.get_document(self._ctx.game_id)
        media_dir = get_settings().media_dir
        images = collect_scene_images(document or {}, media_dir)
        tex_id = _texture_of(document or {}, f"spr.{target_handle}")
        image_png = images.get(tex_id) if tex_id else None
        if not image_png:
            from app.scene.asset_critic import AssetVerdict
            return AssetVerdict()  # nothing to judge -> keep
        asset = await self._ctx.asset_store.get_by_slot(self._ctx.game_id, target_handle)
        role = (getattr(asset, "role", None) or target_handle)
        description = getattr(asset, "description", "") or ""
        transparent = bool(getattr(asset, "transparent", True))
        return await self._ctx.asset_critic.critique(AssetCritiqueRequest(
            image_png=image_png, role=role, description=description,
            theme="", transparent=transparent))
```

> Note: `get_settings` is already imported in `agent_tools.py` (used elsewhere). `_texture_of` and `Sprite` ids are `spr.{handle}` (see `_placed_elements`). If `asset_store.get_by_slot` returns `None` (asset not joined by slot), `role` falls back to the handle and `transparent` defaults True — the heuristic still runs on the image.

- [ ] **Step 5: Update the `compose_scene` tool guard**

In `build_compose_scene_tool`, the guard currently requires `scene_critic` and `capture_broker`. Change it to require `scene_critic` and `asset_critic` (the loop no longer depends on the broker):

```python
        if ctx.scene_critic is None or ctx.asset_critic is None:
            return ("Compose loop unavailable: no critic wired. "
                    "Place elements individually with generate_and_place.")
```

- [ ] **Step 6: Forward `asset_critic` through `RoomHub`**

In `studio/backend/app/room_hub.py`, add the param to `__init__` (after `capture_broker=None,`):

```python
        capture_broker=None,
        asset_critic=None,
    ):
```

Store it (after `self._capture_broker = capture_broker`):

```python
        self._capture_broker = capture_broker
        self._asset_critic = asset_critic
```

And pass it into the `ToolContext(...)` built in `_run_skill` (after `capture_broker=self._capture_broker,`):

```python
                         capture_broker=self._capture_broker,
                         asset_critic=self._asset_critic)
```

- [ ] **Step 7: Build + pass the asset critic in `main.py`**

In `studio/backend/app/main.py`, add the import next to `from app.scene.critic import build_scene_critic`:

```python
from app.scene.asset_critic import build_asset_critic
```

Where `scene_critic` is built (added in #119), build the asset critic too and pass it into `RoomHub`:

```python
    scene_critic = build_scene_critic(settings)
    asset_critic = build_asset_critic(settings)
    hub = RoomHub(
        ...,
        scene_critic=scene_critic, capture_broker=capture_broker,
        asset_critic=asset_critic,
    )
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py -v`
Expected: PASS (the new render/asset/context tests plus the existing registry + dataclass tests).

- [ ] **Step 9: Run the full backend unit suite**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — all suites (the `capture`→`render_scene` rename and the new asset wiring don't break existing tests; `test_design_router`, `test_agent_tools`, etc. unaffected).

- [ ] **Step 10: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/app/room_hub.py studio/backend/app/main.py studio/backend/tests/test_compose_scene_tool.py
git commit -m "feat(scene): wire compositor + asset critic into compose_scene; demote capture"
```

---

### Task 5: Surface verdicts in chat (visibility) + tool-result copy

The `compose_scene` tool result is the chat-visible surface (it streams as the tool step output). Make its summary carry the asset + composition verdicts in plain language so the user can see the loop working, and reflect the new `assets_regenerated` tally. (Per #119 decision 2, per-pass run-feed steps remain out of scope — the `RunStep` index is owned by `TurnRunner`; the rich tool result is the v1 surface.)

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (`compose_scene` result formatting)
- Modify: `studio/backend/tests/test_compose_scene_tool.py` (assert the summary copy)

**Interfaces:**

- Consumes: `ComposeResult` (with `assets_regenerated`, `notes`) from `run_compose`.
- Produces: a `compose_scene` return string whose head reports placements/passes/edits/regenerations/asset-regenerations and whose body lists the per-element notes (which now include asset + composition verdicts from Task 3).

- [ ] **Step 1: Write the failing test**

In `studio/backend/tests/test_compose_scene_tool.py`, add a formatting test driving the tool with a fake critic/asset-critic via the registry path is heavy; instead test the pure summary by calling the tool against a minimal in-memory setup is also heavy. Use a thin unit on the summary helper. First, in Task-5 Step 2 we extract a pure `format_compose_summary(result)`; test it:

```python
from app.agent_tools import format_compose_summary
from app.scene.compose_loop import ComposeResult


def test_compose_summary_reports_asset_regenerations_and_notes():
    r = ComposeResult(elements_placed=2, passes=3, edits_applied=1,
                      regens_spent=2, assets_regenerated=1,
                      notes=["reel_frame: near-empty image (7600 bytes) -> regenerated",
                             "logo: asset ok", "scale logo: too big"])
    s = format_compose_summary(r)
    assert "2 element(s)" in s and "3 critique pass(es)" in s
    assert "1 asset regeneration(s)" in s
    assert "reel_frame: near-empty" in s and "logo: asset ok" in s
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py::test_compose_summary_reports_asset_regenerations_and_notes -v`
Expected: FAIL — `ImportError: cannot import name 'format_compose_summary'`.

- [ ] **Step 3: Extract + extend the summary formatter**

In `studio/backend/app/agent_tools.py`, replace the inline summary in `build_compose_scene_tool.compose_scene` with a module-level helper and call it:

```python
def format_compose_summary(result) -> str:
    head = (f"Composed {result.elements_placed} element(s) over "
            f"{result.passes} critique pass(es): {result.edits_applied} edit(s) "
            f"applied, {result.regens_spent} regeneration(s) "
            f"({result.assets_regenerated} asset regeneration(s)), "
            f"{result.rejected} edit(s) refused.")
    body = "\n".join(f"- {n}" for n in result.notes)
    return head + ("\n" + body if body else "")
```

And in the tool body, replace the `head`/`body`/return block with:

```python
        result = await run_compose(build, theme, deps)
        return format_compose_summary(result)
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_compose_scene_tool.py::test_compose_summary_reports_asset_regenerations_and_notes -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_compose_scene_tool.py
git commit -m "feat(scene): compose_scene summary surfaces asset + composition verdicts"
```

---

### Task 6: Authoritative backend replay e2e — the critic actually runs

The gate that would have caught the shipped bug: a real compose run through the live replay backend that **composites for real** (no fake capture responder) and asserts `passes > 0`, a degenerate asset is regenerated, a composition transform lands, and the loop converges.

**Files:**

- Create: `studio/backend/tests/fixtures/replay/run/compose-critique-loop.json`
- Create: `studio/backend/tests/fixtures/replay/asset/reel_frame.json`
- Create: `studio/backend/tests/fixtures/replay/critic/secretary.json` (composition transform — reuse if present from #119; otherwise create)
- Create: `studio/backend/tests/e2e/test_compose_critique.py`

**Interfaces:**

- Consumes: the `live_server` fixture (`tests/e2e/conftest.py`) at `PROVIDER_MODE=replay`; socket events `join_room`/`join_scene`/`send_prompt`/`run_completed`/`scene_snapshot`; the run-cassette shape (`tool_call_rounds`); the asset-critic cassettes (`load_asset_cassettes`); the composition-critic cassettes (`load_critic_cassettes`); `_make_room` pattern from `tests/e2e/test_scene_compose.py`. In replay mode the compositor reads the media files that `generate_and_place` writes from the comfy cassette — **no browser, no capture responder**.
- Produces: a passing non-browser e2e proving the bounded loop critiques for real and regenerates a degenerate asset.

- [ ] **Step 1: Write the run cassette**

Create `studio/backend/tests/fixtures/replay/run/compose-critique-loop.json` — one `compose_scene` call building a background then a reel frame:

```json
{
  "prompt": "build a pirate slot: a background and a reel frame in the center, and tidy it",
  "tool_call_rounds": [
    [
      {
        "name": "compose_scene",
        "args": {
          "theme": "pirate slot",
          "elements": [
            {
              "description": "a pirate cove background, full scene, no text, no words, no logo, no UI",
              "slot": "background",
              "size": "1280x720",
              "transparent": false,
              "role": "background",
              "fit": "cover",
              "z_index": 0
            },
            {
              "description": "an ornate pirate reel frame, transparent cutout",
              "slot": "reel_frame",
              "size": "768x768",
              "transparent": true,
              "role": "reel frame",
              "z_index": 5
            }
          ]
        }
      }
    ]
  ],
  "final": ["Built the background and reel frame, regenerated the empty frame, and tidied it."]
}
```

- [ ] **Step 2: Write the asset-critic cassette (the degenerate-asset path)**

Create `studio/backend/tests/fixtures/replay/asset/reel_frame.json`. The heuristic fires first on a genuinely-empty generation; this cassette also asserts a `regenerate` for the role so the path is exercised even if the comfy fixture isn't empty:

```json
{ "role": "reel frame", "ok": false, "action": "regenerate", "reason": "reel frame reads empty for its role" }
```

Create `studio/backend/tests/fixtures/replay/asset/default.json` (so other roles in this run pass cleanly):

```json
{ "ok": true, "action": "keep", "reason": "asset usable" }
```

- [ ] **Step 3: Write the composition-critic cassette**

Create `studio/backend/tests/fixtures/replay/critic/reel_frame.json` — pass 0 scales the reel frame, then done:

```json
{
  "target": "reel_frame",
  "passes": [
    {
      "done": false,
      "edits": [{ "target_handle": "reel_frame", "action": "scale", "params": { "scale": 0.8 }, "why": "shrink the frame so it sits inside the play area" }]
    },
    { "done": true, "edits": [] }
  ]
}
```

Ensure a `studio/backend/tests/fixtures/replay/critic/default.json` exists (one `done` pass) so the `background` target converges immediately — if absent, create:

```json
{ "passes": [{ "done": true, "edits": [] }] }
```

- [ ] **Step 4: Write the e2e**

Create `studio/backend/tests/e2e/test_compose_critique.py`:

```python
import asyncio

import httpx
import pytest
import socketio

PROMPT = ("build a pirate slot: a background and a reel frame in the center, "
          "and tidy it")


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "Compose Critique E2E"})).json()
    return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_compose_loop_critiques_for_real_and_regenerates_bad_asset(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)
    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received"
    assert run_completions[0]["status"] == "completed"

    # The compose_scene tool result must show the critic ACTUALLY RAN (passes > 0)
    # and that the degenerate reel frame was regenerated — the exact failures the
    # shipped loop had (0 passes, no regeneration). Pull the run from the API.
    async with httpx.AsyncClient(base_url=live_server) as http:
        runs = (await http.get(f"/rooms/{room_id}/runs")).json()
    summary = ""
    for run in runs:
        for step in run.get("steps", []):
            if step.get("tool_name") == "compose_scene" and step.get("type") == "tool_result":
                summary = step.get("content", "")
    assert summary, "no compose_scene tool result found"
    assert "0 critique pass(es)" not in summary, f"critic did not run: {summary}"
    assert "asset regeneration(s)" in summary
    assert "1 asset regeneration(s)" in summary or "asset ok" not in summary
    assert "regenerated" in summary.lower()

    # Both elements placed, and the reel frame got the composition scale (0.8).
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = scene_snapshots[-1]["document"]
    assert "spr.background" in doc["nodes"] and "spr.reel_frame" in doc["nodes"]
    assert doc["nodes"]["spr.reel_frame"]["props"]["scale"] == {"x": 0.8, "y": 0.8}

    await client.disconnect()
```

> If the `/rooms/{id}/runs` route shape differs, copy the exact run-fetch from an existing e2e (e.g. a `test_*` that reads runs) rather than guessing. The load-bearing assertions are `"0 critique pass(es)" not in summary` and the reel-frame scale.

- [ ] **Step 5: Run the e2e**

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_compose_critique.py -v`
Expected: PASS — the loop composites for real, regenerates the reel frame, applies the scale, converges. If the asset/critic cassette keys don't match the placed handles, confirm `role`/`slot` → `normalize_prompt` keys (`reel frame` → `reel frame`; the sprite handle is `reel_frame`). Use `superpowers:systematic-debugging`.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/tests/e2e/test_compose_critique.py studio/backend/tests/fixtures/replay/run/compose-critique-loop.json studio/backend/tests/fixtures/replay/asset/ studio/backend/tests/fixtures/replay/critic/
git commit -m "test(e2e): compose loop critiques for real + regenerates bad asset (replay)"
```

---

### Task 7: Whole-branch verification + PR

Final gate. No new code — verify every affected suite is green and open the PR.

**Files:** none (verification only).

- [ ] **Step 1: Backend unit suite**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS — `test_compositor.py`, `test_asset_critic.py`, `test_compose_loop.py`, `test_compose_scene_tool.py`, and all pre-existing suites.

- [ ] **Step 2: Backend e2e suite (replay)**

Run: `cd studio/backend && uv run pytest -m e2e -q`
Expected: PASS — the new `test_compose_critique.py`. Note any pre-existing environmental failures (e.g. `test_realize_parity` needs the Rust curate binary built; a full-suite ordering flake in `test_scene.py`) and confirm they are unrelated to this branch by running the new file in isolation.

- [ ] **Step 3: Prettier gate (markdown/docs)**

Run: `node_modules/.bin/prettier --check "docs/**/*.md"`
(Use the PINNED prettier in `node_modules/.bin`, not `npx prettier` — see memory `pinned-prettier-not-npx`.) If the spec/plan are flagged, run `--write` on them and commit the reformat.

- [ ] **Step 4: Whole-branch review**

Dispatch `superpowers:requesting-code-review` over `git diff main...HEAD`. Address findings via `superpowers:receiving-code-review`. Re-run Steps 1–2 after any change. Pay special attention to compositor↔engine layout parity (anchor/scale/zIndex) and the asset-critic heuristic thresholds.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/compose-critique
gh pr create --fill
```

---

## Self-Review

- **Spec coverage:**
  - _Per-asset quality critic (heuristic + vision)_ → Task 2 (`asset_critic.py`, `asset_heuristic`, Replay/Live/build). ✓
  - _Backend scene compositor faithful to engine layout_ → Task 1 (`composite_scene`/`collect_scene_images`, golden tests, `#0b0b0c` bg, anchor/scale/zIndex parity). ✓
  - _`run_compose` rewiring: place → asset-gate → composite → composition-critique_ → Task 3. ✓
  - _Fail-loud, never silent skip_ → Task 3 (render failure becomes a visible note). ✓
  - _Visible verdicts in chat_ → Tasks 3 (notes carry verdicts) + 5 (tool-result copy). ✓
  - _Capture demoted from critical path_ → Task 4 (tool guard drops broker; loop uses compositor). ✓
  - _Real deps wiring (ToolContext/RoomHub/main)_ → Task 4. ✓
  - _Authoritative replay e2e that asserts `passes > 0` + asset regenerated (closes the test gap)_ → Task 6. ✓
  - _Open decisions resolved:_ regen budget **shared** (Task 3); compositor fidelity = position/anchor/scale/zIndex/canvas/bg, fit baked into scale (Task 1); visibility = rich tool-result notes (Task 5); heuristic thresholds = named constants `EMPTY_BYTE_FLOOR`/`MIN_ALPHA_COVERAGE`/`MIN_OPAQUE_ENTROPY` (Task 2); asset critique lives in `run_compose` as `critique_asset` step (Task 3); asset-critic input = the bare asset image (Task 2). ✓
- **Placeholder scan:** every code step shows complete code; every run step an exact command + expected output. The one "copy the run-fetch from an existing e2e if the route differs" note (Task 6) is a guard against guessing an API shape, not a placeholder. ✓
- **Type consistency:** `render_scene`/`critique_asset` names match across `ComposeDeps` (Task 3), `_SceneComposeDeps` (Task 4), and `FakeDeps` (Task 3 tests). `AssetVerdict`/`AssetCritiqueRequest`/`asset_heuristic`/`build_asset_critic` identical across Tasks 2/3/4/6. `composite_scene`/`collect_scene_images`/`_texture_of` identical across Tasks 1/4. `format_compose_summary` defined + used in Task 5. `ComposeResult.assets_regenerated` defined in Task 3, formatted in Task 5, asserted in Task 6. ✓

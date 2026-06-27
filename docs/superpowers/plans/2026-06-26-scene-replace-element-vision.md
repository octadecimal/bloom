# Replace Any Scene Element via Scene Vision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the design-room agent replace any element already in the scene ("the background", "the flower on the left") by reading the scene and regenerating that element's art in place — instead of stacking a duplicate sprite.

**Architecture:** Add a read-only `read_scene` tool (built on the existing `_placed_elements` helper, extended with each sprite's position + size) so the agent can resolve a natural reference to an exact sprite. Update the `design-router` prompt so "replace X with a new look" routes to `regenerate_element` (which already swaps art in place) via `read_scene`, and guard branch 4 against duplicating an existing element. No frontend changes; `regenerate_element`'s mechanics are unchanged.

**Tech Stack:** Python 3 + FastAPI backend, LangChain `StructuredTool`, pytest (unit + non-browser e2e), recorded-real replay cassettes.

## Global Constraints

- **All work is in the worktree** `C:\code\bloom.wt\scene-replace-in-place` (branch `feat/scene-replace-in-place`, `BLOOM_PORT_OFFSET=1`). Never the primary checkout.
- **Backend commands run from `studio/backend` via `uv`** (uv is on PATH; works in Bash or PowerShell). Single-file unit run: `uv run pytest tests/<file>.py -v`. These unit tests use in-memory fakes — **no MongoDB needed**.
- **Full unit gate:** `cd studio/backend && uv run pytest -m "not e2e"` (this DOES need a local MongoDB on :27017 — `just mongo-up` if the service is stopped).
- **Backend e2e** (Task 3): `cd studio/backend && uv run pytest -m e2e tests/e2e/test_scene_replace_background.py -v`. The `live_server` fixture grabs a **free port** and uses `MONGO_DB=bloom_studio_e2e` (isolated from the user's live `:8000` data) — needs `mongod` running. Backend e2e runs in CI.
- **`read_scene` is the new tool name** everywhere (factory key, router binding, tool `name=`).
- **Conventional Commits** for every commit (`feat:`, `test:`, `docs:`…), imperative mood.
- **`prettier --check .` at repo root covers `.json` and `.md`** — the new replay cassettes (JSON) and any docs MUST be prettier-clean before pushing. (It does not check `.py`; match the surrounding Python style.)
- **The handle `read_scene` prints for a sprite is exactly the `ref` `regenerate_element` matches** — `_placed_elements` derives it as the node id minus the `spr.` prefix.

---

### Task 1: `read_scene` tool + position/size on placed elements

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (extend `PlacedElement` + `_placed_elements`; add `build_read_scene_tool`; register in `ToolFactory._BUILDERS`)
- Modify: `studio/backend/tests/test_agent_tools.py` (add `"read_scene"` to the exact `known_tool_names` set)
- Create: `studio/backend/tests/test_read_scene_tool.py`

**Interfaces:**

- Consumes: `ToolContext` (has `asset_store.list_assets(game_id)` and `scene_store.get_document(game_id)`); the existing `_placed_elements(document, assets) -> list[PlacedElement]` and `PlacedElement` dataclass (`agent_tools.py:570-612`).
- Produces:
  - `PlacedElement` gains `position: tuple[float, float] | None = None`, `size: tuple[int, int] | None = None`, `z_index: int = 0`.
  - `build_read_scene_tool(ctx: ToolContext) -> BaseTool` — a tool named `read_scene`, no args, returns a text listing of placed sprites.
  - `"read_scene"` registered in `ToolFactory._BUILDERS`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_read_scene_tool.py`:

```python
import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, ToolFactory, build_read_scene_tool
from app.assets.models import Asset, Generation


def _bg_doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.background": {"id": "spr.background", "type": "Sprite",
                               "props": {"role": "background", "position": {"x": 640, "y": 360},
                                         "scale": {"x": 1, "y": 1}, "zIndex": 0}},
            "tex.background": {"id": "tex.background", "type": "Texture",
                               "props": {"src": "/media/g1/a1/bg.png"}},
        },
        "edges": [
            {"id": "c1", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.background", "port": "parent"}},
            {"id": "d1", "type": "data", "from": {"node": "tex.background", "port": "data"},
             "to": {"node": "spr.background", "port": "texture"}},
        ],
    }


def _bg_asset():
    return Asset(
        id="a1", game_id="g1", name="Mystic Mountains", prompt="p", width=1280, height=720,
        workflow="schnell-opaque", slot="background",
        generations=[Generation(id="gen1", seed=1, image_ref="/media/g1/a1/bg.png",
                                created_at=datetime.now(timezone.utc))],
        selected_generation_id="gen1",
    )


class _Assets:
    def __init__(self, asset):
        self._asset = asset
    async def list_assets(self, game_id):
        return [self._asset]


class _SceneStore:
    def __init__(self, doc):
        self._doc = doc
    async def get_document(self, game_id):
        return self._doc


def _ctx(doc, asset):
    return ToolContext("r1", "g1", _Assets(asset), None, scene_store=_SceneStore(doc))


@pytest.mark.asyncio
async def test_read_scene_lists_placed_sprite_with_name_position_size():
    out = await build_read_scene_tool(_ctx(_bg_doc(), _bg_asset())).ainvoke({})
    assert "background" in out            # the handle (== regenerate_element ref)
    assert "Mystic Mountains" in out      # bound asset name
    assert "640" in out and "360" in out  # position
    assert "1280x720" in out              # size from the bound asset


@pytest.mark.asyncio
async def test_read_scene_empty_scene_is_friendly():
    out = await build_read_scene_tool(_ctx({"version": 1, "nodes": {}, "edges": []}, _bg_asset())).ainvoke({})
    assert "empty" in out.lower() or "nothing" in out.lower()


def test_factory_registers_read_scene():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "read_scene" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["read_scene"], ctx)[0].name == "read_scene"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_read_scene_tool.py -v`
Expected: FAIL — `ImportError: cannot import name 'build_read_scene_tool'`.

- [ ] **Step 3: Extend `PlacedElement` + `_placed_elements`**

In `studio/backend/app/agent_tools.py`, replace the `PlacedElement` dataclass (currently at ~line 570) with:

```python
@dataclass
class PlacedElement:
    """A sprite that is placed in the scene, joined to its texture and asset."""
    sprite_id: str
    texture_id: str | None
    handle: str
    role: str
    asset: object | None
    src: str | None
    position: tuple[float, float] | None = None
    size: tuple[int, int] | None = None
    z_index: int = 0
```

Then in `_placed_elements` (the loop body that builds each element), replace the final `out.append(...)` line with this block that derives position/size/z from the node props and bound asset:

```python
        pos = props.get("position") or {}
        position = (pos["x"], pos["y"]) if ("x" in pos and "y" in pos) else None
        z_index = int(props.get("zIndex", 0) or 0)
        size = None
        if asset is not None:
            w = getattr(asset, "width", None)
            h = getattr(asset, "height", None)
            if w and h:
                size = (int(w), int(h))
        out.append(PlacedElement(nid, tex_id, handle, role, asset, src,
                                 position=position, size=size, z_index=z_index))
```

(`props` is already bound earlier in that loop as `props = n.get("props") or {}`.)

- [ ] **Step 4: Add `build_read_scene_tool`**

In `studio/backend/app/agent_tools.py`, add this function immediately after `build_regenerate_element_tool` (after its `return StructuredTool...` block, ~line 308):

```python
def build_read_scene_tool(ctx: ToolContext) -> BaseTool:
    async def read_scene() -> str:
        document = await ctx.scene_store.get_document(ctx.game_id)
        if not document or not document.get("nodes"):
            return "The scene is empty; nothing is placed yet."
        assets = await ctx.asset_store.list_assets(ctx.game_id)
        els = _placed_elements(document, assets)
        if not els:
            return "The scene is empty; nothing is placed yet."
        lines = []
        for el in els:
            name = getattr(el.asset, "name", None) or "(unbound)"
            pos = f"({el.position[0]:g},{el.position[1]:g})" if el.position else "(?,?)"
            size = f"{el.size[0]}x{el.size[1]}" if el.size else "?x?"
            role = f" {el.role}" if el.role else ""
            lines.append(f'- {el.handle}{role} "{name}" pos={pos} size={size} z={el.z_index}')
        return "Placed in the scene:\n" + "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=read_scene, name="read_scene",
        description=(
            "Read the current scene: every placed sprite with its handle, role, bound "
            "asset name, position (x,y), size (WxH) and z-index. Use this to find which "
            "element the user means — by name OR position, e.g. 'the flower on the left' "
            "— before changing it, then call regenerate_element with that exact handle "
            "as `ref`. Takes no arguments."
        ),
    )
```

- [ ] **Step 5: Register `read_scene` in the factory**

In `ToolFactory._BUILDERS` (~line 938), add the entry right after the `regenerate_element` line:

```python
        "regenerate_element": build_regenerate_element_tool,
        "read_scene": build_read_scene_tool,
```

- [ ] **Step 6: Update the exact `known_tool_names` assertion**

In `studio/backend/tests/test_agent_tools.py`, the `test_known_tool_names` set asserts the full registry with `==`. Add `"read_scene"` to it (next to `"regenerate_element"`):

```python
        "regenerate_element",
        "read_scene",
    }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_read_scene_tool.py tests/test_agent_tools.py -v`
Expected: PASS (the 3 new read_scene tests + the updated `test_known_tool_names`; `test_agent_tools.py` tests that hit `mongo_db` need MongoDB up — if it is stopped, run just `tests/test_read_scene_tool.py` plus `tests/test_agent_tools.py::test_known_tool_names`, which uses no DB).

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_read_scene_tool.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(scene): read_scene tool exposes placed sprites with position and size"
```

---

### Task 2: Route "replace X with a new look" to `regenerate_element` via `read_scene`

**Files:**

- Modify: `studio/backend/app/gdd/router.py` (bind `read_scene`; broaden branch 5; guard branch 4)
- Modify: `studio/backend/tests/test_design_router.py` (new prose assertions)

**Interfaces:**

- Consumes: `build_design_router_spec()` returns a `SkillSpec` whose `.tools` (a sorted list) and `.body` (the prompt) are asserted by tests; `"read_scene"` is now a known tool (Task 1).
- Produces: the router spec binds `read_scene`; the prompt routes replace/change requests for existing elements to `read_scene` → `regenerate_element`.

- [ ] **Step 1: Write the failing tests**

Append to `studio/backend/tests/test_design_router.py`:

```python
def test_router_binds_read_scene():
    spec = build_design_router_spec()
    assert "read_scene" in spec.tools
    assert "read_scene" in spec.body


def test_router_replace_uses_read_scene_to_target_then_regenerates_in_place():
    low = build_design_router_spec().body.lower()
    # "replace … with a new look" is handled as an in-place regenerate
    assert "replace" in low
    assert "regenerate_element" in low
    # the agent reads the scene to resolve which element (incl. a positional ref)
    assert "read_scene" in low
    assert "on the left" in low
    # branch 4 still warns against duplicating something already placed
    assert "duplicate" in low
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest tests/test_design_router.py -v`
Expected: FAIL — `read_scene` not in `spec.tools`/`body`; `"on the left"` not in body.

- [ ] **Step 3: Bind `read_scene` in the router spec**

In `studio/backend/app/gdd/router.py`, in `build_design_router_spec`, add `"read_scene"` to the tool set passed to `sorted(...)`:

```python
        tools=sorted(
            GDD_TOOL_NAMES
            | {"realize_symbol", "generate_asset", "add_sprite", "list_assets",
               "generate_and_place", "regenerate_element", "read_scene"}
        ),
```

- [ ] **Step 4: Guard branch 4 against duplicating an existing element**

In `_BODY_TEMPLATE`, branch 4 currently ends with the sentence about building several elements ("…just keep each generate+place paired and sequential."). Immediately after that sentence (still inside point 4), add:

```
   If the user is CHANGING or REPLACING something that is ALREADY in the scene
   rather than adding a brand-new element, do NOT generate_and_place it — that
   stacks a duplicate sprite. Handle it as a regenerate (point 5); call
   `read_scene` first if you are unsure whether the element is already placed.
```

- [ ] **Step 5: Broaden branch 5 to cover "replace X with a new look" + positional targeting**

In `_BODY_TEMPLATE`, replace the entire point 5 (the block beginning `5. A request to FIX, REDO, REGENERATE, or REPLACE an element that is ALREADY` and ending at `…call it again with the exact \`ref\`.`) with:

```
5. A request to FIX, REDO, REGENERATE, REPLACE, or CHANGE an element that is
   ALREADY in the scene — addressed by name OR position (e.g. "regenerate the
   seaweed, it's cut off at the top", "redo the logo", "that background is wrong,
   make it again", "replace the background with something sunnier", "replace the
   flower on the left with a red rose"): swap that element's art IN PLACE with
   `regenerate_element`. When the reference is not an obvious exact handle — a
   positional cue like "on the left", or one of several similar elements — FIRST
   call `read_scene` (it lists every placed sprite with its handle, role, bound
   asset name, position and size), pick the element the user means, THEN call
   `regenerate_element` with that element's EXACT handle as `ref`. Pass a refined
   `description` for the new look (e.g. "a bright sunny coastal landscape, no
   text"); omit `description` to just re-roll the current art. This keeps the
   element's position and z-index. Do NOT use `generate_and_place` for something
   already in the scene — that adds a duplicate sprite. If `regenerate_element`
   reports several matches, call it again with the exact `ref` from `read_scene`.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest tests/test_design_router.py -v`
Expected: PASS — all new assertions plus the pre-existing router tests (which still find "generate_and_place", "in place", "already in the scene", "duplicate", "no text", etc.).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/gdd/router.py studio/backend/tests/test_design_router.py
git commit -m "feat(scene): route replace/change of a placed element to read_scene + regenerate_element"
```

---

### Task 3: Backend e2e — replace the background in place (no duplicate)

**Files:**

- Create: `studio/backend/tests/fixtures/replay/run/compose-background.json`
- Create: `studio/backend/tests/fixtures/replay/run/replace-background.json`
- Create: `studio/backend/tests/e2e/test_scene_replace_background.py`

**Interfaces:**

- Consumes: the `live_server` fixture (`tests/e2e/conftest.py`) — a replay backend on a free port with `MONGO_DB=bloom_studio_e2e`; the Socket.IO `send_prompt` / `run_completed` / `scene_snapshot` flow (mirrors `tests/e2e/test_scene_regenerate.py`). The replay LLM emits the cassettes' `tool_call_rounds`; the REAL `generate_and_place`, `read_scene`, and `regenerate_element` tools execute.
- Produces: proof that "replace the background with something sunnier" ends with exactly ONE background sprite, repainted in place.

- [ ] **Step 1: Write the failing e2e test**

Create `studio/backend/tests/e2e/test_scene_replace_background.py`:

```python
"""Backend non-browser e2e: replacing the background swaps it IN PLACE.

Under PROVIDER_MODE=replay, "add a misty mountain background" composes one
background sprite, then "replace the background with something sunnier" routes
through the design-router: the agent calls read_scene to find the placed
background, then regenerate_element to re-roll its art and rewrite the bound
Texture src in place. The scene ends with exactly ONE background sprite (the
duplicate-sprite bug does not recur) and the asset has two generations.

Cassettes: run/compose-background.json, run/replace-background.json (prompt-keyed).
"""
import asyncio

import httpx
import pytest
import socketio

COMPOSE = "add a misty mountain background"
REPLACE = "replace the background with something sunnier"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "ReplaceBgE2E"})).json()
        return room["id"], room["gameId"]


async def _run_prompt(client, room_id, text, completions):
    completions.clear()
    await client.emit("send_prompt", {"roomId": room_id, "text": text})
    deadline = asyncio.get_running_loop().time() + 40
    while not completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert completions, f"run_completed not received for: {text}"
    assert completions[0]["status"] == "completed", f"run failed: {completions}"


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_replace_background_swaps_in_place(live_server):
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

    # 1) compose a single background
    await _run_prompt(client, room_id, COMPOSE, run_completions)
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    bg = next(a for a in assets if a.get("slot") == "background")
    assert len(bg.get("generations") or []) == 1, "expected one generation after compose"

    # 2) replace it with a sunnier version
    await _run_prompt(client, room_id, REPLACE, run_completions)
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    bg = next(a for a in assets if a.get("slot") == "background")
    gens = bg.get("generations") or []
    assert len(gens) == 2, f"expected two generations after replace: {bg}"
    newest_ref = gens[-1]["imageRef"]

    # scene has EXACTLY ONE background sprite (no duplicate), repainted to newest gen
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received"
    nodes = scene_snapshots[-1]["document"]["nodes"]

    sprites = [nid for nid, n in nodes.items() if n["type"] == "Sprite"]
    assert sprites == ["spr.background"], f"expected one background sprite, got {sprites}"
    textures = [nid for nid, n in nodes.items() if n["type"] == "Texture"]
    assert textures == ["tex.background"], f"expected one background texture, got {textures}"
    assert nodes["tex.background"]["props"]["src"] == newest_ref, "texture not repainted to newest gen"

    await client.disconnect()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_scene_replace_background.py -v`
Expected: FAIL — no cassette for the `COMPOSE`/`REPLACE` prompts (the replay provider can't satisfy the run). Ensure `mongod` is running first (`just mongo-up`).

- [ ] **Step 3: Add the compose cassette**

Create `studio/backend/tests/fixtures/replay/run/compose-background.json`:

```json
{
  "prompt": "add a misty mountain background",
  "tool_call_rounds": [
    [
      {
        "name": "generate_and_place",
        "args": {
          "description": "a misty coastal mountain landscape, no text, no words, no letters",
          "slot": "background",
          "size": "1280x720",
          "transparent": false,
          "role": "background",
          "fit": "cover",
          "z_index": 0
        }
      }
    ]
  ],
  "final": ["Added a misty mountain background."]
}
```

- [ ] **Step 4: Add the replace cassette**

Create `studio/backend/tests/fixtures/replay/run/replace-background.json`. Two rounds: the agent reads the scene, then regenerates the background it found, in place.

```json
{
  "prompt": "replace the background with something sunnier",
  "tool_call_rounds": [
    [{ "name": "read_scene", "args": {} }],
    [
      {
        "name": "regenerate_element",
        "args": {
          "ref": "background",
          "description": "a bright sunny coastal mountain landscape, warm light, no text, no words, no letters"
        }
      }
    ]
  ],
  "final": ["Replaced the background with a sunnier version, in place."]
}
```

- [ ] **Step 5: Run the e2e to verify it passes**

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_scene_replace_background.py -v`
Expected: PASS — one `spr.background` sprite, one `tex.background` texture repainted to the second generation; the background asset has 2 generations.

- [ ] **Step 6: Confirm the cassettes are prettier-clean**

Run (from the worktree root `C:\code\bloom.wt\scene-replace-in-place`): `npx prettier --check studio/backend/tests/fixtures/replay/run/compose-background.json studio/backend/tests/fixtures/replay/run/replace-background.json`
Expected: "All matched files use Prettier code style!" (if not, `npx prettier --write` them and re-check).

- [ ] **Step 7: Commit**

```bash
git add studio/backend/tests/e2e/test_scene_replace_background.py studio/backend/tests/fixtures/replay/run/compose-background.json studio/backend/tests/fixtures/replay/run/replace-background.json
git commit -m "test(scene): backend e2e for replacing the background in place"
```

---

## Final verification (before PR)

- [ ] Full backend unit suite green: `cd studio/backend && uv run pytest -m "not e2e"` (needs `mongod`).
- [ ] Backend e2e green: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_scene_replace_background.py tests/e2e/test_scene_regenerate.py -v` (the regenerate e2e is a neighbor that must still pass).
- [ ] `npx prettier --check .` at the worktree root passes (covers the new JSON cassettes + this plan/spec).
- [ ] Push and open a PR: `git push -u origin feat/scene-replace-in-place && gh pr create`.

## Notes for the implementer

- **Do not change `regenerate_element` or `_regenerate_and_rebind`** — they already swap art in place. The fix is `read_scene` + routing only.
- **`read_scene` takes no arguments** and is read-only (never mutates the scene).
- **The handle is the contract:** `read_scene` prints `el.handle` (node id minus `spr.`), and that exact string is what `regenerate_element`'s `ref` matches. Keep them identical.
- **Position can be legitimately `0`** — `_placed_elements` checks `"x" in pos and "y" in pos` (not truthiness) so a sprite at x=0 is still reported.

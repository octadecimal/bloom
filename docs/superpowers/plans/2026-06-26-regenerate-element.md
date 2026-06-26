# Regenerate-Element Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a general `regenerate_element` agent tool that replaces a placed scene element's art in place (swapping its bound `Texture.src`) instead of adding a duplicate sprite, and refactor `realize_symbol` onto the shared core.

**Architecture:** A shared `_regenerate_and_rebind` core does the regenerate-asset + select-newest + rewrite-texture-src step. A pure resolver enumerates placed sprites and fuzzy-matches a `ref` against each sprite's slot/role/asset-name. The new `regenerate_element` tool wires resolver → core; `realize_symbol` keeps its GDD front-end and calls the core. A new design-router branch routes "fix/redo/regenerate an on-screen element" to the tool.

**Tech Stack:** Python 3.12, FastAPI, LangChain `StructuredTool`, pytest (`-m "not e2e"` unit, `-m e2e` non-browser e2e), `uv` runner, MongoDB (replay test DB), prompt-keyed replay cassettes.

## Global Constraints

- All work happens in the worktree `C:\code\bloom.wt\regenerate-element` (branch `feat/regenerate-element`, `BLOOM_PORT_OFFSET=2`). Never touch the primary checkout.
- Run backend unit tests with: `cd studio/backend && uv run pytest -m "not e2e" <path> -v`.
- Run backend e2e with: `cd studio/backend && uv run pytest -m e2e <path> -v` (the `live_server` fixture starts its own replay server; no separate backend needed).
- Commit messages use Conventional Commits (`feat:`, `refactor:`, `test:`, `docs:`), imperative mood. End each commit body with the two trailer lines used in this repo (`Co-Authored-By:` and `Claude-Session:`).
- TypeScript interfaces use an `I` prefix (no TS in this plan, but the rule stands).
- Backgrounds/scene prose conventions already in the router are kept verbatim; only additive edits.

---

### Task 1: Shared `_regenerate_and_rebind` core + refactor `realize_symbol`

**Files:**
- Modify: `studio/backend/app/agent_tools.py` (add `_regenerate_and_rebind`; refactor `realize_symbol` body, lines ~533-576)
- Test: `studio/backend/tests/test_regenerate_core.py` (create)
- Guard (must stay green): `studio/backend/tests/test_realize_symbol.py`, `studio/backend/tests/e2e/test_realize_parity.py`

**Interfaces:**
- Produces: `async def _regenerate_and_rebind(ctx: ToolContext, *, asset, texture_id: str | None, new_prompt: str | None) -> str | None` — updates the asset prompt (if `new_prompt` truthy), regenerates and selects the newest generation, then issues ONE `setProp` writing the new `image_ref` into `texture_id` (skipped when `texture_id is None`). Returns the new `image_ref`, or `None` if regeneration produced no image (scene untouched in that case).
- Consumes: `ctx.asset_store.update_asset`, `ctx.asset_hub.generate_and_wait`, `ctx.asset_store.get_asset`, `ctx.asset_store.select_generation`, `ctx.scene_hub.apply_op` (all already used by today's `realize_symbol`).

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_regenerate_core.py`:

```python
import pytest
from datetime import datetime, timezone

from app.agent_tools import ToolContext, _regenerate_and_rebind
from app.assets.models import Asset, Generation


def _asset_with_two_gens():
    return Asset(
        id="a1", game_id="g1", name="Seaweed", prompt="old prompt",
        width=512, height=512, workflow="schnell-transparent", slot="seaweed",
        generations=[
            Generation(id="gen1", seed=1, image_ref="/media/g1/a1/old.png",
                       created_at=datetime.now(timezone.utc)),
            Generation(id="gen2", seed=2, image_ref="/media/g1/a1/new.png",
                       created_at=datetime.now(timezone.utc)),
        ],
        selected_generation_id="gen1",
    )


class _AssetStore:
    def __init__(self, asset):
        self._asset = asset
        self.updated = None
        self.selected = None
    async def update_asset(self, asset_id, **fields):
        self.updated = fields
        return None
    async def get_asset(self, asset_id):
        return self._asset
    async def select_generation(self, asset_id, gen_id):
        self.selected = gen_id
        return None


class _NoImageStore(_AssetStore):
    async def get_asset(self, asset_id):
        return None


class _AssetHub:
    def __init__(self):
        self.calls = []
    async def generate_and_wait(self, game_id, asset_id):
        self.calls.append(asset_id)


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


@pytest.mark.asyncio
async def test_core_regenerates_selects_newest_and_rewrites_texture():
    asset = _asset_with_two_gens()
    store, hub, shub = _AssetStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id="tex.seaweed", new_prompt="fresh seaweed")

    assert ref == "/media/g1/a1/new.png"          # newest generation
    assert store.updated == {"prompt": "fresh seaweed"}
    assert hub.calls == ["a1"]
    assert store.selected == "gen2"
    assert shub.ops == [{                           # exactly one in-place setProp
        "kind": "setProp", "id": "tex.seaweed", "path": "src",
        "value": "/media/g1/a1/new.png",
    }]


@pytest.mark.asyncio
async def test_core_skips_setprop_when_texture_is_none():
    asset = _asset_with_two_gens()
    store, hub, shub = _AssetStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id=None, new_prompt=None)

    assert ref == "/media/g1/a1/new.png"
    assert store.updated is None                    # new_prompt falsy -> no prompt update
    assert store.selected == "gen2"
    assert shub.ops == []                           # no scene write when no texture


@pytest.mark.asyncio
async def test_core_returns_none_when_no_image():
    asset = _asset_with_two_gens()
    store, hub, shub = _NoImageStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id="tex.seaweed", new_prompt="x")

    assert ref is None
    assert shub.ops == []                           # scene untouched
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_regenerate_core.py -v`
Expected: FAIL with `ImportError: cannot import name '_regenerate_and_rebind'`.

- [ ] **Step 3: Add the core function**

In `studio/backend/app/agent_tools.py`, add this function immediately ABOVE `def build_realize_symbol_tool` (just after `_find_symbol_sprite`):

```python
async def _regenerate_and_rebind(
    ctx: ToolContext, *, asset, texture_id: str | None, new_prompt: str | None,
) -> str | None:
    """Regenerate an asset's art and rewrite a bound Texture's src in place.

    Updates the asset prompt (when ``new_prompt`` is truthy), regenerates and
    selects the newest generation, then issues ONE ``setProp`` writing the new
    ``image_ref`` into ``texture_id`` (skipped when ``texture_id is None``).
    Returns the new ``image_ref``, or ``None`` if regeneration produced no image
    — in which case the scene is left untouched.
    """
    if new_prompt:
        await ctx.asset_store.update_asset(asset.id, prompt=new_prompt)
    await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
    refreshed = await ctx.asset_store.get_asset(asset.id)
    if refreshed is None or not refreshed.generations:
        return None
    newest = refreshed.generations[-1]
    await ctx.asset_store.select_generation(asset.id, newest.id)
    if texture_id is not None:
        await ctx.scene_hub.apply_op(
            ctx.game_id,
            {"kind": "setProp", "id": texture_id, "path": "src",
             "value": newest.image_ref},
        )
    return newest.image_ref
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_regenerate_core.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Refactor `realize_symbol` onto the core**

In `studio/backend/app/agent_tools.py`, replace the body of `realize_symbol` (inside `build_realize_symbol_tool`) — keep the GDD lookup and asset resolution, then delegate regeneration to the core. Replace from `await ctx.asset_store.update_asset(asset.id, prompt=art_desc)` through the final `return` with:

```python
        # 3. resolve the bound sprite/texture, then regenerate + rebind via the
        #    shared core. texture_id=None still regenerates the board art but skips
        #    the scene write, preserving the "regenerated but not placed" message.
        document = await ctx.scene_store.get_document(ctx.game_id)
        found = _find_symbol_sprite(document or {}, slot) if document else None
        texture_id = found[1] if found else None
        new_ref = await _regenerate_and_rebind(
            ctx, asset=asset, texture_id=texture_id, new_prompt=art_desc)
        if new_ref is None:
            return f"Regeneration for slot '{slot}' produced no image."
        if found is None:
            return (f"Regenerated slot '{slot}', but no scene Sprite is labeled "
                    f"with it; the rendered game was not updated.")
        return f"Reshaped symbol '{slot}': regenerated its art and re-rendered the game."
```

The lines being removed are the old steps 2-3 (the inline `update_asset` / `generate_and_wait` / `get_asset` / `select_generation` block and the old document/setProp block). Keep steps 1 (GDD read) and the `get_by_slot` resolution above them unchanged.

- [ ] **Step 6: Run the realize_symbol suite to verify parity**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_realize_symbol.py tests/test_regenerate_core.py -v`
Expected: PASS (all). The two existing `realize_symbol` tests still assert `updated == {"prompt": "a fierce dragon"}`, `selected == "genNEW"`, the single `setProp` op, and the "produced no image" message.

- [ ] **Step 7: Commit**

```bash
cd "C:/code/bloom.wt/regenerate-element"
git add studio/backend/app/agent_tools.py studio/backend/tests/test_regenerate_core.py
git commit -m "refactor: extract _regenerate_and_rebind core from realize_symbol"
```

---

### Task 2: Placed-element resolver

**Files:**
- Modify: `studio/backend/app/agent_tools.py` (add `PlacedElement`, `_texture_of`, `_placed_elements`, `_resolve_placed_elements`)
- Test: `studio/backend/tests/test_placed_resolver.py` (create)

**Interfaces:**
- Produces:
  - `@dataclass class PlacedElement` with fields `sprite_id: str`, `texture_id: str | None`, `handle: str`, `role: str`, `asset` (object or None), `src: str | None`.
  - `def _texture_of(document: dict, sprite_id: str) -> str | None` — the Texture node id bound to a sprite's `texture` port, or None.
  - `def _placed_elements(document: dict, assets: list) -> list[PlacedElement]` — one entry per Sprite node, joined to its bound texture and (by `slot`/`id` == handle) to an asset.
  - `def _resolve_placed_elements(document: dict, assets: list, ref: str) -> list[PlacedElement]` — `_placed_elements` filtered to those whose `handle`, `role`, or asset `name` contains `ref` (case-insensitive). Empty `ref` matches nothing.
- Consumes: nothing new (pure functions over a scene document dict + a list of Asset-like objects with `.slot`, `.id`, `.name`).

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_placed_resolver.py`:

```python
from dataclasses import dataclass

from app.agent_tools import (
    _texture_of, _placed_elements, _resolve_placed_elements,
)


@dataclass
class _A:           # minimal Asset stand-in
    id: str
    slot: str
    name: str


def _doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.background": {"id": "spr.background", "type": "Sprite",
                               "props": {"role": "background"}},
            "tex.background": {"id": "tex.background", "type": "Texture",
                               "props": {"src": "/media/bg.png"}},
            "spr.seaweed": {"id": "spr.seaweed", "type": "Sprite",
                            "props": {"role": "prop"}},
            "tex.seaweed": {"id": "tex.seaweed", "type": "Texture",
                            "props": {"src": "/media/sea.png"}},
        },
        "edges": [
            {"id": "c1", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.background", "port": "parent"}},
            {"id": "d1", "type": "data", "from": {"node": "tex.background", "port": "data"},
             "to": {"node": "spr.background", "port": "texture"}},
            {"id": "c2", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.seaweed", "port": "parent"}},
            {"id": "d2", "type": "data", "from": {"node": "tex.seaweed", "port": "data"},
             "to": {"node": "spr.seaweed", "port": "texture"}},
        ],
    }


_ASSETS = [_A("a1", "background", "Background"), _A("a2", "seaweed", "Seaweed")]


def test_texture_of_resolves_bound_texture():
    assert _texture_of(_doc(), "spr.seaweed") == "tex.seaweed"
    assert _texture_of(_doc(), "spr.nope") is None


def test_placed_elements_lists_each_sprite_joined_to_asset_and_texture():
    els = _placed_elements(_doc(), _ASSETS)
    by_handle = {e.handle: e for e in els}
    assert set(by_handle) == {"background", "seaweed"}
    sea = by_handle["seaweed"]
    assert sea.sprite_id == "spr.seaweed"
    assert sea.texture_id == "tex.seaweed"
    assert sea.role == "prop"
    assert sea.asset is not None and sea.asset.name == "Seaweed"
    assert sea.src == "/media/sea.png"


def test_resolve_matches_by_handle_role_or_asset_name_case_insensitive():
    # by handle
    assert [e.handle for e in _resolve_placed_elements(_doc(), _ASSETS, "seaweed")] == ["seaweed"]
    # by asset name, different case
    assert [e.handle for e in _resolve_placed_elements(_doc(), _ASSETS, "SEAWEED")] == ["seaweed"]
    # by role
    assert [e.handle for e in _resolve_placed_elements(_doc(), _ASSETS, "background")] == ["background"]


def test_resolve_returns_empty_for_no_match_and_for_empty_ref():
    assert _resolve_placed_elements(_doc(), _ASSETS, "treasure") == []
    assert _resolve_placed_elements(_doc(), _ASSETS, "") == []


def test_resolve_returns_multiple_when_ref_is_ambiguous():
    doc = _doc()
    doc["nodes"]["spr.seaweed_left"] = {"id": "spr.seaweed_left", "type": "Sprite",
                                        "props": {"role": "prop"}}
    doc["nodes"]["spr.seaweed_right"] = {"id": "spr.seaweed_right", "type": "Sprite",
                                         "props": {"role": "prop"}}
    handles = sorted(e.handle for e in _resolve_placed_elements(doc, _ASSETS, "seaweed"))
    assert handles == ["seaweed", "seaweed_left", "seaweed_right"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_placed_resolver.py -v`
Expected: FAIL with `ImportError: cannot import name '_texture_of'`.

- [ ] **Step 3: Add the resolver**

In `studio/backend/app/agent_tools.py`, add immediately ABOVE `def _find_symbol_sprite` (the `dataclass` import already exists at the top of the file):

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


def _texture_of(document: dict, sprite_id: str) -> str | None:
    """The Texture node id bound to a sprite's `texture` port, or None."""
    for e in document.get("edges", []):
        if (e.get("type") == "data" and e["to"]["node"] == sprite_id
                and e["to"]["port"] == "texture"):
            return e["from"]["node"]
    return None


def _placed_elements(document: dict, assets: list) -> list[PlacedElement]:
    """One PlacedElement per Sprite node, joined to its bound texture and (by the
    handle derived from the `spr.{handle}` id, matched against asset slot or id)
    to an asset on the board."""
    nodes = document.get("nodes", {})
    out: list[PlacedElement] = []
    for nid, n in nodes.items():
        if n.get("type") != "Sprite":
            continue
        props = n.get("props") or {}
        handle = nid[len("spr."):] if nid.startswith("spr.") else nid
        role = props.get("role") or ""
        tex_id = _texture_of(document, nid)
        src = (nodes.get(tex_id) or {}).get("props", {}).get("src") if tex_id else None
        asset = next(
            (a for a in assets
             if getattr(a, "slot", None) == handle or getattr(a, "id", None) == handle),
            None,
        )
        out.append(PlacedElement(nid, tex_id, handle, role, asset, src))
    return out


def _resolve_placed_elements(document: dict, assets: list, ref: str) -> list[PlacedElement]:
    """Placed elements whose handle, role, or asset name contains `ref`
    (case-insensitive). An empty `ref` matches nothing."""
    needle = ref.strip().lower()
    if not needle:
        return []
    out = []
    for el in _placed_elements(document, assets):
        name = (getattr(el.asset, "name", "") or "").lower()
        if needle in el.handle.lower() or needle in el.role.lower() or needle in name:
            out.append(el)
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_placed_resolver.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd "C:/code/bloom.wt/regenerate-element"
git add studio/backend/app/agent_tools.py studio/backend/tests/test_placed_resolver.py
git commit -m "feat: add placed-element resolver for scene regeneration"
```

---

### Task 3: `regenerate_element` tool + factory registration

**Files:**
- Modify: `studio/backend/app/agent_tools.py` (add `_placed_summary`, `build_regenerate_element_tool`; register in `ToolFactory._BUILDERS`)
- Test: `studio/backend/tests/test_regenerate_element_tool.py` (create)

**Interfaces:**
- Consumes: `_resolve_placed_elements`, `_placed_elements`, `_regenerate_and_rebind` (Tasks 1-2); `ctx.scene_store.get_document`, `ctx.asset_store.list_assets`, `ctx.asset_store.get_by_slot`, `ctx.asset_store.get_asset`.
- Produces: `def build_regenerate_element_tool(ctx: ToolContext) -> BaseTool` named `regenerate_element` with args `ref: str`, `description: str = ""`; registered under key `"regenerate_element"` in `ToolFactory._BUILDERS`.

- [ ] **Step 1: Write the failing test**

Create `studio/backend/tests/test_regenerate_element_tool.py`:

```python
import pytest
from datetime import datetime, timezone

from app.agent_tools import (
    ToolContext, ToolFactory, build_regenerate_element_tool,
)
from app.assets.models import Asset, Generation


def _seaweed_doc():
    return {
        "version": 1,
        "nodes": {
            "root": {"id": "root", "type": "Root", "props": {"width": 1280, "height": 720}},
            "spr.seaweed": {"id": "spr.seaweed", "type": "Sprite",
                            "props": {"role": "prop", "position": {"x": 640, "y": 720},
                                      "scale": {"x": 1, "y": 1}, "zIndex": 2}},
            "tex.seaweed": {"id": "tex.seaweed", "type": "Texture",
                            "props": {"src": "/media/g1/a1/old.png"}},
        },
        "edges": [
            {"id": "c2", "type": "child", "from": {"node": "root", "port": "children"},
             "to": {"node": "spr.seaweed", "port": "parent"}},
            {"id": "d2", "type": "data", "from": {"node": "tex.seaweed", "port": "data"},
             "to": {"node": "spr.seaweed", "port": "texture"}},
        ],
    }


def _seaweed_asset():
    return Asset(
        id="a1", game_id="g1", name="Seaweed", prompt="old", width=512, height=512,
        workflow="schnell-transparent", slot="seaweed",
        generations=[Generation(id="gen1", seed=1, image_ref="/media/g1/a1/old.png",
                                created_at=datetime.now(timezone.utc))],
        selected_generation_id="gen1",
    )


class _Assets:
    def __init__(self, asset):
        self._asset = asset
        self.updated = None
        self.selected = None
    async def list_assets(self, game_id):
        return [self._asset]
    async def get_by_slot(self, game_id, slot):
        return self._asset if slot == self._asset.slot else None
    async def get_asset(self, asset_id):
        return self._asset
    async def update_asset(self, asset_id, **fields):
        self.updated = fields
        return None
    async def select_generation(self, asset_id, gen_id):
        self.selected = gen_id
        return None


class _Hub:
    async def generate_and_wait(self, game_id, asset_id):
        # "generate" appends a fresh selected generation
        self._asset.generations.append(
            Generation(id="gen2", seed=2, image_ref="/media/g1/a1/new.png",
                       created_at=datetime.now(timezone.utc)))
    def bind(self, asset):
        self._asset = asset
        return self


class _SceneStore:
    def __init__(self, doc):
        self._doc = doc
    async def get_document(self, game_id):
        return self._doc


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


def _ctx(doc, asset):
    assets = _Assets(asset)
    hub = _Hub().bind(asset)
    return ToolContext("r1", "g1", assets, hub,
                       scene_store=_SceneStore(doc), scene_hub=_SceneHub()), assets


@pytest.mark.asyncio
async def test_regenerate_element_swaps_src_in_place_without_new_nodes():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    ctx, assets = _ctx(doc, asset)
    before_nodes = set(doc["nodes"])

    out = await build_regenerate_element_tool(ctx).ainvoke(
        {"ref": "seaweed", "description": "full seaweed, not cropped"})

    # regenerated (prompt updated, newest selected), rewrote the SAME texture
    assert assets.updated == {"prompt": "full seaweed, not cropped"}
    assert assets.selected == "gen2"
    assert ctx.scene_hub.ops == [{
        "kind": "setProp", "id": "tex.seaweed", "path": "src",
        "value": "/media/g1/a1/new.png",
    }]
    # NO new nodes added (the duplicate-sprite bug cannot recur)
    assert set(doc["nodes"]) == before_nodes
    assert "Regenerated" in out and "seaweed" in out


@pytest.mark.asyncio
async def test_regenerate_element_without_description_rerolls_same_prompt():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    ctx, assets = _ctx(doc, asset)

    await build_regenerate_element_tool(ctx).ainvoke({"ref": "seaweed"})

    assert assets.updated is None          # no prompt change
    assert assets.selected == "gen2"       # still re-rolled + rebound
    assert ctx.scene_hub.ops[0]["id"] == "tex.seaweed"


@pytest.mark.asyncio
async def test_regenerate_element_no_match_lists_placed_and_changes_nothing():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    ctx, _ = _ctx(doc, asset)

    out = await build_regenerate_element_tool(ctx).ainvoke({"ref": "treasure chest"})

    assert "no placed element" in out.lower()
    assert "seaweed" in out.lower()        # tells the agent what IS placed
    assert ctx.scene_hub.ops == []


@pytest.mark.asyncio
async def test_regenerate_element_ambiguous_returns_candidates_with_exact_handles():
    doc, asset = _seaweed_doc(), _seaweed_asset()
    doc["nodes"]["spr.seaweed_left"] = {"id": "spr.seaweed_left", "type": "Sprite",
                                        "props": {"role": "prop"}}
    doc["nodes"]["spr.seaweed_right"] = {"id": "spr.seaweed_right", "type": "Sprite",
                                         "props": {"role": "prop"}}
    ctx, _ = _ctx(doc, asset)

    out = await build_regenerate_element_tool(ctx).ainvoke({"ref": "seaweed"})

    low = out.lower()
    assert "seaweed_left" in low and "seaweed_right" in low
    assert ctx.scene_hub.ops == []         # nothing regenerated until disambiguated


@pytest.mark.asyncio
async def test_regenerate_element_empty_scene_is_friendly():
    ctx, _ = _ctx({"version": 1, "nodes": {}, "edges": []}, _seaweed_asset())
    out = await build_regenerate_element_tool(ctx).ainvoke({"ref": "seaweed"})
    assert "empty" in out.lower() or "nothing" in out.lower()
    assert ctx.scene_hub.ops == []


def test_factory_registers_regenerate_element():
    f = ToolFactory(asset_store=None, asset_hub=None)
    assert "regenerate_element" in f.known_tool_names()
    ctx = ToolContext("r1", "g1", None, None)
    assert f.build(["regenerate_element"], ctx)[0].name == "regenerate_element"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_regenerate_element_tool.py -v`
Expected: FAIL with `ImportError: cannot import name 'build_regenerate_element_tool'`.

- [ ] **Step 3: Add `_placed_summary` and the tool**

In `studio/backend/app/agent_tools.py`, add `_placed_summary` just below `_resolve_placed_elements`:

```python
def _placed_summary(document: dict, assets: list) -> str:
    """A short comma list of what is placed, for a no-match message."""
    els = _placed_elements(document, assets)
    if not els:
        return "(nothing placed)"
    return ", ".join(
        el.handle + (f" (role {el.role})" if el.role else "") for el in els
    )
```

Then add the tool builder just below `build_generate_and_place_tool` (before `build_delete_asset_tool`):

```python
def build_regenerate_element_tool(ctx: ToolContext) -> BaseTool:
    async def regenerate_element(ref: str, description: str = "") -> str:
        document = await ctx.scene_store.get_document(ctx.game_id)
        if not document or not document.get("nodes"):
            return "The scene is empty; there's nothing placed to regenerate."
        assets = await ctx.asset_store.list_assets(ctx.game_id)

        matches = _resolve_placed_elements(document, assets, ref)
        if not matches:
            return (f"No placed element matches '{ref}'. "
                    f"Placed: {_placed_summary(document, assets)}. "
                    f"Use one of those, or add it with generate_and_place.")
        if len(matches) > 1:
            opts = ", ".join(
                m.handle + (f" (role {m.role})" if m.role else "") for m in matches)
            return (f"'{ref}' matches several placed elements: {opts}. "
                    f"Call regenerate_element again with ref set to the exact one.")

        el = matches[0]
        if el.texture_id is None:
            return (f"'{el.handle}' is placed but has no bound texture to repaint; "
                    f"nothing regenerated.")
        asset = el.asset
        if asset is None:
            asset = (await ctx.asset_store.get_by_slot(ctx.game_id, el.handle)
                     or await ctx.asset_store.get_asset(el.handle))
        if asset is None:
            return (f"Matched '{el.handle}' in the scene, but its source asset isn't "
                    f"on the board; can't regenerate.")

        new_ref = await _regenerate_and_rebind(
            ctx, asset=asset, texture_id=el.texture_id,
            new_prompt=description or None)
        if new_ref is None:
            return (f"Regeneration for '{el.handle}' produced no image; "
                    f"the scene is unchanged.")
        return (f"Regenerated '{el.role or el.handle}' in place and re-rendered "
                f"the game.")

    return StructuredTool.from_function(
        coroutine=regenerate_element, name="regenerate_element",
        description=(
            "Regenerate an element that is ALREADY placed in the scene and swap its "
            "art IN PLACE — keeping its position, scale, and z-index. Use this for "
            "'regenerate/redo/replace/fix the <thing>' on something already on "
            "screen; do NOT use generate_and_place for that (it adds a duplicate). "
            "`ref` is matched fuzzily against each placed element's slot, role, and "
            "asset name. Pass a refined `description` to fix what was wrong (e.g. "
            "'not cropped at the top'); omit it to just re-roll the art. If several "
            "elements match, the tool returns the candidates — call again with the "
            "exact one."
        ),
    )
```

- [ ] **Step 4: Register the tool in the factory**

In `studio/backend/app/agent_tools.py`, in `ToolFactory._BUILDERS`, add this entry right after the `generate_and_place` line:

```python
        "regenerate_element": build_regenerate_element_tool,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_regenerate_element_tool.py -v`
Expected: PASS (6 passed).

- [ ] **Step 6: Commit**

```bash
cd "C:/code/bloom.wt/regenerate-element"
git add studio/backend/app/agent_tools.py studio/backend/tests/test_regenerate_element_tool.py
git commit -m "feat: add regenerate_element tool to replace a placed scene element"
```

---

### Task 4: Design-router branch + tool allowlist

**Files:**
- Modify: `studio/backend/app/gdd/router.py` (add `regenerate_element` to the tool set; add branch 5; renumber the chit-chat branch to 6)
- Test: `studio/backend/tests/test_design_router.py` (add cases)

**Interfaces:**
- Consumes: the `regenerate_element` tool name registered in Task 3.
- Produces: `build_design_router_spec()` whose `.tools` contains `"regenerate_element"` and whose `.body` documents the regenerate-in-place branch and warns against using `generate_and_place` for on-screen elements.

- [ ] **Step 1: Write the failing test**

Add to the end of `studio/backend/tests/test_design_router.py`:

```python
def test_router_binds_regenerate_element():
    spec = build_design_router_spec()
    assert "regenerate_element" in spec.tools
    assert "regenerate_element" in spec.body


def test_router_regenerate_branch_replaces_in_place_not_duplicate():
    low = build_design_router_spec().body.lower()
    # routes fix/redo/regenerate to the in-place tool
    assert "regenerate_element" in low
    assert "in place" in low
    # explicitly steers away from adding a duplicate via generate_and_place
    assert "already in the scene" in low or "already on screen" in low
    assert "duplicate" in low
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_design_router.py -v`
Expected: FAIL on the two new tests (`regenerate_element` not in tools/body).

- [ ] **Step 3: Add `regenerate_element` to the router's tool set**

In `studio/backend/app/gdd/router.py`, in `build_design_router_spec`, change the `tools=sorted(...)` set to include `regenerate_element`:

```python
        tools=sorted(
            GDD_TOOL_NAMES
            | {"realize_symbol", "generate_asset", "add_sprite", "list_assets",
               "generate_and_place", "regenerate_element"}
        ),
```

- [ ] **Step 4: Add branch 5 and renumber chit-chat to 6**

In `studio/backend/app/gdd/router.py`, in `_BODY_TEMPLATE`, insert a new branch between the compose branch (4) and the chit-chat branch. First add this block immediately AFTER the compose branch (right before the line that currently reads `5. Not a design or scene request`):

```
5. A request to FIX, REDO, REGENERATE, or REPLACE an element that is ALREADY in
   the scene (e.g. "regenerate the seaweed, it's cut off at the top", "redo the
   logo", "that background is wrong, make it again"): call `regenerate_element`
   with `ref` set to what the user named — it is matched fuzzily against the slot,
   role, and asset name of what is placed. When the user says what is wrong, pass a
   refined `description` that fixes it (e.g. "a full seaweed plant, fully in frame,
   not cropped at the top"); omit `description` to just re-roll the art. This swaps
   the existing sprite's art IN PLACE, keeping its position. Do NOT use
   `generate_and_place` for something already in the scene — that adds a duplicate
   sprite. If `regenerate_element` reports several matches, pick the right one from
   context (or ask the user) and call it again with the exact `ref`.
```

Then change the existing chit-chat line from:

```
5. Not a design or scene request (a greeting, a question, chit-chat): reply
```

to:

```
6. Not a design or scene request (a greeting, a question, chit-chat): reply
```

(The closing paragraph's "branches 1-3" and "branch 4" references stay correct — those branch numbers are unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest -m "not e2e" tests/test_design_router.py -v`
Expected: PASS (all, including the pre-existing branch tests).

- [ ] **Step 6: Commit**

```bash
cd "C:/code/bloom.wt/regenerate-element"
git add studio/backend/app/gdd/router.py studio/backend/tests/test_design_router.py
git commit -m "feat: route regenerate/fix of placed elements to regenerate_element"
```

---

### Task 5: Backend e2e — compose then regenerate, no duplicate

**Files:**
- Create: `studio/backend/tests/fixtures/replay/run/compose-seaweed.json`
- Create: `studio/backend/tests/fixtures/replay/run/regenerate-seaweed.json`
- Create: `studio/backend/tests/e2e/test_scene_regenerate.py`

**Interfaces:**
- Consumes: the full chain (design-router branch 5 → `regenerate_element` → `_regenerate_and_rebind`). Replay ComfyUI uses the single shared `comfy/default.png`, so each generation still gets a distinct `image_ref` (its own generation id), and NO new image fixtures are needed.
- Produces: a non-browser e2e proving that after "regenerate the seaweed" there is exactly ONE seaweed sprite (no duplicate), the asset gained a second generation, and the bound texture `src` points at the newest generation.

- [ ] **Step 1: Author the compose cassette**

Create `studio/backend/tests/fixtures/replay/run/compose-seaweed.json` (model it on `run/compose-pirate-scene.json`):

```json
{
  "prompt": "add a seaweed prop at the bottom of the scene",
  "tool_call_rounds": [
    [
      {
        "name": "generate_and_place",
        "args": {
          "description": "a clump of green seaweed, prop, no text",
          "slot": "seaweed",
          "size": "512x512",
          "transparent": true,
          "role": "seaweed",
          "y": 720,
          "anchor_y": 1
        }
      }
    ]
  ],
  "final": ["Added a seaweed prop at the bottom of the scene."]
}
```

- [ ] **Step 2: Author the regenerate cassette**

Create `studio/backend/tests/fixtures/replay/run/regenerate-seaweed.json`:

```json
{
  "prompt": "regenerate the seaweed, it's cut off at the top",
  "tool_call_rounds": [
    [
      {
        "name": "regenerate_element",
        "args": {
          "ref": "seaweed",
          "description": "a full clump of green seaweed fully within frame, not cropped at the top, prop, no text"
        }
      }
    ]
  ],
  "final": ["Regenerated the seaweed in place so it is no longer cut off at the top."]
}
```

- [ ] **Step 3: Write the failing e2e test**

Create `studio/backend/tests/e2e/test_scene_regenerate.py`:

```python
"""Backend non-browser e2e: regenerating a placed element replaces it IN PLACE.

Under PROVIDER_MODE=replay, "add a seaweed prop" composes one sprite, then
"regenerate the seaweed, it's cut off at the top" routes through the design-router
to the REAL regenerate_element tool. The element's art is re-rolled and its bound
Texture src is rewritten in place — so the scene ends with exactly ONE seaweed
sprite (the duplicate-sprite bug does not recur), and the asset has two generations.

Cassettes: run/compose-seaweed.json, run/regenerate-seaweed.json (prompt-keyed).
"""
import asyncio

import httpx
import pytest
import socketio

COMPOSE = "add a seaweed prop at the bottom of the scene"
REGEN = "regenerate the seaweed, it's cut off at the top"


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "RegenE2E"})).json()
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
async def test_regenerate_replaces_placed_element_in_place(live_server):
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

    # 1) compose a single seaweed prop
    await _run_prompt(client, room_id, COMPOSE, run_completions)

    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    seaweed = next(a for a in assets if a.get("slot") == "seaweed")
    assert len(seaweed.get("generations") or []) == 1, "expected one generation after compose"

    # 2) regenerate it
    await _run_prompt(client, room_id, REGEN, run_completions)

    # asset gained a SECOND generation (it regenerated, did not reuse)
    async with httpx.AsyncClient(base_url=live_server) as http:
        assets = (await http.get(f"/games/{game_id}/assets")).json()
    seaweed = next(a for a in assets if a.get("slot") == "seaweed")
    gens = seaweed.get("generations") or []
    assert len(gens) == 2, f"expected two generations after regenerate: {seaweed}"
    newest_ref = gens[-1]["image_ref"]

    # scene has EXACTLY ONE seaweed sprite (no duplicate), src rewired to newest gen
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received"
    doc = scene_snapshots[-1]["document"]
    nodes = doc["nodes"]

    sprites = [nid for nid, n in nodes.items() if n["type"] == "Sprite"]
    assert sprites == ["spr.seaweed"], f"expected one seaweed sprite, got {sprites}"
    textures = [nid for nid, n in nodes.items() if n["type"] == "Texture"]
    assert textures == ["tex.seaweed"], f"expected one seaweed texture, got {textures}"
    assert nodes["tex.seaweed"]["props"]["src"] == newest_ref, "texture not repainted to newest gen"

    await client.disconnect()
```

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `cd studio/backend && uv run pytest -m e2e tests/e2e/test_scene_regenerate.py -v`
Expected: PASS (1 passed). The `live_server` fixture starts a replay backend itself. If the run times out, confirm both cassette files are valid JSON and their `prompt` strings exactly match `COMPOSE` / `REGEN`.

- [ ] **Step 5: Run the full backend unit + e2e suites for regressions**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q` then `cd studio/backend && uv run pytest -m e2e -q`
Expected: all green. Pay attention to `test_realize_symbol.py`, `test_realize_parity.py`, `test_design_router.py`, and `test_generate_and_place_tool.py`.

- [ ] **Step 6: Commit**

```bash
cd "C:/code/bloom.wt/regenerate-element"
git add studio/backend/tests/e2e/test_scene_regenerate.py \
        studio/backend/tests/fixtures/replay/run/compose-seaweed.json \
        studio/backend/tests/fixtures/replay/run/regenerate-seaweed.json
git commit -m "test(e2e): regenerate replaces a placed element in place, no duplicate"
```

---

## Self-Review

**Spec coverage:**
- Verb split (`generate_and_place` add vs `regenerate_element` replace) → Task 3.
- Keep placement, swap `Texture.src` → Tasks 1 + 3 (assert no new nodes; only `setProp`).
- Fuzzy `ref` matched against slot/role/asset name; 0/1/many resolution → Task 2 + Task 3 tests.
- Disambiguation returns candidates to the agent (no forced human interrupt) → Task 3 `..._ambiguous_returns_candidates...`.
- `description` updates the prompt; omitted = re-roll → Task 3 two happy-path tests.
- Shared core + `realize_symbol` refactor with parity guard → Task 1.
- New router branch, distinct from compose, on the allowlist → Task 4.
- Edge cases (not found, no bound texture, asset off board, no image, empty scene) → Task 3 tests + tool branches.
- E2e (replay, authoritative): one sprite after regenerate, src changed, no duplicate → Task 5.
- Out of scope (reposition during regen, `list_scene` tool, multi-element) → not implemented, by design.

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output.

**Type consistency:** `_regenerate_and_rebind(ctx, *, asset, texture_id, new_prompt)` is defined in Task 1 and called identically in Task 3. `PlacedElement` fields (`sprite_id`, `texture_id`, `handle`, `role`, `asset`, `src`) defined in Task 2 and used consistently in Task 3. Tool key `"regenerate_element"` matches the builder name across Tasks 3-4 and both cassettes.

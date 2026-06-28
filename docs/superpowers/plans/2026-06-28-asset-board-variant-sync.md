# Asset Board → live game variant sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Asset Board's "Generate again" and variant selection update the live client game, with the selected generation as the single source of truth.

**Architecture:** A placed asset becomes a `Sprite` bound to a `Texture` whose `src` is a baked image URL. We give each `Texture` a `props.assetId` back-reference, add one canonical `rebind_asset_textures` helper that rewrites every bound Texture's `src` to the asset's selected generation and broadcasts a `scene_op`, and call it from the three paths that change selection: REST variant-select, board socket regenerate (which auto-selects the newest), and the agent regenerate tool (converged). The frontend surfaces the variant-toggle strip in every view mode.

**Tech Stack:** Python (FastAPI, python-socketio, Motor/Mongo, pytest-asyncio) backend; React + hookstate + Vitest + Playwright frontend; Pixi runtime engine.

## Global Constraints

- **TDD is mandatory** — write the failing test, watch it fail, minimal code to pass, refactor.
- **TypeScript interfaces use an `I` prefix** (`IAssetViewConfig`, etc.).
- **No raw colors** outside `studio/frontend/src/styles.css` (guard test enforces).
- **Conventional Commits** for every commit (`feat`, `fix`, `test`, `refactor`, …).
- **Backend formatting/lint** must pass; **frontend gates** = `prettier --check .` (pinned `node_modules/.bin/prettier`, not npx), `nx typecheck`, `nx test`, `nx build` — run all four before pushing.
- **Browser e2e (Playwright) never runs in CI** — run locally against a replay backend (`just backend-serve-replay` + `just e2e`). Backend Python tests are CI-affordable and should run in CI.
- **Tests assert observable end-state, never just dispatch** — for scene changes, assert the persisted/synced document and client reconciliation, not only that an op was emitted.
- Run all backend commands with `uv --directory studio/backend run pytest …`.

---

## File map

- `studio/backend/app/scene/compose.py` — `build_sprite_ops` gains `asset_id`; Texture props get `assetId`.
- `studio/backend/app/scene/rebind.py` — **new**: `selected_image_ref`, `bound_texture_ids`, `rebind_asset_textures`.
- `studio/backend/app/agent_tools.py` — thread `asset_id` into placement; converge `_regenerate_and_rebind` onto the rebinder; alias `_selected_media_ref` to the shared helper.
- `studio/backend/app/assets/rest.py` — variant-select endpoint calls the rebinder.
- `studio/backend/app/assets/hub.py` — `AssetHub` gains scene deps + `auto_select`; board regenerate selects newest and rebinds.
- `studio/backend/app/assets/sockets.py` — `generate_asset` handler passes `auto_select=True`.
- `studio/backend/app/main.py` — construct scene store/hub before `AssetHub`; inject them; expose `scene_store`/`scene_hub` on `app.state`.
- `studio/frontend/src/plugins/assets/viewConfig.ts` — `showCandidates` in all modes + `candidateSize`.
- `studio/frontend/src/plugins/assets/AssetCard.tsx` — render the candidate strip in every mode (compact in small/list).
- `studio/frontend/src/plugins/game/socketClient.ts` — dev-only expose of the live scene document for e2e.
- `studio/frontend/e2e/asset-variant-sync.spec.ts` — **new** Playwright spec.

Tests: `studio/backend/tests/test_compose_scene_tool.py` (extend), `studio/backend/tests/test_rebind.py` (new), `studio/backend/tests/test_regenerate_core.py` (update for convergence), `studio/backend/tests/test_asset_hub.py` (extend), `studio/backend/tests/e2e/test_assets.py` (extend), `studio/frontend/src/plugins/assets/AssetCard.spec.tsx` (extend), `studio/frontend/src/plugins/assets/viewConfig.spec.ts` (new or extend).

---

### Task 1: Texture carries its asset id (`build_sprite_ops`)

**Files:**

- Modify: `studio/backend/app/scene/compose.py:24-75`
- Modify: `studio/backend/app/agent_tools.py` (`_place_in_scene`, `add_sprite`, `generate_and_place`)
- Test: `studio/backend/tests/test_compose_scene_tool.py`

**Interfaces:**

- Produces: `build_sprite_ops(..., asset_id: str = "")` — when truthy, the Texture op's props include `"assetId": asset_id`. `_place_in_scene(ctx, *, handle, src, role, parent, x, y, anchor_x, anchor_y, fit, z_index, tex_size, asset_id="")`.

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_compose_scene_tool.py`:

```python
from app.scene.compose import build_sprite_ops


def _texture_op(ops):
    return next(o for o in ops if o["kind"] == "addNode" and o["type"] == "Texture")


def test_build_sprite_ops_writes_asset_id_on_texture():
    ops = build_sprite_ops(handle="wild", src="/media/g1/a1/x.png", asset_id="a1")
    tex = _texture_op(ops)
    assert tex["props"]["src"] == "/media/g1/a1/x.png"
    assert tex["props"]["assetId"] == "a1"


def test_build_sprite_ops_omits_asset_id_when_absent():
    ops = build_sprite_ops(handle="wild", src="/media/g1/a1/x.png")
    tex = _texture_op(ops)
    assert "assetId" not in tex["props"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_compose_scene_tool.py -k asset_id -v`
Expected: FAIL — `assertion error` / `assetId` not in props (current code writes only `{"src": src}`).

- [ ] **Step 3: Add the parameter and prop**

In `studio/backend/app/scene/compose.py`, add `asset_id: str = "",` to the `build_sprite_ops` keyword-only signature (e.g. just after `src: str,`), and replace the Texture op line:

```python
    tex_props: dict = {"src": src}
    if asset_id:
        tex_props["assetId"] = asset_id
    ops.append({"kind": "addNode", "id": texture_id, "type": "Texture", "props": tex_props})
```

- [ ] **Step 4: Thread `asset_id` through the placement callers**

In `studio/backend/app/agent_tools.py`:

`_place_in_scene` — add `asset_id: str = "",` to its keyword-only signature and pass it into `build_sprite_ops`:

```python
    ops = build_sprite_ops(
        handle=handle, src=src, role=role, parent_id=parent_id,
        ensure_root=False, canvas=canvas, tex_size=tex_size,
        x=x, y=y, anchor_x=anchor_x, anchor_y=anchor_y, fit=fit, z_index=z_index,
        asset_id=asset_id,
    )
```

In `add_sprite`'s call to `_place_in_scene`, add `asset_id=asset.id,`.
In `generate_and_place`'s call to `_place_in_scene`, add `asset_id=asset.id,`.

- [ ] **Step 5: Run the compose tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_compose_scene_tool.py -v`
Expected: PASS (new assetId tests green; existing compose tests unaffected).

- [ ] **Step 6: Run the placement-tool tests to confirm no regression**

Run: `uv --directory studio/backend run pytest tests/test_generate_and_place_tool.py tests/test_agent_tools.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/scene/compose.py studio/backend/app/agent_tools.py studio/backend/tests/test_compose_scene_tool.py
git commit -m "feat(scene): tag placed Textures with their assetId"
```

---

### Task 2: Canonical rebinder (`scene/rebind.py`)

**Files:**

- Create: `studio/backend/app/scene/rebind.py`
- Test: `studio/backend/tests/test_rebind.py`

**Interfaces:**

- Produces:
  - `selected_image_ref(asset) -> str | None`
  - `bound_texture_ids(document: dict | None, *, asset_id: str, slot: str | None = None) -> list[str]`
  - `async rebind_asset_textures(scene_store, scene_hub, game_id: str, asset) -> list[str]` — rewrites each bound Texture's `src` via `scene_hub.apply_op(game_id, {"kind":"setProp","id":<tex>,"path":"src","value":<src>})`; returns the rewritten ids; no-op (empty list) when no selected image or no bound Texture.
- Consumes: `scene_store.get_document(game_id) -> dict | None`, `scene_hub.apply_op(game_id, op)`.

- [ ] **Step 1: Write the failing tests**

Create `studio/backend/tests/test_rebind.py`:

```python
import pytest
from datetime import datetime, timezone

from app.assets.models import Asset, Generation
from app.scene.rebind import selected_image_ref, bound_texture_ids, rebind_asset_textures


def _asset(selected="gen2"):
    return Asset(
        id="a1", game_id="g1", name="Wild", prompt="p", width=64, height=64,
        workflow="schnell-transparent", slot="wild",
        generations=[
            Generation(id="gen1", seed=1, image_ref="/media/g1/a1/old.png", created_at=datetime.now(timezone.utc)),
            Generation(id="gen2", seed=2, image_ref="/media/g1/a1/new.png", created_at=datetime.now(timezone.utc)),
        ],
        selected_generation_id=selected,
    )


def _doc_with_texture(tex_id, props):
    return {"version": 1, "nodes": {tex_id: {"id": tex_id, "type": "Texture", "props": props}}, "edges": []}


class _SceneStore:
    def __init__(self, doc):
        self._doc = doc
    async def get_document(self, game_id):
        return self._doc


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append((game_id, op))
        return None


def test_selected_image_ref_returns_selected():
    assert selected_image_ref(_asset("gen2")) == "/media/g1/a1/new.png"
    assert selected_image_ref(_asset(None)) is None


def test_bound_texture_ids_prefers_explicit_asset_id():
    doc = _doc_with_texture("tex.wild", {"src": "x", "assetId": "a1"})
    assert bound_texture_ids(doc, asset_id="a1", slot="wild") == ["tex.wild"]


def test_bound_texture_ids_falls_back_to_id_convention():
    doc = _doc_with_texture("tex.wild", {"src": "x"})  # legacy: no assetId
    assert bound_texture_ids(doc, asset_id="a1", slot="wild") == ["tex.wild"]


def test_bound_texture_ids_empty_when_unbound():
    doc = _doc_with_texture("tex.other", {"src": "x", "assetId": "zzz"})
    assert bound_texture_ids(doc, asset_id="a1", slot="wild") == []


@pytest.mark.asyncio
async def test_rebind_rewrites_bound_texture_src():
    doc = _doc_with_texture("tex.wild", {"src": "/media/g1/a1/old.png", "assetId": "a1"})
    store, hub = _SceneStore(doc), _SceneHub()
    ids = await rebind_asset_textures(store, hub, "g1", _asset("gen2"))
    assert ids == ["tex.wild"]
    assert hub.ops == [("g1", {"kind": "setProp", "id": "tex.wild", "path": "src", "value": "/media/g1/a1/new.png"})]


@pytest.mark.asyncio
async def test_rebind_noop_when_no_selection_or_no_texture():
    hub = _SceneHub()
    # no selection
    assert await rebind_asset_textures(_SceneStore(_doc_with_texture("tex.wild", {"assetId": "a1"})), hub, "g1", _asset(None)) == []
    # not placed
    assert await rebind_asset_textures(_SceneStore({"version": 1, "nodes": {}, "edges": []}), hub, "g1", _asset("gen2")) == []
    assert hub.ops == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_rebind.py -v`
Expected: FAIL — `ModuleNotFoundError: app.scene.rebind`.

- [ ] **Step 3: Write the module**

Create `studio/backend/app/scene/rebind.py`:

```python
"""Rebind scene Textures to an asset's selected generation.

Single source of truth for propagating an asset's currently-selected
generation into every scene Sprite bound to that asset. The board paths
(REST variant-select, socket regenerate) and the agent regenerate path all
funnel through ``rebind_asset_textures`` so exactly one mechanism rewrites a
bound Texture's ``src``.
"""


def selected_image_ref(asset) -> str | None:
    """image_ref of the asset's selected generation, or None."""
    sel = getattr(asset, "selected_generation_id", None)
    if not sel:
        return None
    for g in getattr(asset, "generations", []) or []:
        if getattr(g, "id", None) == sel:
            return getattr(g, "image_ref", None)
    return None


def bound_texture_ids(document: dict | None, *, asset_id: str, slot: str | None = None) -> list[str]:
    """Texture node ids bound to ``asset_id``.

    Primary: Textures carrying ``props.assetId == asset_id`` (written at
    placement). Fallback for scenes placed before assetId existed: the
    id-convention ``tex.{slot}`` / ``tex.{asset_id}``.
    """
    nodes = (document or {}).get("nodes", {}) or {}
    explicit = [
        nid for nid, n in nodes.items()
        if n.get("type") == "Texture" and (n.get("props") or {}).get("assetId") == asset_id
    ]
    if explicit:
        return explicit
    legacy: list[str] = []
    for handle in (slot, asset_id):
        if handle:
            tid = f"tex.{handle}"
            n = nodes.get(tid)
            if n is not None and n.get("type") == "Texture":
                legacy.append(tid)
    return legacy


async def rebind_asset_textures(scene_store, scene_hub, game_id: str, asset) -> list[str]:
    """Rewrite every bound Texture's src to the asset's selected generation.

    Returns the rewritten texture ids (empty when the asset has no selected
    image or no bound Texture — both no-ops, scene untouched).
    """
    src = selected_image_ref(asset)
    if not src:
        return []
    document = await scene_store.get_document(game_id)
    ids = bound_texture_ids(
        document, asset_id=getattr(asset, "id", ""), slot=getattr(asset, "slot", None)
    )
    for tid in ids:
        await scene_hub.apply_op(
            game_id, {"kind": "setProp", "id": tid, "path": "src", "value": src}
        )
    return ids
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_rebind.py -v`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/rebind.py studio/backend/tests/test_rebind.py
git commit -m "feat(scene): canonical rebinder for asset->texture src sync"
```

---

### Task 2.5: DRY `_selected_media_ref` onto the shared helper

**Files:**

- Modify: `studio/backend/app/agent_tools.py:70-77`

**Interfaces:**

- Consumes: `selected_image_ref` from Task 2. Keeps the existing `_selected_media_ref` name as an alias so its 4 call sites are untouched.

- [ ] **Step 1: Replace the duplicate definition with an import + alias**

In `studio/backend/app/agent_tools.py`, add to the scene imports near the top:

```python
from app.scene.rebind import rebind_asset_textures, selected_image_ref
```

Then delete the local `def _selected_media_ref(asset) -> str | None:` body (lines ~70-77) and replace with:

```python
# Backed by the shared rebinder helper so the board, REST, and agent paths
# resolve "selected generation -> image_ref" identically.
_selected_media_ref = selected_image_ref
```

- [ ] **Step 2: Run the tools tests to confirm no behavior change**

Run: `uv --directory studio/backend run pytest tests/test_agent_tools.py tests/test_generate_and_place_tool.py -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add studio/backend/app/agent_tools.py
git commit -m "refactor(agent): reuse shared selected_image_ref helper"
```

---

### Task 3: Converge the agent regenerate path onto the rebinder

**Files:**

- Modify: `studio/backend/app/agent_tools.py:958-983` (`_regenerate_and_rebind`)
- Modify: `studio/backend/tests/test_regenerate_core.py`

**Interfaces:**

- Consumes: `rebind_asset_textures` (Task 2). `_regenerate_and_rebind(ctx, *, asset, texture_id, new_prompt)` unchanged signature; `texture_id is None` still skips the scene write. When `texture_id` is set, the scene write goes through `rebind_asset_textures` (which finds the bound Texture by assetId, falling back to the id-convention) instead of issuing a raw `setProp`.

- [ ] **Step 1: Update the existing tests to the converged contract**

The converged helper re-reads the asset after selecting and rebinds via the scene document, so the test fakes must (a) reflect the new selection on re-read and (b) provide a scene document with the bound Texture. Replace the fakes + first/third test in `studio/backend/tests/test_regenerate_core.py`:

```python
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
        self._asset.selected_generation_id = gen_id  # re-read reflects selection
        return self._asset


class _SceneStore:
    def __init__(self, document):
        self._document = document
    async def get_document(self, game_id):
        return self._document


class _SceneHub:
    def __init__(self):
        self.ops = []
    async def apply_op(self, game_id, op):
        self.ops.append(op)
        return None


def _doc(tex_id="tex.seaweed", asset_id="a1"):
    return {"version": 1, "nodes": {tex_id: {"id": tex_id, "type": "Texture",
            "props": {"src": "/media/g1/a1/old.png", "assetId": asset_id}}}, "edges": []}
```

Update the first test to pass a `scene_store` and assert the rebinder rewrote the bound texture:

```python
@pytest.mark.asyncio
async def test_core_regenerates_selects_newest_and_rewrites_texture():
    asset = _asset_with_two_gens()
    store, hub, shub = _AssetStore(asset), _AssetHub(), _SceneHub()
    ctx = ToolContext("r1", "g1", store, hub, scene_store=_SceneStore(_doc()), scene_hub=shub)

    ref = await _regenerate_and_rebind(
        ctx, asset=asset, texture_id="tex.seaweed", new_prompt="fresh seaweed")

    assert ref == "/media/g1/a1/new.png"
    assert store.updated == {"prompt": "fresh seaweed"}
    assert hub.calls == ["a1"]
    assert store.selected == "gen2"
    assert shub.ops == [{"kind": "setProp", "id": "tex.seaweed", "path": "src",
                         "value": "/media/g1/a1/new.png"}]
```

Update `test_core_skips_setprop_when_texture_is_none` to pass `scene_store=_SceneStore(_doc())` in the `ToolContext` and keep asserting `shub.ops == []` (texture_id=None ⇒ no scene write). Update `test_core_returns_none_when_no_image` to pass `scene_store=_SceneStore(_doc())` and keep `assert shub.ops == []`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv --directory studio/backend run pytest tests/test_regenerate_core.py -v`
Expected: FAIL — current `_regenerate_and_rebind` issues a raw `setProp` using `newest.image_ref` directly and ignores `scene_store`; the re-read/rebind path isn't there yet (and the `_SceneStore` arg is unused by current code).

- [ ] **Step 3: Converge the implementation**

Replace the body of `_regenerate_and_rebind` in `studio/backend/app/agent_tools.py`:

```python
async def _regenerate_and_rebind(
    ctx: ToolContext, *, asset, texture_id: str | None, new_prompt: str | None,
) -> str | None:
    """Regenerate an asset's art, select the newest generation, and rebind any
    bound scene Texture to it via the canonical rebinder.

    ``texture_id`` is a presence signal: ``None`` regenerates the board art but
    skips the scene write (preserving the "regenerated but not placed" message).
    Returns the new ``image_ref``, or ``None`` if regeneration produced no image.
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
        refreshed = await ctx.asset_store.get_asset(asset.id)
        await rebind_asset_textures(ctx.scene_store, ctx.scene_hub, ctx.game_id, refreshed)
    return newest.image_ref
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv --directory studio/backend run pytest tests/test_regenerate_core.py -v`
Expected: PASS.

- [ ] **Step 5: Run the regenerate/symbol tool suites to confirm no regression**

Run: `uv --directory studio/backend run pytest tests/test_regenerate_element_tool.py tests/test_realize_symbol.py -v`
Expected: PASS. If a test there constructs a scene without an `assetId` on the texture, the rebinder's id-convention fallback (`tex.{slot}`) still finds it; if any test asserted the exact `setProp` op shape, it remains identical.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_regenerate_core.py
git commit -m "refactor(agent): converge regenerate-rebind onto canonical rebinder"
```

---

### Task 4: Variant select propagates to the scene (REST)

**Files:**

- Modify: `studio/backend/app/assets/rest.py:99-104`
- Modify: `studio/backend/app/main.py` (expose `scene_store`/`scene_hub` on `app.state`)
- Test: `studio/backend/tests/e2e/test_assets.py`

**Interfaces:**

- Consumes: `rebind_asset_textures` (Task 2); `request.app.state.scene_store`, `request.app.state.scene_hub`; `Asset.game_id`.
- Produces: `POST /assets/{id}/select` emits a `scene_op setProp src` to room=game for every bound Texture, after persisting the selection.

- [ ] **Step 1: Expose scene deps on app.state**

In `studio/backend/app/main.py`, after the existing `fastapi_app.state.*` assignments (near line 141), add:

```python
    fastapi_app.state.scene_store = scene_store
    fastapi_app.state.scene_hub = scene_hub
```

- [ ] **Step 2: Write the failing e2e test**

Add to `studio/backend/tests/e2e/test_assets.py` (follow the existing app/client fixtures in that file; adapt names to the module's helpers). The test places a Sprite+Texture(assetId) for a generated asset, selects an earlier generation, and asserts the bound Texture's `src` flipped in the persisted scene document:

```python
@pytest.mark.asyncio
async def test_select_generation_rebinds_scene_texture(app_context, asset_with_two_generations):
    game_id = asset_with_two_generations.game_id
    asset = asset_with_two_generations
    gen1, gen2 = asset.generations[0], asset.generations[1]

    scene_store = app_context.fastapi_app.state.scene_store
    scene_hub = app_context.fastapi_app.state.scene_hub
    # place: sprite + texture(assetId) bound under root
    await scene_hub.ensure_root(game_id, (640, 480))
    await scene_hub.apply_batch(game_id, [
        {"kind": "addNode", "id": "spr.a1", "type": "Sprite", "props": {}},
        {"kind": "addNode", "id": "tex.a1", "type": "Texture",
         "props": {"src": gen2.image_ref, "assetId": asset.id}},
        {"kind": "connect", "edgeId": "e.data.a1", "type": "data",
         "from": {"node": "tex.a1", "port": "data"}, "to": {"node": "spr.a1", "port": "texture"}},
        {"kind": "connect", "edgeId": "e.child.a1", "type": "child",
         "from": {"node": "root", "port": "children"}, "to": {"node": "spr.a1", "port": "parent"}},
    ])

    resp = await client.post(f"/assets/{asset.id}/select", json={"generationId": gen1.id})
    assert resp.status_code == 200

    doc = await scene_store.get_document(game_id)
    assert doc["nodes"]["tex.a1"]["props"]["src"] == gen1.image_ref
```

(If `test_assets.py` lacks an `asset_with_two_generations` fixture, build the asset inline via `app_context.asset_store.create_asset(...)` + two `add_generation(...)` calls, mirroring `test_asset_hub.py`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/e2e/test_assets.py -k rebinds_scene_texture -v`
Expected: FAIL — `tex.a1` src still equals `gen2.image_ref` (select endpoint doesn't rebind yet).

- [ ] **Step 4: Call the rebinder from the select endpoint**

In `studio/backend/app/assets/rest.py`, replace the `select_generation` route body:

```python
@router.post("/assets/{asset_id}/select")
async def select_generation(asset_id: str, body: SelectBody, request: Request) -> dict:
    asset = await request.app.state.asset_store.select_generation(asset_id, body.generation_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")
    await rebind_asset_textures(
        request.app.state.scene_store, request.app.state.scene_hub, asset.game_id, asset
    )
    return asset_wire(asset)
```

Add the import at the top of `rest.py`:

```python
from app.scene.rebind import rebind_asset_textures
```

- [ ] **Step 5: Run test to verify it passes**

Run: `uv --directory studio/backend run pytest tests/e2e/test_assets.py -k rebinds_scene_texture -v`
Expected: PASS.

- [ ] **Step 6: Run the full asset e2e + rest suite**

Run: `uv --directory studio/backend run pytest tests/e2e/test_assets.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/assets/rest.py studio/backend/app/main.py studio/backend/tests/e2e/test_assets.py
git commit -m "feat(assets): variant select rewrites bound scene texture"
```

---

### Task 5: Board regenerate auto-selects newest and rebinds (`AssetHub`)

**Files:**

- Modify: `studio/backend/app/assets/hub.py`
- Modify: `studio/backend/app/assets/sockets.py:10-12`
- Modify: `studio/backend/app/main.py` (construct scene store/hub before `AssetHub`; inject)
- Test: `studio/backend/tests/test_asset_hub.py`

**Interfaces:**

- Produces: `AssetHub(sio, asset_store, comfy, media, scene_store=None, scene_hub=None)`; `AssetHub.request_generation(game_id, asset_id, auto_select=False)`. When `auto_select` is true, after a generation lands the hub selects the newest generation and calls `rebind_asset_textures`. The board socket handler passes `auto_select=True`; the agent's `generate_and_wait` leaves it `False` (no behavior change).
- Consumes: `rebind_asset_textures` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_asset_hub.py` (reuse its existing fakes for `sio`, `asset_store`, `comfy`, `media`; add scene fakes). The test drives a board regenerate on an asset that already has one generation and a bound Texture, and asserts the newest is selected and a scene `setProp src` was emitted to the room:

```python
@pytest.mark.asyncio
async def test_request_generation_auto_select_rebinds_scene(asset_store, comfy, media, fake_sio):
    # asset already placed: a Texture(assetId) bound in the scene
    game_id = "g1"
    asset = await asset_store.create_asset(game_id, "Wild", "p", 64, 64, "schnell-transparent", slot="wild")
    await asset_store.add_generation(asset.id, "gen1", 1, "/media/g1/%s/gen1.png" % asset.id)

    scene_doc = {"version": 1, "nodes": {
        "tex.wild": {"id": "tex.wild", "type": "Texture",
                     "props": {"src": "/media/g1/%s/gen1.png" % asset.id, "assetId": asset.id}}},
        "edges": []}

    class _SceneStore:
        async def get_document(self, gid):
            return scene_doc

    class _SceneHub:
        def __init__(self):
            self.ops = []
        async def apply_op(self, gid, op):
            self.ops.append((gid, op))

    shub = _SceneHub()
    hub = AssetHub(fake_sio, asset_store, comfy, media, scene_store=_SceneStore(), scene_hub=shub)

    await hub.request_generation(game_id, asset.id, auto_select=True)
    await hub.wait_idle(game_id)  # see Step 3 note: drain completion helper

    refreshed = await asset_store.get_asset(asset.id)
    newest = refreshed.generations[-1]
    assert refreshed.selected_generation_id == newest.id
    assert shub.ops and shub.ops[-1][1] == {
        "kind": "setProp", "id": "tex.wild", "path": "src", "value": newest.image_ref}
```

> Note: if `test_asset_hub.py` already has a pattern for awaiting `_drain` completion (the existing tests must), use it instead of a `wait_idle` helper — mirror the existing approach (e.g. awaiting `hub.generate_and_wait`, or polling the asset until `status == "done"`). Do **not** invent a new public method if one exists; reuse the suite's drain-await pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `uv --directory studio/backend run pytest tests/test_asset_hub.py -k auto_select_rebinds -v`
Expected: FAIL — `AssetHub.__init__` rejects `scene_store`/`scene_hub`, and `request_generation` has no `auto_select`.

- [ ] **Step 3: Implement in `AssetHub`**

In `studio/backend/app/assets/hub.py`:

Constructor — accept and store the scene deps:

```python
    def __init__(self, sio, asset_store, comfy, media, scene_store=None, scene_hub=None):
        self._sio = sio
        self._store = asset_store
        self._comfy = comfy
        self._media = media
        self._scene_store = scene_store
        self._scene_hub = scene_hub
        self._queues: dict[str, list[str]] = {}
        self._busy: set[str] = set()
        self._locks: dict[str, asyncio.Lock] = {}
        self._active: dict[str, dict] = {}
        self._waiters: dict[str, dict] = {}
        self._auto_select: set[str] = set()  # asset_ids whose newest gen should auto-select + rebind
```

Add the import at the top:

```python
from app.scene.rebind import rebind_asset_textures
```

`request_generation` — accept `auto_select` and record the intent:

```python
    async def request_generation(self, game_id: str, asset_id: str, auto_select: bool = False) -> None:
        await self._store.set_status(asset_id, "queued")
        async with self._lock(game_id):
            self._queues.setdefault(game_id, []).append(asset_id)
            if auto_select:
                self._auto_select.add(asset_id)
            await self._emit_status(game_id, asset_id, "queued")
            if game_id in self._busy:
                return
            self._busy.add(game_id)
        asyncio.create_task(self._drain(game_id))
```

At the end of `_run` (after the `asset_completed` emit), select newest + rebind when requested:

```python
        await self._sio.emit("asset_completed", {"gameId": game_id, "asset": asset_wire(asset)}, room=game_id)

        if asset_id in self._auto_select:
            self._auto_select.discard(asset_id)
            await self._store.select_generation(asset_id, gen_id)
            if self._scene_store is not None and self._scene_hub is not None:
                refreshed = await self._store.get_asset(asset_id)
                await rebind_asset_textures(self._scene_store, self._scene_hub, game_id, refreshed)
            await self._sio.emit(
                "asset_completed",
                {"gameId": game_id, "asset": asset_wire(await self._store.get_asset(asset_id))},
                room=game_id,
            )
```

> The second `asset_completed` carries `selectedGenerationId = newest` so the board reflects the new selection through the existing `upsert` reducer. (The first emit already happened with the prior selection; re-emitting after select keeps the board honest.)

- [ ] **Step 4: Pass `auto_select=True` from the board socket handler**

In `studio/backend/app/assets/sockets.py`:

```python
    @sio.on("generate_asset")
    async def generate_asset(sid, data):
        await hub.request_generation(data["gameId"], data["assetId"], auto_select=True)
```

- [ ] **Step 5: Wire scene deps into `AssetHub` in main.py**

In `studio/backend/app/main.py`, move the scene store/hub construction **above** the `AssetHub` construction and pass them in. Replace lines ~89-100 so the order is:

```python
    asset_store = AssetStore(mongo[settings.mongo_db])
    media_root = Path(settings.media_dir)
    media_root.mkdir(parents=True, exist_ok=True)
    media = MediaStore(media_root)
    comfy = build_comfy_provider(settings)

    scene_store = GameSceneStore(mongo[settings.mongo_db])
    scene_hub = GameSceneHub(sio, scene_store)

    asset_hub = AssetHub(sio, asset_store, comfy, media, scene_store=scene_store, scene_hub=scene_hub)

    gdd_store = GddStore(mongo[settings.mongo_db])
    gdd_hub = GddHub(sio, gdd_store)
```

(Delete the now-duplicate `scene_store`/`scene_hub` lines from their old position at ~99-100.)

- [ ] **Step 6: Run the asset hub tests**

Run: `uv --directory studio/backend run pytest tests/test_asset_hub.py -v`
Expected: PASS (new auto-select test green; existing generation tests unaffected — default `auto_select=False`).

- [ ] **Step 7: Run the broader backend suite for regressions**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add studio/backend/app/assets/hub.py studio/backend/app/assets/sockets.py studio/backend/app/main.py studio/backend/tests/test_asset_hub.py
git commit -m "feat(assets): board regenerate auto-selects newest and rebinds scene"
```

---

### Task 6: Variant toggle reachable in every view mode (frontend)

**Files:**

- Modify: `studio/frontend/src/plugins/assets/viewConfig.ts`
- Modify: `studio/frontend/src/plugins/assets/AssetCard.tsx`
- Test: `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`

**Interfaces:**

- Produces: `IAssetViewConfig` gains `candidateSize: number`; `showCandidates: true` for all four modes. `AssetCard` renders the `asset-candidates` strip (calling `selectGeneration(id, g.id)`) in every mode, including the list row, sized by `cfg.candidateSize`.

- [ ] **Step 1: Write the failing tests**

Add to `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`:

```javascript
describe('variant toggle is reachable in every view mode', () => {
  const MODES = ['small', 'medium', 'large', 'list'] as const;
  const twoGen = () =>
    mk({
      status: 'done',
      generations: [
        { id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' },
        { id: 'gen2', seed: 2, imageRef: '/media/g1/a1/gen2.png', createdAt: '' },
      ],
      selectedGenerationId: 'gen1',
      progress: null,
    });

  it.each(MODES)('renders the candidate strip and selects a variant in %s mode', (mode) => {
    assetsSlice().assets.set([twoGen()]);
    render(<AssetCard index={0} mode={mode} />);
    const strip = screen.getByTestId('asset-candidates');
    const thumb = strip.querySelectorAll('img')[1];
    fireEvent.click(thumb);
    expect(selectGeneration).toHaveBeenCalledWith('a1', 'gen2');
  });
});
```

Also update the existing `'medium mode hides workflow + candidates …'` test: medium now **shows** candidates. Change its `expect(screen.queryByTestId('asset-candidates')).toBeNull();` line to `expect(screen.getByTestId('asset-candidates')).toBeTruthy();` and keep the workflow/hover-actions assertions as-is.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/frontend && npx nx test frontend -- --run AssetCard`
Expected: FAIL — list/small/medium render no `asset-candidates`; the converted medium assertion fails.

- [ ] **Step 3: Update viewConfig**

In `studio/frontend/src/plugins/assets/viewConfig.ts`, add `candidateSize: number;` to `IAssetViewConfig` (documented: "px size of each candidate thumbnail"), and set candidates on for all modes:

```javascript
export const VIEW_CONFIG: Record<AssetViewMode, IAssetViewConfig> = {
  small: { container: 'flex flex-wrap gap-2', card: 'w-24', image: 'h-20', showWorkflow: false, showCandidates: true, candidateSize: 28, actions: 'hover', row: false },
  medium: { container: 'flex flex-wrap gap-2.5', card: 'w-36', image: 'h-28', showWorkflow: false, showCandidates: true, candidateSize: 36, actions: 'hover', row: false },
  large: { container: 'flex flex-wrap gap-2.5', card: 'w-56', image: 'h-32', showWorkflow: true, showCandidates: true, candidateSize: 48, actions: 'always', row: false },
  list: { container: 'flex flex-col gap-1', card: 'w-full', image: 'h-10 w-10', showWorkflow: true, showCandidates: true, candidateSize: 24, actions: 'always', row: true },
};
```

- [ ] **Step 4: Render the strip in AssetCard (shared + list)**

In `studio/frontend/src/plugins/assets/AssetCard.tsx`, define a small inline strip element (just above the `if (cfg.row)` block) so both layouts reuse it:

```javascript
const candidateStrip = cfg.showCandidates && generations.length > 0 && (
  <div className="flex flex-wrap gap-1" data-testid="asset-candidates">
    {generations.map((g) => (
      <img
        key={g.id}
        src={`${BACKEND_URL}${g.imageRef}`}
        alt={`seed ${g.seed}`}
        width={cfg.candidateSize}
        height={cfg.candidateSize}
        onClick={() => void selectGeneration(id, g.id)}
        className="cursor-pointer rounded"
        style={{ outline: g.id === selectedId ? '2px solid currentColor' : 'none' }}
      />
    ))}
  </div>
);
```

In the **list** (`cfg.row`) branch, insert `{candidateStrip}` into the row (e.g. just before `{generateButton}`):

```javascript
<div className="flex justify-end">{statusBlock}</div>;
{
  candidateStrip;
}
{
  generateButton;
}
{
  deleteButton;
}
```

In the **grid** branch, replace the existing inline candidates block (the `cfg.showCandidates && generations.length > 0 && (...)` JSX inside `CardContent`) with `{candidateStrip}` to avoid duplication, sizing now driven by `cfg.candidateSize` instead of the hard-coded `width={48}`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd studio/frontend && npx nx test frontend -- --run AssetCard`
Expected: PASS.

- [ ] **Step 6: Run the frontend gates**

Run:

```bash
cd studio/frontend
node_modules/.bin/prettier --check src/plugins/assets/AssetCard.tsx src/plugins/assets/viewConfig.ts src/plugins/assets/AssetCard.spec.tsx
npx nx typecheck frontend
npx nx test frontend -- --run
npx nx build frontend
```

Expected: all PASS. (If prettier rewrites are needed, run `--write` on those files and re-stage.)

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/assets/viewConfig.ts studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/assets/AssetCard.spec.tsx
git commit -m "feat(assets): surface the variant-toggle strip in every view mode"
```

---

### Task 7: End-to-end — regenerate + variant toggle update the live game

**Files:**

- Modify: `studio/frontend/src/plugins/game/socketClient.ts` (dev-only expose of the live scene document)
- Create: `studio/frontend/e2e/asset-variant-sync.spec.ts`

**Interfaces:**

- Consumes: `window.__gameApplyInbound`, `window.__gameActiveId`, `window.__engineMsgs` (existing dev hooks), plus a new dev-only `window.__gameSceneDocument` reflecting the studio-synced scene document.

This spec is the authoritative behavioral contract. It asserts the **client end-state**: the studio-synced scene document's bound Texture `src` flips to the newly-selected generation (proving the broadcast `scene_op` was received and reconciled), and the engine iframe acks the op with no errors. The unit reconciler tests (`runtime/client/src/render/reconciler.spec.ts`) already prove `src` change → texture reload, so the e2e leans on those for the pixel-level swap.

- [ ] **Step 1: Expose the live scene document (dev only)**

In `studio/frontend/src/plugins/game/socketClient.ts`, in `applyInbound`, after each `sceneStore().document.set(...)` call, add a dev-only mirror:

```javascript
    if (!import.meta.env.PROD) {
      (window as unknown as { __gameSceneDocument?: unknown }).__gameSceneDocument =
        sceneStore().document.get({ noproxy: true });
    }
```

Do this in **both** branches (snapshot and op) so the hook always reflects the latest synced document.

Also expose the existing `emitSceneApplyOp` dev-only so the spec can persist placement ops to the backend. In `createGameSocket`, inside the existing `if (!import.meta.env.PROD) { … }` block (alongside `__gameApplyInbound`), add:

```javascript
      (window as unknown as { __gameEmitApplyOp?: (gameId: string, op: ISceneOp) => void }).__gameEmitApplyOp = (gameId, op) =>
        emitSceneApplyOp(gameId, op);
```

- [ ] **Step 2: Write the e2e spec**

Create `studio/frontend/e2e/asset-variant-sync.spec.ts`:

```javascript
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e never runs in CI). Requires the full replay stack:
//   engine :4300, backend :8000 (replay), studio :4200 — honor BLOOM_PORT_OFFSET.
// Proves the Asset Board → live game path end-to-end: regenerate auto-selects the
// newest variant and variant-toggle re-selects, each rewriting the bound Texture's
// src in the studio-synced scene document and re-rendering the engine iframe.

async function openAppAtRoom(page: Page, username: string): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__engineMsgs = [];
    window.addEventListener('message', (e) => {
      const d = e.data;
      if (d && (d.kind === 'ack' || d.kind === 'ready' || d.kind === 'error')) {
        (window as any).__engineMsgs.push({ origin: e.origin, kind: d.kind });
      }
    });
  });
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Variant Sync ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
}

function texSrc(page: Page, texId: string) {
  return page.evaluate((tid) => {
    const doc = (window as any).__gameSceneDocument as { nodes: Record<string, any> } | undefined;
    return doc?.nodes?.[tid]?.props?.src ?? null;
  }, texId);
}

test('regenerate auto-selects newest and variant-toggle re-selects, both updating the live game', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // 1. Author + generate one asset (replay produces a real image; gen1 selected).
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // 2. Open the Game Scene pane; wait for engine handshake.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string);
  expect(gameId).toBeTruthy();

  // 3. Read the asset id + gen1 image_ref from the backend wire.
  const { assetId, gen1Ref } = await page.evaluate(async (gid) => {
    const assets = await (await fetch(`/games/${gid}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((g: any) => g.id === a.selectedGenerationId) ?? a.generations[0];
    return { assetId: a.id as string, gen1Ref: sel.imageRef as string };
  }, gameId);

  // 4. Place the asset into the scene on the BACKEND (Texture carries assetId), so
  //    server-side rebind can find it. Persist via the studio→backend socket path
  //    (__gameEmitApplyOp); the backend applies each op and broadcasts scene_op back
  //    to the room, which updates __gameSceneDocument and re-renders the engine.
  await page.evaluate(
    ({ gid, aid, ref }) => {
      const send = (window as any).__gameEmitApplyOp as (gid: string, op: unknown) => void;
      send(gid, { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
      send(gid, { kind: 'addNode', id: 'spr.wild', type: 'Sprite' });
      send(gid, { kind: 'addNode', id: 'tex.wild', type: 'Texture', props: { src: ref, assetId: aid } });
      send(gid, { kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'spr.wild', port: 'parent' } });
      send(gid, { kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex.wild', port: 'data' }, to: { node: 'spr.wild', port: 'texture' } });
    },
    { gid: gameId, aid: assetId, ref: gen1Ref },
  );

  // baseline: the studio-synced document shows the bound texture at gen1
  await expect.poll(() => texSrc(page, 'tex.wild'), { timeout: 10000 }).toBe(gen1Ref);

  // 5. Regenerate on the board → auto-selects newest → backend rebinds → scene_op.
  await page.getByTestId('asset-generate').click();
  // the selected board image updates; the bound texture src flips to the new gen.
  const newRef = await expect
    .poll(async () => {
      const cur = await texSrc(page, 'tex.wild');
      return cur && cur !== gen1Ref ? cur : null;
    }, { timeout: 30_000 })
    .not.toBeNull()
    .then(() => texSrc(page, 'tex.wild'));
  expect(newRef).not.toBe(gen1Ref);

  // 6. Toggle back to the first variant via the candidate strip → game reverts.
  const firstThumb = page.getByTestId('asset-candidates').locator('img').first();
  await firstThumb.click();
  await expect.poll(() => texSrc(page, 'tex.wild')).toBe(gen1Ref);

  // 7. No engine errors throughout.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});
```

> **Step 2 note — backend persistence:** `__gameEmitApplyOp` (added in Step 1) routes each placement op through `emitSceneApplyOp` → the backend `scene_apply_op` socket handler, which applies + persists + broadcasts. The key requirement is that `tex.wild` with `props.assetId` exists in the **persisted** backend scene before Step 5, so the server-side rebind (Task 4/5) can find it.

- [ ] **Step 3: Start the replay backend and run the spec**

Run (honor `BLOOM_PORT_OFFSET` in worktrees — see `docs/worktrees.md`):

```bash
just backend-serve-replay   # in one terminal
just e2e -- asset-variant-sync   # or: cd studio/frontend && npx playwright test asset-variant-sync
```

Expected: PASS — baseline `tex.wild` src = gen1; after regenerate it differs; after toggling back it returns to gen1; zero engine errors.

- [ ] **Step 4: Run the existing game-scene e2e to confirm no regression**

Run: `cd studio/frontend && npx playwright test game-scene`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/game/socketClient.ts studio/frontend/e2e/asset-variant-sync.spec.ts
git commit -m "test(e2e): asset-board regenerate + variant toggle update the live game"
```

---

### Task 8: Whole-branch verification

- [ ] **Step 1: Backend suite**

Run: `uv --directory studio/backend run pytest -q`
Expected: PASS.

- [ ] **Step 2: Frontend gates (all four)**

Run:

```bash
cd studio/frontend
node_modules/.bin/prettier --check .
npx nx typecheck frontend
npx nx test frontend -- --run
npx nx build frontend
```

Expected: all PASS.

- [ ] **Step 3: Replay e2e (the changed flows)**

Run: `just backend-serve-replay` then `just e2e` (or at least `asset-variant-sync`, `game-scene`, `assets` specs).
Expected: PASS.

- [ ] **Step 4: Preflight + push + PR**

```bash
just preflight
git push -u origin feat/asset-board-variant-sync
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**

- Texture carries `assetId` → Task 1. ✓
- Canonical rebinder (assetId + id-convention fallback, no-op when unselected/unplaced) → Task 2. ✓
- Variant toggle → scene (REST) → Task 4. ✓
- Regenerate auto-selects newest + rebinds (board socket), agent path unchanged → Task 5. ✓
- Agent regenerate converged onto the rebinder → Task 3. ✓
- Toggle reachable in every view mode → Task 6. ✓
- Data-flow / end-state e2e asserting client reconciliation → Task 7 (+ backend e2e in Tasks 4–5). ✓
- Out-of-scope items (full reference model, per-placement overrides) → not implemented, by design. ✓

**Placeholder scan:** No TBD/TODO; every code step shows code. The two `> Note` blocks (Task 5 drain-await, Task 7 backend-persistence hook) point at concrete existing patterns/helpers rather than leaving work undefined — fold them into their tasks during execution.

**Type consistency:** `rebind_asset_textures(scene_store, scene_hub, game_id, asset)` signature is identical in Tasks 2, 3, 4, 5. `bound_texture_ids(document, *, asset_id, slot)` consistent. `build_sprite_ops(..., asset_id="")` and `_place_in_scene(..., asset_id="")` consistent across Task 1. `AssetHub(..., scene_store=None, scene_hub=None)` + `request_generation(..., auto_select=False)` consistent across Task 5 and main.py wiring. Frontend `candidateSize`/`showCandidates` consistent across Task 6. `__gameSceneDocument` / `__gameEmitApplyOp` hooks consistent across Task 7.

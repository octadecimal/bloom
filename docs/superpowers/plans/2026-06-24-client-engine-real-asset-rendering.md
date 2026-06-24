# Client Engine — Real Asset Rendering + Agent Path Lock-in (Plan 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make agent-authored `Sprite`s display real Asset Board images in the cross-origin engine iframe, and lock in the agent path with replay-backed end-to-end coverage.

**Architecture:** Three aligned `src`-resolution changes — the backend `list_assets` tool surfaces the selected generation's `/media/...` path (and the `design-scene` skill gains `list_assets`); the engine adds a pure `resolveTextureSrc(src, mediaBase)` and reads a host-derived `mediaBase` query param; the studio frontend passes a LAN-safe host-derived backend origin into the iframe. Then a curated `scene_*` run cassette + a backend agent-path e2e (CI) + a local browser e2e prove a real image renders pixels.

**Tech Stack:** TypeScript / Vite / Vitest / Pixi v8 (engine); React / hookstate / Playwright (frontend); Python 3 / FastAPI / motor / python-socketio / LangChain (backend).

## Global Constraints

- **Work in the worktree** `C:\code\bloom.wt\scene-assets` on branch `feat/scene-assets`. Never work in the primary checkout (`C:\code\bloom`).
- **Read the actual merged source**, never a plan's code block, when mirroring existing code (Plan 2 review hardening lives only in the merged files — e.g. the `setProp` guard).
- **Do not change the Plan 1 protocol shapes** (`runtime/client/src/protocol/messages.ts`, `PROTOCOL_VERSION = 1`). New behavior is additive (a query param, a test-only window global).
- **TypeScript interfaces use the `I` prefix** per `docs/coding-standards.md`.
- **Studio design language is authoritative** — `studio/frontend` UI uses only design-language Tailwind tokens; no raw hex/`rgba` outside `styles.css` (a guard test blocks it). (This plan adds no new visible UI styling.)
- **TDD mandatory** — RED → GREEN → REFACTOR per task; commit at each task boundary using Conventional Commits.
- **Prettier is a gate (frontend/docs)** — `npx prettier --check .` must pass before commit (run `npx prettier --write` on touched files first). **Backend: match existing 4-space style** (no Python formatter gate).
- **Backend tests use the `bloom_studio_test` DB** via the existing fixtures — never the shared dev DB.
- **Browser e2e (Playwright) is NOT run in CI** — local only. Backend unit + non-browser e2e (`pytest`) and frontend unit (`vitest`) ARE CI-affordable and expected to run in CI.
- **Non-interference:** engine port (`VITE_BLOOM_ENGINE_PORT`, default `4300`) and backend port (`VITE_BLOOM_BACKEND_PORT`, default `8000`) are env-overridable — not hard singletons. No GPU/ComfyUI use. Take the live stack (`:4200`/`:8000`/engine `:4300`) solo for the local browser e2e only, after confirming it is free.
- **Backend commands run from** `studio/backend` via `uv run …`. **Frontend/engine commands run from the worktree root** via `npx nx …`.

## File Structure

```
runtime/client/src/render/
├─ resolveSrc.ts          (NEW) pure resolveTextureSrc(src, mediaBase)
├─ resolveSrc.spec.ts     (NEW) unit tests
├─ pixiRenderer.ts        (MOD) add textureSizeOf(id) test-observability accessor
runtime/client/src/main.ts (MOD) read ?mediaBase, build resolveSrc, expose __engineRenderer

studio/backend/app/agent_tools.py            (MOD) list_assets surfaces the selected generation's media path
studio/backend/tests/test_agent_tools.py     (MOD) list_assets media-path assertions
skills/design-scene.md                        (MOD) add list_assets to tools + TEXTURES prose
studio/backend/tests/test_design_scene_skill.py (MOD) tools assertion now includes list_assets
studio/backend/tests/fixtures/replay/run/default.json (MOD) append a deterministic scene_* tool-call sequence
studio/backend/tests/e2e/test_scene.py        (MOD) add the agent-path test (design-scene under replay)

studio/frontend/src/plugins/game/config.ts        (MOD) BACKEND_PORT + backendOrigin()
studio/frontend/src/plugins/game/config.spec.ts   (MOD) backendOrigin() unit test
studio/frontend/src/plugins/game/GamePreviewPane.tsx      (MOD) append &mediaBase= to iframe src
studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx (MOD) assert src carries mediaBase
studio/frontend/e2e/game-scene.spec.ts (MOD) add the real-asset render test (local, authoritative)
```

---

## Phase A — Engine: resolve `Texture.src` to a media URL (`runtime/client`)

### Task 1: `resolveTextureSrc` + engine wiring + texture-size observability

**Files:**

- Create: `runtime/client/src/render/resolveSrc.ts`
- Create: `runtime/client/src/render/resolveSrc.spec.ts`
- Modify: `runtime/client/src/render/pixiRenderer.ts`
- Modify: `runtime/client/src/main.ts`

**Interfaces:**

- Consumes: `PixiRenderer` constructor `(host, resolveSrc?)` (already merged; `resolveSrc` defaults to identity — see `pixiRenderer.ts:61-64`), `Texture` from `pixi.js`.
- Produces:
  - `resolveTextureSrc(src: string, mediaBase: string): string` — absolute `http(s)://…` passthrough; root-relative (leading `/`) → `mediaBase + src` (when `mediaBase` non-empty); empty `mediaBase` or non-`/` src → returned unchanged.
  - `PixiRenderer.textureSizeOf(id: string): { width: number; height: number } | null` — the sprite's current texture size, or `null` if no such sprite/texture (test-observability for the browser e2e).
  - `main.ts` reads `?mediaBase=` and exposes `window.__engineRenderer` (alongside the existing `window.__engineModel`).

- [ ] **Step 1: Write the failing test**

`runtime/client/src/render/resolveSrc.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveTextureSrc } from './resolveSrc';

describe('resolveTextureSrc', () => {
  it('prefixes a root-relative /media path with the media base', () => {
    expect(resolveTextureSrc('/media/g1/a1/gen1.png', 'http://host:8000')).toBe('http://host:8000/media/g1/a1/gen1.png');
  });
  it('passes an absolute http(s) URL through unchanged', () => {
    expect(resolveTextureSrc('https://cdn.example/x.png', 'http://host:8000')).toBe('https://cdn.example/x.png');
  });
  it('is identity when mediaBase is empty (standalone)', () => {
    expect(resolveTextureSrc('/media/g1/a1/gen1.png', '')).toBe('/media/g1/a1/gen1.png');
  });
  it('leaves a non-root, non-absolute src unchanged (forward-compatible)', () => {
    expect(resolveTextureSrc('bundled/tile.png', 'http://host:8000')).toBe('bundled/tile.png');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from the worktree root): `npx nx test client`
Expected: FAIL — `Cannot find module './resolveSrc'`.

- [ ] **Step 3: Implement the helper**

`runtime/client/src/render/resolveSrc.ts`:

```ts
// Resolve a Texture.src to a URL the iframe can actually fetch. The engine is
// cross-origin (default :4300), so a root-relative /media path must be made
// absolute against the studio backend (passed in via ?mediaBase). Absolute URLs
// pass through; standalone (empty mediaBase) is identity, preserving Plan 1.
export function resolveTextureSrc(src: string, mediaBase: string): string {
  if (/^https?:\/\//i.test(src)) return src;
  if (mediaBase && src.startsWith('/')) return mediaBase + src;
  return src;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test client`
Expected: PASS.

- [ ] **Step 5: Add the `textureSizeOf` accessor to `PixiRenderer`**

In `runtime/client/src/render/pixiRenderer.ts`, add this method inside the `PixiRenderer` class (e.g. after `assignTexture`). It reads the live Pixi object's texture; Pixi's `Texture.EMPTY` reports width/height `0`, so a loaded image reports its real size.

```ts
  textureSizeOf(id: string): { width: number; height: number } | null {
    const obj = this.objects.get(id);
    if (!(obj instanceof Sprite)) return null;
    const tex = obj.texture;
    if (!tex) return null;
    return { width: tex.width, height: tex.height };
  }
```

(`Sprite` is already imported at the top of the file. This accessor is not unit-tested — Pixi needs a real WebGL canvas — and is exercised by the Phase D browser e2e.)

- [ ] **Step 6: Wire `mediaBase` + `resolveSrc` + `__engineRenderer` into `main.ts`**

Replace `runtime/client/src/main.ts` with (this preserves the merged Plan 2 origin-pinning and `?doc=` standalone loader exactly, adding only `mediaBase`, `resolveTextureSrc`, and the `__engineRenderer` global):

```ts
import { PixiRenderer } from './render/pixiRenderer';
import { resolveTextureSrc } from './render/resolveSrc';
import { createEngine } from './engine';
import type { InboundMessage, OutboundMessage } from './protocol/messages';
import { parseParentOrigin, originAllowed } from './protocol/origin';

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage element');

const params = new URLSearchParams(window.location.search);

// When embedded by the studio, the iframe src carries ?parentOrigin=<studio origin>.
// Standalone (no param) keeps Plan 1 behavior: accept any origin, post with '*'.
const expectedOrigin = parseParentOrigin(window.location.search);

// The studio also passes ?mediaBase=<backend origin> so root-relative /media paths
// resolve to the cross-origin backend. Empty in standalone → identity resolution.
const mediaBase = params.get('mediaBase') ?? '';

const post = (m: OutboundMessage) => window.parent?.postMessage(m, expectedOrigin ?? '*');
const renderer = new PixiRenderer(stage, (s) => resolveTextureSrc(s, mediaBase));
const { host, model } = createEngine({ renderer, post });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;
(window as unknown as { __engineRenderer: typeof renderer }).__engineRenderer = renderer;

window.addEventListener('message', (event: MessageEvent) => {
  if (!originAllowed(expectedOrigin, event.origin)) return;
  void host.handle(event.data as InboundMessage);
});

host.start();

// Standalone mode: ?doc=<url> loads a document file directly (no studio).
const docUrl = params.get('doc');
if (docUrl) {
  void fetch(docUrl)
    .then((r) => r.json())
    .then((document) => host.handle({ v: 1, kind: 'init', id: 'standalone', document }));
}
```

- [ ] **Step 7: Verify unit suite + typecheck + prettier, then commit**

Run:

```bash
npx nx test client
npx nx typecheck client
npx prettier --write runtime/client
npx prettier --check .
git add runtime/client
git commit -m "feat(client): resolve Texture.src to a host-derived media URL"
```

Expected: tests PASS, typecheck clean, prettier clean. (Plan 1/2 e2e unaffected: no `mediaBase` param → empty → identity resolution.)

---

## Phase B — Backend: surface the media URL + lock in the agent path (`studio/backend`)

### Task 2: `list_assets` surfaces the selected generation's media path

**Files:**

- Modify: `studio/backend/app/agent_tools.py` (the `build_list_assets_tool` function — `agent_tools.py:50-65` on the merged source)
- Modify: `studio/backend/tests/test_agent_tools.py`

**Interfaces:**

- Consumes: `Asset` (`studio/backend/app/assets/models.py`) — fields `id`, `name`, `category`, `selected_generation_id`, `generations: list[Generation]`; `Generation.id`, `Generation.image_ref` (the `/media/{game}/{asset}/{gen}.png` path).
- Produces: `list_assets` tool output where each asset line includes its selected generation's `image_ref`, or a `(no image yet)` marker when there is no selected generation. Resolution tolerates plain stubs lacking generation fields (use `getattr`), so the existing summary test keeps passing.

- [ ] **Step 1: Write the failing test (append to `studio/backend/tests/test_agent_tools.py`)**

Add a richer stub + test alongside the existing `test_list_assets_returns_id_name_category_summary` (which must keep passing):

```python
class _Gen:
    def __init__(self, id, image_ref):
        self.id, self.image_ref = id, image_ref


class _AssetWithGen:
    def __init__(self, id, name, category, selected_generation_id, generations):
        self.id, self.name, self.category = id, name, category
        self.selected_generation_id = selected_generation_id
        self.generations = generations


@pytest.mark.asyncio
async def test_list_assets_includes_selected_generation_media_path():
    asset = _AssetWithGen("a1", "knight", "sprite", "g2",
                          [_Gen("g1", "/media/x/a1/g1.png"), _Gen("g2", "/media/x/a1/g2.png")])
    tool = build_list_assets_tool(ToolContext("r1", "g1", _ListStore([asset]), None))
    out = await tool.ainvoke({})
    assert "/media/x/a1/g2.png" in out  # the SELECTED generation's path
    assert "/media/x/a1/g1.png" not in out


@pytest.mark.asyncio
async def test_list_assets_marks_assets_without_a_generation():
    asset = _AssetWithGen("a2", "sky", None, None, [])
    tool = build_list_assets_tool(ToolContext("r1", "g1", _ListStore([asset]), None))
    out = await tool.ainvoke({})
    assert "a2" in out and "no image yet" in out.lower()
```

- [ ] **Step 2: Run to verify it fails**

Run (from `studio/backend`): `uv run pytest tests/test_agent_tools.py -k list_assets -q`
Expected: FAIL — the new assertions fail (no media path in the output yet).

- [ ] **Step 3: Implement the enrichment**

In `studio/backend/app/agent_tools.py`, replace the body of `build_list_assets_tool`'s inner `list_assets` so each line appends the selected generation's media path. Add a small resolver above it (module scope):

```python
def _selected_media_ref(asset) -> str | None:
    sel = getattr(asset, "selected_generation_id", None)
    if not sel:
        return None
    for g in getattr(asset, "generations", []) or []:
        if getattr(g, "id", None) == sel:
            return getattr(g, "image_ref", None)
    return None
```

Then the inner function:

```python
    async def list_assets() -> str:
        assets = await ctx.asset_store.list_assets(ctx.game_id)
        if not assets:
            return "The Asset Board is empty."
        lines = []
        for a in assets:
            head = f"- {a.id}: {a.name}" + (f" ({a.category})" if getattr(a, "category", None) else "")
            ref = _selected_media_ref(a)
            lines.append(f"{head} — {ref}" if ref else f"{head} — (no image yet)")
        return "Assets on the board:\n" + "\n".join(lines)
```

Update the tool `description` to mention the media URL:

```python
        description="List the assets on the Asset Board for the current game: id, "
                    "name, category, and the image's media URL (use that URL as a "
                    "Texture's src). Assets with no generation show '(no image yet)'.",
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_agent_tools.py -k list_assets -q`
Expected: PASS (including the unchanged `..._summary` test).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/agent_tools.py studio/backend/tests/test_agent_tools.py
git commit -m "feat(assets): surface the selected generation's media URL in list_assets"
```

---

### Task 3: give `design-scene` the `list_assets` tool + texture guidance

**Files:**

- Modify: `skills/design-scene.md`
- Modify: `studio/backend/tests/test_design_scene_skill.py`

**Interfaces:**

- Consumes: the enriched `list_assets` (Task 2); `SCENE_TOOL_NAMES` (`studio/backend/app/scene/document.py`).
- Produces: `design-scene` declares `list_assets` among its `tools`; the TEXTURES step instructs the agent to call `list_assets` and use the returned media URL as a `Texture`'s `src`.

- [ ] **Step 1: Update the failing test**

In `studio/backend/tests/test_design_scene_skill.py`, change the tools assertion (`:15`) to include `list_assets`:

```python
    assert set(spec.tools) == SCENE_TOOL_NAMES | {"list_assets"}
```

- [ ] **Step 2: Run to verify it fails**

Run (from `studio/backend`): `uv run pytest tests/test_design_scene_skill.py -q`
Expected: FAIL — the skill still declares only `SCENE_TOOL_NAMES`.

- [ ] **Step 3: Edit the skill**

In `skills/design-scene.md` frontmatter, add `list_assets` to the `tools` list:

```yaml
tools: [scene_add_node, scene_set_prop, scene_connect, scene_disconnect, scene_remove_node, scene_apply_batch, list_assets]
```

Replace the TEXTURES step (step 4 in the prose) with:

```markdown
4. TEXTURES. For each image, first call `list_assets` to see the Asset Board and
   copy the **media URL** of the asset you want. Add a Texture node whose `src` is
   that media URL (e.g. `/media/<game>/<asset>/<gen>.png`), then bind it to its
   Sprite with a `data` edge. If an asset shows `(no image yet)`, it has not been
   generated — pick another or skip its texture.
```

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/test_design_scene_skill.py -q`
Expected: PASS (`reg.load()` still succeeds — `list_assets` is a known tool — and the tools set now matches).

- [ ] **Step 5: Commit**

```bash
git add skills/design-scene.md studio/backend/tests/test_design_scene_skill.py
git commit -m "feat(scene): give design-scene list_assets + media-URL texture guidance"
```

---

### Task 4: curate the scene run cassette + backend agent-path e2e (CI)

**Files:**

- Modify: `studio/backend/tests/fixtures/replay/run/default.json`
- Modify: `studio/backend/tests/e2e/test_scene.py`

**Background (read before editing):** The replay chat model (`studio/backend/app/providers.py:80` `ReplayToolCallingChatModel`) loads ONE run cassette (`tests/fixtures/replay/run/default.json` = `{"tool_calls": [...], "final": [...]}`) and **filters `tool_calls` by the running skill's bound tool names** (`_cassette_tool_calls`, `providers.py:132`). All surviving calls are emitted in a **single first turn**, then `final` streams. The checked-in cassette is a **hand-curated union across skills** (it already carries `generate_asset`, `delete_asset`, and `ask_user_question` — the last is how `test_gdd` reaches its question interrupt). So design-scene's cassette is **added `scene_*` calls in this same file** — NOT a `just record-fixtures` run (which only regenerates the `generate_asset` capture and would drop the curated union). Because only `design-scene` binds `scene_*` tools, these calls are invisible to every other skill/e2e.

**Interfaces:**

- Consumes: the Plan 2 scene tools' arg schemas — `scene_add_node(node_id, type, props_json)`, `scene_connect(edge_id, type, from_node, from_port, to_node, to_port)` (verify against the merged `studio/backend/app/agent_tools.py`); the Plan 2 socket events `join_scene` → `scene_snapshot{gameId, document}` and `scene_op{gameId, op}`.
- Produces: a deterministic Root→reels→3-sprite scene on replay; an e2e asserting the `game_scenes` doc gains a `Root` + child nodes and that `scene_op` broadcasts are observed.

- [ ] **Step 1: Write the failing e2e (append to `studio/backend/tests/e2e/test_scene.py`)**

```python
@pytest.mark.e2e
@pytest.mark.asyncio
async def test_design_scene_agent_builds_root_and_nodes(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    seen = {"ops": [], "snapshots": []}
    client.on("scene_op", lambda d: seen["ops"].append(d))
    client.on("scene_snapshot", lambda d: seen["snapshots"].append(d))

    await client.connect(live_server, auth={"displayName": "SceneAgent"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.2)

    await client.emit("run_skill", {
        "roomId": room_id,
        "skillName": "design-scene",
        "args": {},
        "text": "Build a basic slot scene.",
    })

    # Poll until a Root node op is broadcast (deadline ~15 s).
    deadline = asyncio.get_event_loop().time() + 15
    def _has_root():
        return any(o["op"].get("type") == "Root" for o in seen["ops"] if o["op"]["kind"] == "addNode")
    while not _has_root() and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)

    # 1. scene_op broadcasts were observed, including the Root.
    assert _has_root(), f"expected a Root addNode op; saw {[o['op'] for o in seen['ops']]}"
    child_ops = [o for o in seen["ops"] if o["op"]["kind"] == "addNode" and o["op"]["type"] != "Root"]
    assert child_ops, "expected at least one non-Root node op"

    # 2. The persisted document reflects the build: re-join for a fresh snapshot.
    seen["snapshots"].clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_event_loop().time() + 5
    while not seen["snapshots"] and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.05)
    doc = seen["snapshots"][-1]["document"]
    assert any(n["type"] == "Root" for n in doc["nodes"].values()), doc
    assert len(doc["nodes"]) >= 4, doc  # root + reels + >=2 sprites
    assert doc["edges"], "expected child edges in the persisted scene"

    await client.disconnect()
```

- [ ] **Step 2: Run to verify it fails**

First start a replay backend in a separate terminal: `just backend-serve-replay`.
Run (from `studio/backend`): `BLOOM_E2E_TIER=replay uv run pytest tests/e2e/test_scene.py::test_design_scene_agent_builds_root_and_nodes -q`
Expected: FAIL — the cassette has no `scene_*` calls, so `design-scene` builds nothing (no Root op).

- [ ] **Step 3: Append the scene tool calls to the run cassette**

Edit `studio/backend/tests/fixtures/replay/run/default.json` — insert these objects into the `tool_calls` array (after the existing entries; ordered so every `connect` follows its nodes). Keep the existing `generate_asset`/`delete_asset`/`ask_user_question` entries and the `final` array unchanged:

```json
    { "name": "scene_add_node", "args": { "node_id": "root", "type": "Root", "props_json": "{\"width\":1280,\"height\":720}" } },
    { "name": "scene_add_node", "args": { "node_id": "reels", "type": "Container", "props_json": "" } },
    { "name": "scene_add_node", "args": { "node_id": "sym.1", "type": "Sprite", "props_json": "" } },
    { "name": "scene_add_node", "args": { "node_id": "sym.2", "type": "Sprite", "props_json": "" } },
    { "name": "scene_add_node", "args": { "node_id": "sym.3", "type": "Sprite", "props_json": "" } },
    { "name": "scene_connect", "args": { "edge_id": "e.root.reels", "type": "child", "from_node": "root", "from_port": "children", "to_node": "reels", "to_port": "parent" } },
    { "name": "scene_connect", "args": { "edge_id": "e.reels.1", "type": "child", "from_node": "reels", "from_port": "children", "to_node": "sym.1", "to_port": "parent" } },
    { "name": "scene_connect", "args": { "edge_id": "e.reels.2", "type": "child", "from_node": "reels", "from_port": "children", "to_node": "sym.2", "to_port": "parent" } },
    { "name": "scene_connect", "args": { "edge_id": "e.reels.3", "type": "child", "from_node": "reels", "from_port": "children", "to_node": "sym.3", "to_port": "parent" } }
```

(Ensure the array stays valid JSON — a comma after the prior last entry, no trailing comma after the final `scene_connect`.)

- [ ] **Step 4: Run to verify it passes**

Run: `BLOOM_E2E_TIER=replay uv run pytest tests/e2e/test_scene.py -q`
Expected: PASS (both the Plan 2 empty-snapshot test and the new agent-path test).

- [ ] **Step 5: Guard against cross-skill regression, then commit**

Run the skill/tool suites that also read this cassette to confirm the appended calls are correctly filtered out for other skills:

```bash
uv run pytest tests/test_agent_tools.py tests/test_design_scene_skill.py tests/e2e/test_scene.py -q
git add studio/backend/tests/fixtures/replay/run/default.json studio/backend/tests/e2e/test_scene.py
git commit -m "test(scene): replay cassette + agent-path e2e for design-scene"
```

---

## Phase C — Frontend: pass a LAN-safe media base into the iframe (`studio/frontend`)

### Task 5: `backendOrigin()` config + `mediaBase` iframe param

**Files:**

- Modify: `studio/frontend/src/plugins/game/config.ts`
- Modify: `studio/frontend/src/plugins/game/config.spec.ts`
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.tsx`
- Modify: `studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`

**Interfaces:**

- Consumes: `window.location` (host-derivation), the merged `config.ts` (`engineOrigin`, `ENGINE_PORT`, re-exported `BACKEND_URL`), the merged `GamePreviewPane.tsx` iframe `src` (`GamePreviewPane.tsx:46`).
- Produces: `ENGINE_PORT`-style `BACKEND_PORT` (`VITE_BLOOM_BACKEND_PORT`, default `8000`) and `backendOrigin(): string` = `${protocol}//${hostname}:${BACKEND_PORT}`; the iframe `src` carries `&mediaBase=<encoded backendOrigin>`.

- [ ] **Step 1: Write the failing config test (append to `config.spec.ts`)**

```ts
import { engineOrigin, ENGINE_PORT, backendOrigin, BACKEND_PORT } from './config';

describe('backendOrigin', () => {
  it('derives the backend origin from the current host + backend port', () => {
    // jsdom default location is http://localhost
    expect(backendOrigin()).toBe(`http://localhost:${BACKEND_PORT}`);
  });
  it('defaults the backend port to 8000', () => {
    expect(BACKEND_PORT).toBe('8000');
  });
});
```

(Merge the new `import` with the file's existing `engineOrigin`/`ENGINE_PORT` import rather than duplicating it.)

- [ ] **Step 2: Run to verify it fails**

Run (from the worktree root): `npx nx test frontend -- config.spec`
Expected: FAIL — `backendOrigin`/`BACKEND_PORT` are not exported.

- [ ] **Step 3: Implement `BACKEND_PORT` + `backendOrigin()`**

Append to `studio/frontend/src/plugins/game/config.ts`:

```ts
// The studio backend (default :8000) serves /media. The engine iframe is
// cross-origin, so it needs an absolute, host-derived backend origin — never a
// hardcoded localhost (LAN rule), mirroring engineOrigin() above.
export const BACKEND_PORT: string = (import.meta.env.VITE_BLOOM_BACKEND_PORT as string | undefined) ?? '8000';

export function backendOrigin(): string {
  return `${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx nx test frontend -- config.spec`
Expected: PASS.

- [ ] **Step 5: Write the failing pane test**

In `studio/frontend/src/plugins/game/GamePreviewPane.spec.tsx`, extend the "renders the engine iframe…" test with a `mediaBase` assertion:

```tsx
expect(frame.getAttribute('src')).toContain('mediaBase=');
expect(frame.getAttribute('src')).toContain(encodeURIComponent(`http://localhost:8000`));
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx nx test frontend -- GamePreviewPane`
Expected: FAIL — the src has no `mediaBase` param yet.

- [ ] **Step 7: Add `mediaBase` to the iframe src**

In `studio/frontend/src/plugins/game/GamePreviewPane.tsx`, import `backendOrigin` and extend the `src` (`:46`):

```tsx
import { engineOrigin, backendOrigin } from './config';
```

```tsx
const src = `${engineOrigin()}/?parentOrigin=${encodeURIComponent(window.location.origin)}&mediaBase=${encodeURIComponent(backendOrigin())}`;
```

- [ ] **Step 8: Run to verify it passes, then typecheck + prettier + commit**

Run:

```bash
npx nx test frontend -- config.spec GamePreviewPane
npx nx typecheck frontend
npx prettier --write studio/frontend/src/plugins/game
npx prettier --check .
git add studio/frontend/src/plugins/game
git commit -m "feat(game): pass a host-derived mediaBase into the engine iframe"
```

Expected: tests PASS, typecheck clean, prettier clean.

---

## Phase D — Browser e2e: a real image renders pixels (`studio/frontend`, local, authoritative)

### Task 6: real-asset render test in the engine iframe

**Files:**

- Modify: `studio/frontend/e2e/game-scene.spec.ts`

**Background (read before editing):** This is the authoritative proof that a real asset renders. It reuses the asset-generation flow (`studio/frontend/e2e/assets.spec.ts` — author asset, click Generate, a real >64px image appears under replay) to produce a media file, then drives scene ops via the existing `window.__gameApplyInbound` path (`game-scene.spec.ts:57`). The engine iframe is cross-origin (`:4300`), but **Playwright can evaluate inside it** via `elementHandle.contentFrame()` (this is not blocked like top-window `contentWindow` access). The engine exposes `window.__engineRenderer` (Task 1) so the test can read the bound sprite's texture size.

**Interfaces:**

- Consumes: the asset UI test-ids from `assets.spec.ts` (`asset-name`, `asset-prompt`, `asset-workflow`, `asset-generate`, `asset-selected-image`); the scene pane test-ids from `game-scene.spec.ts` (`game-engine-frame`, `window.__gameActiveId`, `window.__gameApplyInbound`); `window.__engineRenderer.textureSizeOf(id)`; REST `GET /games/{gameId}/assets` (returns wire assets with `generations[].imageRef` + `selectedGenerationId`).
- Produces: a test that binds a generated asset's media URL to a Sprite and asserts the engine's sprite texture loaded (width > 64) with no engine errors.

- [ ] **Step 1: Write the test (append to `studio/frontend/e2e/game-scene.spec.ts`)**

```ts
test('a generated asset renders as a real sprite texture in the engine iframe (live, no reload)', async ({ page }) => {
  const url = await openAppAtRoom(page, 'ada');
  const gameId = new URL(url).pathname.split('/').pop() as string;

  // 1. Author + generate one asset (replay produces a real >64px image on disk).
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // 2. Read the asset's selected media path from the backend wire.
  const imageRef = await page.evaluate(async (gid) => {
    const assets = await (await fetch(`/games/${gid}/assets`)).json();
    const a = assets[0];
    const sel = a.generations.find((g: any) => g.id === a.selectedGenerationId) ?? a.generations[0];
    return sel.imageRef as string;
  }, gameId);
  expect(imageRef).toMatch(/^\/media\//);

  // 3. Open the Game Scene pane and wait for the engine handshake.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  await expect.poll(() => page.evaluate(() => (window as any).__engineMsgs?.some((m: any) => m.kind === 'ready')), { timeout: 20000 }).toBe(true);

  // 4. Build a root → sprite, add a Texture(src=imageRef), bind it with a data edge.
  await page.evaluate(
    ({ gid, ref }) => {
      const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
      const op = (o: unknown) => apply('scene_op', { gameId: gid, op: o });
      op({ kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } });
      op({ kind: 'addNode', id: 'sym', type: 'Sprite' });
      op({ kind: 'addNode', id: 'tex', type: 'Texture', props: { src: ref } });
      op({ kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 'sym', port: 'parent' } });
      op({ kind: 'connect', edgeId: 'e.data', type: 'data', from: { node: 'tex', port: 'data' }, to: { node: 'sym', port: 'texture' } });
    },
    { gid: gameId, ref: imageRef },
  );

  // 5. Inside the cross-origin engine frame, poll the sprite's texture size > 64.
  const frame = await (await page.getByTestId('game-engine-frame').elementHandle())!.contentFrame();
  await expect
    .poll(async () => frame!.evaluate(() => (window as any).__engineRenderer?.textureSizeOf('sym')?.width ?? 0), { timeout: 20000 })
    .toBeGreaterThan(64);

  // 6. No engine errors during the session.
  expect(await page.evaluate(() => (window as any).__engineMsgs.filter((m: any) => m.kind === 'error').length)).toBe(0);
});
```

- [ ] **Step 2: Run the browser e2e locally (local-only — never CI)**

Bring up the full stack solo (after confirming `:4200`/`:8000`/`:4300` are free): `just backend-serve-replay`, the engine (`npx nx serve client`), and the studio (`npx nx serve frontend`). Then:

Run (from the worktree root): `npx nx e2e frontend -- --grep "real sprite texture"`
Expected: PASS — the sprite's texture reports the generated image's size (> 64) and no engine `error` messages occur. If it fails because the engine never calls `loadTexture` on a `data` edge, that is a Plan 1/2 texture-binding gap to fix (the e2e is the authoritative contract).

- [ ] **Step 3: Prettier + commit**

```bash
npx prettier --write studio/frontend/e2e/game-scene.spec.ts
npx prettier --check .
git add studio/frontend/e2e/game-scene.spec.ts
git commit -m "test(game): e2e — a generated asset renders as a real sprite texture"
```

---

## Final verification (before opening the PR)

Run the CI-affordable suites from the worktree, plus the full local e2e per repo policy:

```bash
# Engine + frontend unit + types + build
npx nx test client
npx nx test frontend
npx nx typecheck client && npx nx typecheck frontend
npx nx build frontend
npx prettier --check .

# Backend unit + non-browser e2e (start `just backend-serve-replay` first for e2e)
cd studio/backend && uv run pytest -q && uv run pytest -m e2e -q
```

Then run `just e2e` (replay backend) once for the full browser suite — per the repo's "always run e2e before PR" rule — then push and open a PR (`git push -u origin feat/scene-assets` → `gh pr create`).

---

## Self-Review

**Spec coverage:**

- §3.1 backend list_assets + skill tools → Tasks 2, 3.
- §3.2 engine `resolveTextureSrc` + `mediaBase` → Task 1.
- §3.3 frontend `backendOrigin()` + iframe `mediaBase` → Task 5.
- §5A unit (engine/frontend/backend) → Tasks 1, 5, 2.
- §5B cassette + backend agent-path e2e → Task 4 (corrected: curate the run cassette, not `record-fixtures` — see Task 4 background).
- §5C browser real-asset render e2e → Task 6.
- §6 scope (no asset-id resolver; AssetCard localhost untouched) → respected; no task touches them.

**Placeholder scan:** none — every step carries exact code/commands.

**Type consistency:** `resolveTextureSrc(src, mediaBase)`, `textureSizeOf(id)`, `backendOrigin()`/`BACKEND_PORT`, and the scene op/arg shapes (`node_id/type/props_json`, `edge_id/type/from_node/from_port/to_node/to_port`; ops `kind/id/type/props`, `connect edgeId/type/from/to`) are used consistently across tasks and match the merged Plan 2 source.

**Note for implementers:** Task 4 is the one deviation from the spec's wording — the cassette is _curated_, not live-recorded, because the run cassette is a single hand-authored multi-skill file filtered by bound tool names (verified in `providers.py` + the checked-in `run/default.json`). Confirm the scene tool arg names against the merged `agent_tools.py` before authoring the JSON.

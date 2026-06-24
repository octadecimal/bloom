# Client Engine — Real Asset Rendering + Agent Path Lock-in (Plan 3) Design

- **Date:** 2026-06-24
- **Status:** Approved (design); next step is an implementation plan
- **Component:** `runtime/client/` (engine), `studio/backend/` (assets tool + scene e2e),
  `studio/frontend/` (game plugin config), `skills/design-scene.md`
- **Worktree / branch:** `C:\code\bloom.wt\scene-assets` on `feat/scene-assets`
- **Consumes:** the Plan 1 contract (`runtime/client/src/model/ops.ts`,
  `.../model/document.ts`, `.../protocol/messages.ts`) and the Plan 2 integration
  (`studio/backend/app/scene/`, `studio/frontend/src/plugins/game/`, `skills/design-scene.md`)
- **Related:** [`2026-06-24-client-engine-studio-integration-design.md`](2026-06-24-client-engine-studio-integration-design.md)
  (Plan 2, esp. §8 open decisions and §7 scope boundary, which deferred richer asset resolution)

---

## 1. Essence

Plan 2 wired the engine into the studio so an agent authors a live scene graph that the
embedded iframe renders incrementally. But a `Sprite`'s image never actually appears: the
engine constructs `new PixiRenderer(stage)` with the **default identity `resolveSrc`**
(`runtime/client/src/main.ts:14`), so whatever lands in a `Texture.src` is handed straight
to `Assets.load(...)` — and the agent has **no way to obtain a real media URL** to put there
in the first place.

Plan 3 closes both halves of that gap, then **locks in the agent path** with replay-backed
end-to-end coverage:

1. **Real assets render.** Make the media URL reachable by the scene agent, and teach the
   cross-origin engine iframe to resolve a `/media/...` path to an absolute, LAN-safe
   backend URL — so a `Sprite` bound to a `Texture` displays a real Asset Board image.
2. **Lock in the agent path.** Record the `design-scene` replay cassette and add a backend
   non-browser e2e (CI) that runs `design-scene` **through the real agent loop** under
   replay and asserts the scene materialises + broadcasts. A local browser e2e proves a
   real image actually renders pixels in the iframe.

---

## 2. The decision that shapes this plan

**How does an agent reference an Asset Board image in a `Texture.src`?**

**Decision: media-URL binding (the simplest path).** The agent puts a `/media/...` path
(obtained from `list_assets`) into `Texture.src`; the engine prefixes it with a
host-derived backend base. We do **not** build an asset-id → URL resolver this iteration
(deferred per Plan 2 spec §7).

**Why this is forced, not merely preferred:** `list_assets` (`agent_tools.py:50`) returns
only `id / name / category` — **not** the media URL. And `list_assets` is **not even in the
`design-scene` skill's `tools`**, so the scene agent cannot see assets at all today. The
skill's current instruction ("use an asset id **or media URL** from the Asset Board") is
therefore un-actionable. The minimal fix is to surface the media URL and let the agent use
it directly; an asset-id resolver would need _more_ work (a resolution endpoint or op-time
rewrite, `game_id` threading, an extra cross-origin fetch) for stability we are explicitly
deferring.

**Rejected / deferred alternatives:**

- **Asset-id + resolver** — agent emits a bare asset id; backend rewrites `src` at op-apply
  time, or the engine fetches a resolve endpoint. More robust to re-selecting a generation,
  but heavier and out of this iteration's scope.
- **Accept either** id or URL — most flexible for the agent, most code and two paths to
  test. Not now.

The premium bar still holds where it counts: the browser e2e (§5, Section C) asserts a real
image _loads pixels_, not merely that a node exists.

---

## 3. Texture `src` → media-URL resolution

Three small, aligned changes across backend, engine, and frontend.

### 3.1 Backend — make the media URL reachable by the agent

- **Enrich `list_assets`** (`studio/backend/app/agent_tools.py`): each line gains the
  **selected generation's `image_ref`** (the `/media/{game_id}/{asset_id}/{gen_id}.png`
  path), or a clear "no image yet" marker when an asset has no selected generation. This is
  the only channel by which the agent can learn a concrete media path. Resolution: map
  `asset.selected_generation_id` → that `Generation.image_ref`
  (`studio/backend/app/assets/models.py`).
- **Add `list_assets` to the `design-scene` skill's `tools`** (`skills/design-scene.md`
  frontmatter) — it is absent today. Update the prose (step 4 — TEXTURES) to: _call
  `list_assets`, then set the `Texture`'s `src` to the media URL it returns_; drop the false
  "asset id" option.

### 3.2 Engine — a host-derived `resolveSrc`

- A new pure helper `resolveTextureSrc(src, mediaBase): string` (own module + unit test):
  - absolute `http(s)://…` → returned unchanged (passthrough);
  - root-relative (`/media/…`, or any leading `/`) → `mediaBase + src`;
  - `mediaBase` empty/absent (standalone) → identity (preserves Plan 1 behaviour and the
    `?doc=` standalone loader).
- `runtime/client/src/main.ts` reads a new `mediaBase` query param (alongside
  `parentOrigin`) and constructs `new PixiRenderer(stage, (s) => resolveTextureSrc(s, mediaBase))`.

### 3.3 Frontend — pass a LAN-safe media base into the iframe

- `studio/frontend/src/plugins/game/config.ts` gains `BACKEND_PORT`
  (`VITE_BLOOM_BACKEND_PORT`, default `8000`) and
  `backendOrigin() = ${window.location.protocol}//${window.location.hostname}:${BACKEND_PORT}`.
  This is **host-derived — never `localhost`** (per the LAN rule), and deliberately **not**
  the existing `BACKEND_URL` (which defaults to `http://localhost:8000`). It mirrors the
  existing host-derived `engineOrigin()`.
- `GamePreviewPane.tsx` appends `&mediaBase=${encodeURIComponent(backendOrigin())}` to the
  iframe `src` (which already carries `?parentOrigin=`).
- **CORS is already permissive** (`studio/backend/app/main.py`:
  `CORSMiddleware allow_origins=["*"]`), so a cross-origin `:4300 → :8000/media` fetch
  succeeds without backend changes.

---

## 4. Data flow

```
Bind a real image (agent path):
  design-scene agent
    → list_assets                          [now returns /media/<g>/<a>/<gen>.png]
    → scene_add_node Texture {src: "/media/g1/a1/gen1.png"}
    → scene_connect data (Texture → Sprite)
        → GameSceneHub.apply_op → persist + broadcast scene_op
    → frontend socketClient → ProtocolBridge.op → engine
        → engine loadTexture(src)
            → resolveTextureSrc("/media/...", mediaBase="http://<host>:8000")
            → Assets.load("http://<host>:8000/media/g1/a1/gen1.png")   [CORS *]
            → Sprite.texture = loaded image   → pixels on screen

Standalone (no studio):
  no mediaBase param → resolveTextureSrc is identity → Plan 1 behaviour intact
```

---

## 5. Testing strategy

Per repo policy: **TDD mandatory**; **e2e is the authoritative behavioral contract**;
browser e2e runs locally only; backend unit + non-browser e2e are CI-affordable.

### Section A — unit

- **Engine (vitest, CI):** `resolveTextureSrc` — absolute passthrough, root-relative prefix,
  standalone identity (empty `mediaBase`).
- **Frontend (vitest, CI):** `backendOrigin()` host-derivation (uses `window.location`,
  never `localhost`); the iframe `src` includes a `mediaBase` param.
- **Backend (pytest, CI):** `list_assets` tool output includes the selected generation's
  media path, and shows the "no image yet" marker when none is selected.

### Section B — design-scene cassette + backend non-browser e2e (CI)

- **Record the cassette** (`just record-fixtures`, **live** providers, local) by driving one
  real `design-scene` run with a **fixed prompt** (proposed: _"Build a basic slot scene: a
  1280×720 root stage with a reels container holding three symbol sprites"_). Prompt-keyed,
  mirroring the gdd cassettes.
- **New `studio/backend/tests/e2e/test_scene.py`** (CI, mirrors `tests/e2e/test_gdd.py`):
  boot replay, a socket.io client joins the scene room, run the `design-scene` turn **through
  TurnRunner (the real agent loop)**, and assert (a) the `game_scenes` doc gains a `Root`
  node + child nodes, and (b) `scene_op` broadcasts are observed by the client. This is the
  **agent-path** proof — distinct from any Plan 2 hub-level test that drove ops directly.

### Section C — browser e2e: a real image renders in the iframe (local, authoritative)

- **Extend `studio/frontend/e2e/game-scene.spec.ts`:** seed one asset with a real media file
  (insert the asset doc + write a small known PNG under the media root), drive scene ops
  binding a `Sprite` → `Texture(src = that /media path)`, and assert **in the real engine
  iframe** that the sprite's texture actually loaded (non-`EMPTY`, expected dimensions) —
  proving the cross-origin `/media` fetch + `resolveTextureSrc` end-to-end. Without this we
  cannot honestly claim "renders real assets."

### Non-interference (other worktrees)

- Engine port (`VITE_BLOOM_ENGINE_PORT`, default `4300`) and backend port
  (`VITE_BLOOM_BACKEND_PORT`, default `8000`) are env-overridable — no hard singletons.
- All backend tests use the `bloom_studio_test` DB. The browser e2e writes its seed PNG to a
  test-scoped media root, not the shared dev media dir.
- Non-browser e2e + unit run under **replay**; **live** providers are used only to record
  the cassette. Take the live stack (`:4200`/`:8000`/engine) solo for the local browser e2e,
  after confirming it is free.
- No GPU/ComfyUI use (Plan 3 references/seeds assets; generates none).

---

## 6. Scope boundary

**In this iteration:**

- Backend: enrich `list_assets` with the media path; the `design-scene` cassette; the
  agent-path non-browser e2e (`test_scene.py`).
- Engine: `resolveTextureSrc` helper + `mediaBase` query-param wiring in `main.ts`.
- Frontend: `BACKEND_PORT` / `backendOrigin()` in the game plugin `config.ts`; the
  `mediaBase` iframe param in `GamePreviewPane`.
- Skill: `design-scene.md` gains `list_assets` and updated TEXTURES guidance.
- Tests: the unit + e2e coverage in §5.

**Labeled, not built (deferred):**

- Asset-id → URL resolver and re-selection stability (a `Texture` bound to a media path does
  **not** auto-update if the user later selects a different generation) — Plan 2 spec §7.
- Accepting both an asset id and a URL in `src`.
- Fixing `AssetCard`'s `localhost` `BACKEND_URL` default for LAN — a separate latent issue in
  the assets plugin; **noted, not fixed here** (the engine path uses the correct host-derived
  base).
- Client-initiated ops, multiple scenes per game, TS/Python model codegen — all still per
  Plan 2 spec §7.

---

## 7. Open / deferred decisions

- The exact `record-fixtures` prompt string is proposed in §5B; finalised when recording.
- Whether to later promote `backendOrigin()` (host-derived) over the assets plugin's
  `localhost` `BACKEND_URL` for full LAN correctness across the studio — deferred.

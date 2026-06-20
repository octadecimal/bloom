# Game Assets — `assets` plugin (backend + frontend) design

- **Date:** 2026-06-20
- **Status:** Design approved (brainstorming complete). Ready for implementation planning.
- **Scope:** A new `assets` plugin spanning `studio/backend` (`app/assets/` +
  shared `app/games.py`) and `studio/frontend` (`src/plugins/assets/`). Introduces
  the **Game** spine (created via chat-room creation) and **Asset** entities that
  generate images through the existing ComfyUI pipeline, with real-time progress
  over Socket.IO.
- **Parent context:** the platform architecture
  ([`2026-06-18-bloom-platform-architecture-design.md`](./2026-06-18-bloom-platform-architecture-design.md),
  esp. §5 studio, §8 "assets by reference", §16 build order) and the chat work
  ([`2026-06-19-llm-chat-design.md`](./2026-06-19-llm-chat-design.md) — the
  `gameId` seam this design finally fills).

## 1. Summary

The studio today has only chat plus a `gameId` seam pointing at nothing. This
subsystem builds **art/asset authoring**: a thin **Game** record (the spine the
`gameId` seam now points at) and the **Asset** entities a game owns. An asset
describes one image to generate — `prompt`, size, base workflow, optional seed —
and a per-asset **Generate** action runs the ComfyUI pipeline (`comfyui/`,
validated end-to-end) with **real-time progress streamed over Socket.IO**, storing
each result so a designer can keep several candidates and pick the best.

Authoring is **manual** this round. The LLM that auto-populates the asset list is a
later subsystem (§9). This subsystem reuses the chat stack's proven patterns: the
`RoomHub` queue/lock/active-snapshot resume model, the `Provider` Protocol + `Fake`
for GPU-free tests, the flat REST router, the hookstate slice with
scoped-subscription render discipline, and the `notify` (sonner) toast seam.

## 2. Decisions resolved in brainstorming

1. **Scope = authoring _and_ generation (not authoring-only).** The deliverable
   includes the ComfyUI generation pipeline with live progress, not just CRUD.
2. **Entities are grouped under a Game** (not a flat list). The Game is the
   top-level design object; assets are its first facet (math/seeds/package come
   later, architecture §16).
3. **The parent is the real `Game` entity**, kept thin (`id`, `name`, `createdAt`).
   It is the cross-domain spine; `room.gameId` now points at it.
4. **Game lifecycle is owned by the chat side.** Creating a chat room creates a
   Game (1:1 for now; game name = room name). The **assets workspace never
   creates, renames, or deletes a Game** — it only selects an existing one.
   Many-rooms-per-game is supported by the model but not built in the UI yet.
5. **Generation streams over the existing Socket.IO transport** (real-time
   feedback required), mirroring chat — not synchronous REST and not REST polling.
6. **Generation history is first-class.** Each asset keeps a list of candidate
   generations plus a selected one — the ComfyUI workflow is explicitly "generate
   a few seeds and pick the best" (`comfyui/README.md`). This is the one place we
   spend slightly more than minimal, deliberately.
7. **`category` is an optional free-form string seam**, not an enforced enum — no
   taxonomy lock-in while slots is the only game.

## 3. Data model

Wire models are camelCase (mirroring `app/models.py`, `to_camel` alias generator).
New MongoDB collections: `games`, `assets`.

```
Game        { id, name, createdAt }
Asset       { id, gameId, name, category?,
              prompt, width, height, workflow, seed?,
              status,                          // idle | queued | generating | done | error
              generations: Generation[],
              selectedGenerationId?, error? }
Generation  { id, seed, imageRef, createdAt }
```

- `workflow ∈ { schnell-opaque, schnell-transparent, dev-transparent }` — selects
  the base graph JSON (steps/cfg/scheduler + whether BiRefNet matting runs).
- `seed` blank → random per run; the **actual** seed used is recorded on the
  `Generation`, so any candidate is bit-reproducible (FLUX is deterministic per
  seed).
- `imageRef` is a **URL** to a backend-served file (§5), never an embedded blob —
  consistent with the architecture's "presentation as asset references" rule (§8).
- `category` is nullable free-form (e.g. "symbol" / "logo" / "background"); a seam
  for later packaging, no enum.

## 4. Game lifecycle & ownership

- **Create:** `POST /rooms` (chat) now also creates a `Game` via the shared
  `GameStore` and stores its id on the room (`room.gameId` becomes non-null for new
  rooms). Game name = room name for the 1:1 phase.
- **Read:** `GET /games` returns the game list; the assets workspace consumes it.
- **No game mutation from the workspace.** Rename/delete and multi-room-per-game
  are out of scope (§9).
- **Existing rooms** with `gameId = null` simply don't appear as selectable games —
  no migration required.

The `Game` model + `GameStore` live in a small **shared `app/games.py`** module
(the Game is a cross-domain spine, owned by neither chat nor assets). Chat depends
on it to create a game on room creation; assets depends on it only to _read_ the
game list.

## 5. Backend architecture

New `app/assets/` subpackage (keeps the second domain cleanly separated from the
flat chat modules; chat modules are otherwise untouched):

```
app/games.py            # shared: Game model + GameStore (games collection)
app/assets/
  models.py             # Asset, Generation wire models (+ *_wire helpers)
  store.py              # AssetStore: assets collection — CRUD, add_generation, select_generation
  comfy.py              # ComfyProvider Protocol + FakeComfyProvider + RealComfyProvider + build_provider
  graph.py              # pure: patch a base workflow JSON with {prompt,width,height,seed} -> API graph
  hub.py                # AssetHub: per-game Socket.IO room; queue/lock/active-snapshot (mirrors RoomHub)
  sockets.py            # join_game / leave_game / generate_asset handlers
  rest.py               # games (read) + assets (CRUD) router
```

**Wiring (`app/main.py`):** build `GameStore`, `AssetStore`, a `ComfyProvider`
(`build_provider` from settings), and an `AssetHub`; register the asset socket
handlers on the same `socketio.AsyncServer`; include the assets REST router; mount
`StaticFiles` for generated media (§5.3). Chat's `build` path is extended to create
a game on room creation via `GameStore`.

### 5.1 Socket scope = the Game

A client `join_game(gameId)` to receive that game's asset events (mirrors chat's
`join_room`). The Socket.IO room key is the `gameId`. Events are emitted to the
game room so every viewer of a game sees asset updates live.

**Client → server:** `join_game {gameId}`, `leave_game {gameId}`,
`generate_asset {gameId, assetId}`.

**Server → client:** `asset_status {gameId, assetId, status, queueDepth}`,
`asset_progress {gameId, assetId, value, max}`,
`asset_completed {gameId, asset}` (full asset wire, incl. the new generation +
selection), `error {gameId, message}`.

### 5.2 Generation flow (one asset's Generate)

1. `generate_asset` → `AssetHub` enqueues; sets the asset `queued`; emits
   `asset_status`. (Per-game queue/lock/busy, identical structure to `RoomHub`.)
2. Drain picks the asset, sets `generating`. `graph.py` loads the base graph for
   `asset.workflow` and patches in `prompt` (node 6 `text`), `width`/`height`
   (node 5), and `seed` (node 3; random if blank). `ComfyProvider.generate(...)`
   submits to ComfyUI `POST /prompt`.
3. **Progress:** the provider relays ComfyUI's progress WS `progress {value,max}`
   as an async iterator; the hub emits `asset_progress {assetId, value, max}`.
4. **Completion:** provider pulls the image (`/history/{prompt_id}` → `/view`),
   the backend **saves the bytes** to the media dir (§5.3); the hub appends a
   `Generation` (recording the actual seed + `imageRef`), auto-selects it when it
   is the asset's first generation, persists, and emits `asset_completed` with the
   full asset.
5. **Failure** → `asset_status = error` + an `error` toast; the queue keeps
   draining remaining work (mirrors `RoomHub._drain`'s resilience).

**In-flight resume:** `join_game` emits a snapshot of every currently-generating
asset in that game (active map keyed by `assetId`), so a freshly-opened tab catches
mid-generation progress — the chat `stream_snapshot` pattern, reused.

### 5.3 Media storage & serving

Generated images are saved under a **gitignored media dir** (e.g.
`var/media/{gameId}/{assetId}/{generationId}.png`) and served via a FastAPI
`StaticFiles` mount (e.g. `/media/...`). `imageRef` is the resulting URL. Bytes are
fetched from ComfyUI once and stored locally so the studio is the single origin for
asset media (and so the asset survives a ComfyUI restart / output cleanup).

### 5.4 ComfyUI provider seam (testability)

`ComfyProvider` is a `Protocol` (mirroring `LLMProvider`):

- **`FakeComfyProvider`** — returns a tiny placeholder PNG and emits a few
  simulated progress ticks; **no GPU, no network**. Selected for tests/CI.
- **`RealComfyProvider`** — talks to ComfyUI (`POST /prompt`, progress WS,
  `/history`, `/view`).
- **`build_provider(settings)`** — `COMFY_BACKEND=fake|real`.

New settings: `COMFY_BACKEND` (`fake|real`), `COMFYUI_URL`
(default `http://127.0.0.1:8188`), media dir path.

## 6. Frontend plugin

`src/plugins/assets/`, mirroring the `llm-chat` module layout:

```
src/plugins/assets/
  index.ts          IPlugin manifest: pane(s), commands, init()/dispose()
  config.ts         backend base URL (shared default with chat)
  state.ts          IAssetsState, makePluginHooks, selector hooks
  reducers.ts       PURE slice mutations (status, progress, completed, select) — unit-tested
  restClient.ts     fetch wrappers: getGames, getAssets, createAsset, updateAsset, deleteAsset, selectGeneration
  socketClient.ts   module-scoped socket.io singleton; wires asset events -> reducers
  actions.ts        orchestration (initAssets, loadGames, openGame, createAsset, generateAsset, selectGeneration, ...)
  AssetBoardPane.tsx
  AssetCard.tsx
```

- **Own Socket.IO connection.** The assets plugin opens its own module-scoped
  socket to the same server (plugins stay independent; a shared transport is a
  later YAGNI refactor).
- **`AssetBoardPane`** — a **read-only Game selector** at the top (dropdown from
  `GET /games`); selecting a game loads its assets and `join_game`s for live
  events. Hosts the asset grid and a "New asset" affordance.
- **`AssetCard`** — each asset is its **own component subscribed to its own state
  node**, so an `asset_progress` tick re-renders only that card (the repo's
  scoped-subscription / render-count discipline). Shows editable fields (name,
  prompt, width/height, workflow, seed), a **Generate** button, a progress bar
  while generating, the selected generation's image large, and a **candidate
  strip** of prior generations (click to select → `selectGeneration`).
- **`llm-chat`:** no visible change — rooms simply now always carry a `gameId` from
  the backend.
- **Commands / layout:** `Open Asset Board` (command palette + auto-listed View
  menu); add the Asset Board to the default layout so it's visible on boot.
- **Errors** reuse the shell `notify` (sonner) seam — never `sonner` directly.

### 6.1 State slice & event application

`IAssetsState` holds: `games` + `gamesStatus`; `activeGameId`; the active game's
`assets` (flat list); and transient per-asset `status`/`progress` folded into each
asset node. Only the active game's assets are kept (a future multi-game view is
where a `byGame` map would appear). Reducers in `reducers.ts` are pure and
unit-tested; all socket handlers are guarded by `gameId === activeGameId` (stray
events ignored), mirroring chat's `roomId === activeRoomId` guard.

| Event             | Reducer                                                         |
| ----------------- | --------------------------------------------------------------- |
| `asset_status`    | set that asset's `status` (+ board `queueDepth`)                |
| `asset_progress`  | set that asset's `{value,max}` progress                         |
| `asset_completed` | replace the asset (new generation appended + selection applied) |
| `error`           | `notify.error(message)`                                         |

## 7. Configuration & dependencies

- **Backend:** `COMFY_BACKEND`, `COMFYUI_URL`, media dir setting; `StaticFiles`
  mount. ComfyUI HTTP/WS via the existing async HTTP stack (no heavy new dep beyond
  a websocket client if not already present).
- **Frontend:** reuses `socket.io-client`, `sonner`, native `fetch` — no new deps.
- **Config:** `VITE_BLOOM_BACKEND_URL` (shared with chat).

## 8. Testing

Per repo policy: TDD at the unit level; e2e is the authoritative behavioral
contract; browser e2e (Playwright) stays out of CI (cost) and runs locally;
non-browser suites are CI-affordable.

- **Backend unit (pytest, CI):** `GameStore` / `AssetStore` CRUD +
  add/select-generation; wire models; **`graph.py` patching** (prompt/size/seed
  injected into each base workflow; random seed when blank); `AssetHub`
  queue/lock/active-snapshot + resume, driven by `FakeComfyProvider`; room-create
  now also creates a game.
- **Backend non-browser e2e (CI, `COMFY_BACKEND=fake`):** socket flow — `join_game`
  → `generate_asset` → receive `asset_status` / `asset_progress` /
  `asset_completed`; `imageRef` resolves to a served file; **in-flight resume** on
  `join_game` mid-generation.
- **Frontend unit (vitest):** pure reducers; actions against mocked clients;
  `socketClient` event wiring; **render-count discipline** — a progress tick
  re-renders only the one `AssetCard`.
- **Playwright (local-only, `COMFY_BACKEND=fake`):** authoritative flow — create
  room (⇒ game) → open Asset Board → select game → add asset
  (prompt/size/workflow) → Generate → watch progress → see image → Generate again →
  pick a candidate from the strip. **Two browser contexts** in the same game both
  see updates live (proves real-time + resume through the real UI).

## 9. Out of scope (named so no one designs against them)

- **LLM auto-population** of the asset list — the next subsystem; this round is
  manual authoring only.
- **Real GPU in CI** — always `COMFY_BACKEND=fake` there; real ComfyUI is
  local/manual.
- **The Game's other facets** — math, seeds, package (architecture §16 build
  order).
- **Multi-room-per-game UI**, and **renaming/deleting games** or any game
  create/edit from the workspace.
- **`category` as an enforced enum** (stays free-form); asset tagging/reordering
  beyond the single field.
- **Shared frontend socket transport** across plugins (each plugin owns its own
  connection for now).

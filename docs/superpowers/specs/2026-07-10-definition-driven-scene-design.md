# Definition-driven Game Scene + authoritative composed spin

**Date:** 2026-07-10
**Status:** Approved

## Problem

The Game Structure plugin (PR #181) and the Game Scene are two disconnected
worlds:

- Mechanics added in Game Structure persist to the composed definition
  (`game_definitions` via `app/compose`) but nothing renders them in the Game
  Scene. They only reach a player through Build → play-mode (`?package=`).
- The Game Scene's reels come from a separate legacy path: the "Add reels"
  button derives a reels module from the **SlotModel** (`math_store`) and
  writes it into the scene doc (`scene/sockets.py` `scene_add_module`). For
  composed games this duplicates what Game Structure already declares.
- The Game Scene's Spin button is dead on Windows dev: `just backend-serve`
  runs uvicorn `--reload`, whose SelectorEventLoop cannot spawn subprocesses,
  and `SubprocessSpinRunner` shells out to `spin_json` →
  `NotImplementedError`. The compose runner already has a loop-safe wrapper
  (`compose/runner.py` `_LoopSafeComposeRunner`); the spin runner does not.

## Decision summary (user-approved)

1. **The composed definition drives the scene.** Mechanics declared in Game
   Structure are the single source of truth; the scene reflects them
   automatically.
2. **Scene spin is the real game.** Spin plays the authoritative composed
   math via the Rust runtime server and trace playback — the same path as
   play-mode.
3. **Spin reaches the math via the runtime server** (dir-mode over
   `var/packages`), not a new one-shot binary and not a backend-managed child
   process.
4. **Auto-build on save.** Saving the definition triggers a background
   package build so the scene spin always plays the latest definition.

## Design

### 1. Definition → scene module sync (backend)

On `PUT /games/{id}/game-definition`, after persisting, the backend derives
scene modules from `definition.mechanics` — `reels@1` → reels module config,
`meter@1` → meter module — the same mapping `playMode.ts`
`buildComposedPlayDocument` does client-side today. It writes them via the
existing `scene_hub.set_modules`, which broadcasts a `scene_snapshot`; the
engine's ModuleManager already renders both module types.

- Module configs derive from each mechanic's `config` (geometry, symbols),
  not from the SlotModel.
- One writer, server-side: agent-driven definition edits sync identically.
- Games without a composed definition are untouched (no sync, no modules
  removed); their GDD/scene-art flows are unaffected.

*Rejected alternative:* client-side sync (Game Structure pane emitting
`scene_add_module`) — two writers, and non-UI definition edits would bypass
it.

### 2. Remove the scene's "Add reels" button

Mechanics have one source of truth. A game that wants reels in its scene
declares a Reels mechanic in Game Structure. The `scene_add_module` socket
event and its SlotModel-derived config path are removed with the button.
E2e specs that click the old button are rewritten to author via Game
Structure — an explicit behavioral-contract change.

### 3. Auto-build on definition save

The same save handler triggers a debounced background package build through
the existing loop-safe compose runner, writing `var/packages/{game_id}.pkg`
— identical output to the manual Build button, which remains. Build failures
surface through the Game Structure pane's existing build status seam. The
first spin after an edit may briefly wait on a fresh build.

### 4. Composed spin via the runtime server

For a game with a composed definition, `scene_spin` no longer touches
`spin_json`:

- The studio backend makes an async HTTP call (httpx) to the Rust runtime
  server's spin endpoint for package `{game_id}`.
- The runtime server runs in dir-mode (`just runtime-serve-packages`),
  lazy-loading `var/packages` — already supported.
- The authoritative outcome + trace is emitted to the scene room; the client
  plays it back through the same orchestrator/TraceWalker path play-mode
  uses, driving reels **and** meter.
- No subprocess on this path → the Windows `--reload` bug cannot occur.
- Runtime server URL from backend config, default
  `http://localhost:{9000 + BLOOM_PORT_OFFSET}`. `just
  runtime-serve-packages` joins the documented dev stack.
- If the runtime server is unreachable, the scene receives a spin error and
  the pane shows a toast naming the fix (`just runtime-serve-packages`).

### 5. Legacy spin gets the loop-safe wrapper

Games without a definition keep the SlotModel `spin_json` path, but
`SubprocessSpinRunner` gains the same loop-safe treatment as the compose
runner, fixing the `NotImplementedError` for legacy games too.

### 6. Client playback unification

The scene bridge's spin handling is extended to accept the composed
outcome + trace and route it through the orchestrator/TraceWalker (shared
with play-mode) instead of the reels-only `bridge.spin` mapping. One playback
dialect for authoring preview and real play.

## Testing

- **Unit (TDD):** mechanic → module derivation; spin routing (definition
  present → runtime server; absent → legacy subprocess); loop-safe spin
  wrapper; auto-build trigger/debounce.
- **Playwright e2e (authoritative):** add Reels + Meter in Game Structure →
  both render in the Game Scene with no manual step → Spin plays a full
  trace (reels stop on the outcome grid, meter updates). The e2e harness
  starts a dir-mode runtime server alongside the replay backend — it is
  deterministic and offline, so it fits the replay tier. Specs exercising
  the removed "Add reels" button are rewritten.

## Out of scope

- Wallet/balance state in the scene preview (spins are stateless demos).
- Backend-managed runtime-server child process.
- Migrating legacy SlotModel-era games onto composed definitions.

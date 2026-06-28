# Reels module — rendering fixes (design)

Date: 2026-06-28 · Branch: `feat/reels-in-game` (PR #123)

## Context

The reels feature is wired end-to-end correctly. The Game pane's **Add Reels** /
**Spin** buttons drive `scene_add_module` / `scene_spin` over the socket; the
backend persists the module declaration and evaluates spins on the Rust kernel;
the engine projects the declaration into Pixi via the reconciler and persists on
the scene doc. **The data path works — only the rendering is broken.** Three
defects keep the projected grid from being usable, plus one cosmetic question to
put to rest.

All three root causes were confirmed live against the offset-1 replay stack by
driving the standalone engine (which auto-instantiates a default reels module)
through the real studio `init` path and inspecting the model, the console, the
canvas, and screenshots.

## Defects, confirmed root causes, and fixes

### 1. Grid pinned to top-left, top row clipped

**Confirmed.** `REELS_SCHEMA` defaults `originX: 0, originY: 0`
(`runtime/client/src/modules/reels/reelsModule.ts`). `buildDesired` places reel
containers at `(originX + c·span, originY)` and cells at local `(0, r·span)`;
cells are anchored at 0.5 (`PixiRenderer.createObject`). So the top cell's
_center_ sits at the stage corner `(0,0)`, the grid hugs the left edge, and the
top row is clipped. The captured model showed containers at x = `0,108,216,…`
and top cells at `{x:0,y:0}`.

**Fix.** Center the grid by default. The `Root` node carries a `safeArea`
(`{landscape:{width,height}, portrait:{…}}`) reachable from the module via
`host.snapshot()`. When the config does **not** explicitly set `originX`/`originY`,
`project()` computes a centered origin from the landscape safe area (fallback
`1280×720` when absent) and the grid extent:

```
originX = safeW / 2 − (cols − 1) · span / 2
originY = safeH / 2 − (rows − 1) · span / 2      where span = cellSize + spacing
```

This centers the _visible_ `rows × cols` block (buffer rows extend below, as
today). Explicitly-provided origins are honored unchanged. `buildDesired` stays
pure: the centered origin is computed in a small pure helper (unit-testable
directly) and injected into the config `buildDesired` receives. "Unset" is
detected from the raw config (the schema default of 0 is indistinguishable post-
resolution), so the helper runs only when `originX`/`originY` keys are absent.

**Test.** Extend `reelsModule.project.spec.ts`: for a known config + safe area,
assert the projected reel-container and cell positions are centered (no node at
the stage corner; computed origin matches the formula).

### 2. Symbol labels never paint

**Confirmed — exact warning captured:**

```
PixiJS Deprecation Warning: addChild: Only Containers will be allowed to add
children in v8.0.0
    at PixiRenderer.applyLabel (pixiRenderer.ts:152)
```

Root cause: in Pixi v8 a `Sprite` is no longer a `Container`, so
`sprite.addChild(text)` in `applyLabel` is deprecated and the label does not
render — cells paint as blank colored rectangles. A secondary hazard compounds
it: the cell `Sprite` is a `Texture.WHITE` scaled to `size` via `setSize`, so any
child it parented would inherit that large scale.

**Fix.** Render the label through a real `Container`, never `Sprite.addChild`, and
keep it clear of the background's `setSize` scale. Recommended direction
(implementer confirms the exact structure via TDD):

- **Promote the cell to a `Container`** that holds a background `Sprite`
  (`Texture.WHITE` tinted by `fill`, sized via `size`) and the label `Text`, both
  anchored 0.5. The cell Container receives `position`/`zIndex`/blur (so
  `renderReel` and `setBlur` keep working — Containers expose `position` and
  `filters`); `fill`/`size` delegate to the background child; `label` adds a
  `Text` to the Container (legal in v8, no warning, no inherited scale).

**Model contract to preserve.** The cell node `reels:cell:c:r` MUST keep carrying
`fill`, `size`, and `label` props in the document — `reels.spec.ts` and
`reelsModule.project.spec.ts` read them. Whatever the renderer's internal
structure, the declared model props stay as they are today.

**Test.** `pixiRenderer.spec.ts` (or a focused sibling): applying a `label`
produces a visible `Text` with a sane (non-inflated) transform and emits **no**
deprecation warning. Assert via the renderer's object/label maps and the absence
of the `addChild` warning.

### 3. Live "Add Reels" shows nothing until refresh

**Confirmed — and the mechanism differs from the original hypothesis.** The brief
guessed a _click-before-engine-ready race_. That is ruled out: `ProtocolBridge`
already queues inbound messages until the engine's `ready` and flushes them
(`protocolBridge.ts`), and the engine serializes `init` handling (init awaits
`renderer.mount()` before module projection). No op is dropped pre-ready.

The real cause, reproduced deterministically (init#1 → **1** `<canvas>`; init#2 →
**2** canvases; composited result **blank**, while the projected cell reports
`onStage: true`):

> Live **Add Reels** → backend persists the module decl → `scene_snapshot` →
> `socketClient` calls `bridge.init(newDoc)` — a **second `init`**. `GraphModel.load()`
> **clears and rebuilds** the model, re-creating `Root` →
> `Reconciler.created(Root)` → **`PixiRenderer.mount()` runs again, and it is not
> idempotent**: it constructs a fresh `Application` and `appendChild`s a **second**
> `<canvas>`. The new cells project onto the new app; the stale (empty) first
> canvas stays in the DOM, so nothing presents correctly. A page refresh collapses
> back to a single clean `init`, which is why refresh "fixes" it.

(The same non-idempotency means a normal first load can mount twice — the
GamePreviewPane `ready` handler and the `scene_snapshot` handler both call
`bridge.init`.)

**Fix.** Make re-init idempotent at the renderer. When `mount()` is called and the
app already exists, **reuse the existing `Application`/canvas** and reset the
scene to a clean slate — clear the stage's children, clear the `objects` and
`labels` maps, and re-map the root id to the existing stage — instead of creating
a second app. A subsequent `load`/projection then rebuilds the scene on the one
canvas, matching post-refresh behavior without the refresh. This supersedes the
brief's "pending-ops queue / reproject-on-ready" idea, which targets a race that
is not the cause.

**Test.**

- Unit (`pixiRenderer` / reconciler): a second `mount()` keeps exactly one canvas
  and leaks no display objects; the root id maps to the live stage.
- E2e (`reels.spec.ts`, offset 1): after **Add Reels**, the grid is rendered with
  **exactly one** `#stage canvas`, and a cell is on the live app — i.e. assert the
  **rendered** end-state, not just `__engineModel`/`state()`. The current e2e
  passes blind because it only inspects the model; the new assertion closes that
  gap (per the repo's "assert end-state, not dispatch" rule).

### Cosmetic: faint dark-red wash — not a real artifact

Investigated and dismissed. The scene graph contains no red/extra node (only the
tinted cells, their reel containers, and root), and all blur filters are removed
at idle. The single-init screenshot showed a faint tint where bright cells were;
the two-init screenshot (no visible cells) was uniform `#0b0b0c`. The wash is
bloom from the saturated cell colors against the near-black background, not an
element. No fix; recorded so it is not chased later.

## Scope / non-goals

- No change to the socket protocol, backend, or kernel — the data path is correct.
- No redesign of the module/host seam beyond what the three fixes require.
- The reels spin/settle animation logic (`reelsMath`, `update`) is unchanged
  except where the cell becomes a Container (handles still resolve to a node with
  `position`/`filters`).

## Testing strategy (TDD, e2e is the contract)

Failing-test-first for each fix. Unit specs (vitest, `runtime/client`):
`reelsModule.project.spec.ts` (centering), `pixiRenderer.spec.ts` (label paints,
idempotent mount). Behavioral contract: `studio/frontend/e2e/reels.spec.ts`
(offset 1) extended to lock in **centered layout**, **visible labels**, and
**race-free live add (one canvas, rendered grid)**. Browser e2e runs locally only
(never CI), against the replay backend.

## Verification before merge

Bring up the offset-1 replay stack from the worktree and exercise **Add Reels →
Spin** at `http://localhost:4201` (and LAN `http://192.168.1.240:4201`): centered
grid, painted A/B/C labels, grid appears immediately on Add Reels (no refresh),
spin settles on the server outcome. Then gates green — `cargo fmt --check`, pinned
`node_modules/.bin/prettier --check`, `nx typecheck/test/build`, backend `pytest`
— rebase on `main` (PR #125 merged after #123's CI ran, so re-run CI), and merge
via `/bloom:complete-work`.

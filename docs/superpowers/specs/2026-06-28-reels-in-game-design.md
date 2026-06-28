# Reels in the Game — declarative module + server-driven outcome

**Status:** approved design (brainstorming) — 2026-06-28
**Branch:** `feat/reels-in-game`
**Builds on:** PR #103 (`feat(modules): game modules + reels slice (two-plane architecture)`)
and the design `docs/superpowers/specs/2026-06-25-game-modules-design.md`.

## 1. Problem & goal

PR #103 shipped a complete **client-side reels module** (`runtime/client/src/modules/reels/`)
with the two-plane architecture — a structure plane (`project()` emits scene nodes) and a
behavior plane (spin/settle animation over a per-frame tick) — plus a `spin` protocol message
and an `Orchestrator` that sequences a round. It is fully built but **islanded**: nothing in the
studio attaches it to a game, nothing triggers the initial projection (so the grid is invisible),
the studio's `ProtocolBridge` has no `spin()` method, and the round outcome is a hand-written
client fixture rather than a real server result.

This slice closes those gaps so that, for a real game opened in the studio, a developer can:

1. **Add a reels module to the game** (a real, persisted, per-game thing).
2. **See it immediately** as a grid of color-coded, labeled rectangles.
3. **Spin** and watch the reels settle onto an outcome **computed by the server** from the game's
   `SlotModel` via the trusted math kernel.

Non-goals (deliberately deferred — see §8): real symbol art, an in-game HTML/Preact UI overlay,
persisting the last landed grid across reloads, multi-module orchestration, payout/win display.

## 2. Key decisions (resolved in brainstorming)

| #   | Decision                           | Choice                                                                        |
| --- | ---------------------------------- | ----------------------------------------------------------------------------- |
| 1   | How reels attach to a game         | **Declarative** — a `modules` declaration on the scene document               |
| 2   | Where the round outcome comes from | **Trusted math kernel** — single-round `evaluate()` of the game's `SlotModel` |
| 3   | How cells render                   | **Color-coded per symbol + label** (legible outcome)                          |
| 4   | Spin trigger & motion              | **Spin button** + keep the existing #103 settle animation                     |
| 5   | Button placement                   | **Studio Game pane** (defer the in-game Preact overlay)                       |

## 3. The architectural pivot: declaration persists, cells are derived

PR #103 placed **both** planes inside the runtime reels module. But in the studio the canonical
scene document lives **server-side** and flows backend → studio → runtime **one-way**; the runtime
is a view. Having the runtime author-and-persist its own cell nodes upstream would invert that flow.

**Resolution:** the **`modules` declaration is the persisted source of truth; the reel cells are a
deterministic, client-side projection of it.**

- The backend stores `modules: [{ id, type: 'reels', config }]` on the scene document. It persists
  and broadcasts like any other scene state.
- On `init`, the runtime reads `document.modules`, instantiates each module from the registry, and
  **projects its cells locally** (idempotent reconcile). The derived cell nodes are **not** round-tripped
  back to the backend.

This honors the spec's "re-project deterministically from config" idea and avoids a runtime→backend
op direction. **Tradeoff:** the scene-graph inspector (which reads the canonical doc) will not list
reel cells — they are derived/transient. Acceptable for this slice; noted as a follow-up (§8).

## 4. Components & data flow

### 4.1 Add reels (declarative)

```
[Game pane "Add Reels"] --socket scene_add_module {gameId, type:'reels'}--> [backend]
  backend: load game SlotModel (or built-in demo model if none realized)
           derive default config: cols = #reels, rows = model.rows,
                                  symbols = model symbol ids as strings
           write modules:[{id:'reels', type:'reels', config}] onto the scene doc
           persist + broadcast scene_snapshot
  studio: applyInbound('scene_snapshot') -> bridge.init(doc)
  runtime: init reads document.modules -> ModuleManager instantiates 'reels'
           -> project() locally -> renders the colored rectangle grid
```

The grid appears **immediately** on add. If the game has no realized `SlotModel`, the backend falls
back to a **built-in demo slots model** so the feature is demoable before a GDD→realize/tune cycle.

### 4.2 Render as rectangles

The renderer is extended so a `Sprite` carrying `fill` / `size` / `label` props draws a solid
**`Texture.WHITE`-tinted** rectangle (no asset load) with a centered text label:

- `fill` (hex color string) → `sprite.texture = Texture.WHITE; sprite.tint = parse(fill)`
- `size` (`{ width, height }`) → sets the sprite's width/height
- `label` (string) → a centered child `Text` (created/updated on change)

The reels module's pure `buildDesired` sets per cell: `fill = colorForSymbol(sym)`,
`size = { width: cellSize, height: cellSize }`, `label = sym`. `colorForSymbol` is a pure,
deterministic string→color function (module-local, unit-tested). Color + label make the landed
outcome legible.

### 4.3 Spin (server-driven)

```
[Game pane "Spin"] --socket scene_spin {gameId}--> [backend]
  backend: load game SlotModel (or demo model)
           pick a random seed
           invoke single-round Rust binary `spin_json` (studio/simulator) -> base_grid (numeric ids)
           map symbol ids -> declaration symbol strings (grid[reel][row] == grid[col][row])
           emit scene_spin_outcome {gameId, outcome:{grid}}
  studio: socketClient handles scene_spin_outcome -> bridge.spin(outcome)
  runtime: Orchestrator.spin(outcome) -> project (idempotent) -> startSpinning -> stopSpinning(outcome)
           -> the existing #103 settle animation lands the cells on the server's grid
```

`spin_json` is a thin, deterministic wrapper over the trusted kernel's `evaluate()` — it takes
`model.json` + `seed`, emits `{ grid, basePayout, totalPayout }` as JSON. Grid orientation matches:
the kernel returns `grid[reel][row]`; the reels module consumes `grid[col][row]` with `col == reel`.

### 4.4 Engine refactor — ModuleManager

`createEngine` currently hard-wires a single `ReelsModule` with default config. Replace that with a
**ModuleManager** that, on `init`, reads the document's `modules`, instantiates each via the existing
`ModuleRegistry`, projects + mounts them, and wires the `Orchestrator` to route a `spin` to the reels
module. For this slice, 0 or 1 reels module per game is supported.

## 5. Symbol mapping & color

- **Kernel → wire:** kernel symbols are numeric ids (`Symbol`). The backend maps each id to its
  string form (e.g. `"0".."4"`), matching the declaration's `symbols` array.
- **Wire → color:** `colorForSymbol(symbolString)` (client, pure) deterministically maps a symbol
  string to a stable fill color.
- **Consistency:** the declaration's `cols`/`rows`/`symbols` are derived from the same `SlotModel`
  the spin evaluates, so the outcome grid fills the declared grid. (Re-deriving the declaration when
  the model later changes is a follow-up — §8.)

## 6. Files touched (sketch)

- **Rust:** `studio/simulator/src/bin/spin_json.rs` (new) — single-round `evaluate()` → JSON.
- **Backend:** scene document model + store/hub gain a `modules` field; `app/scene/sockets.py` gains
  `scene_add_module` and `scene_spin` handlers; symbol-id→string mapping; built-in demo-model fallback;
  invoke `spin_json` (subprocess, mirrors the curate runner pattern).
- **Runtime:** `engine.ts` → ModuleManager (declaration-driven); renderer rectangle + label support
  (`pixiRenderer.ts`, `renderer.ts`, mock renderer); reels `buildDesired` emits `fill`/`size`/`label`;
  pure `colorForSymbol`. (`protocol/messages.ts` already carries the `spin` message.)
- **Studio FE:** `protocolBridge.ts` gains `spin` (message union + method); `game/socketClient.ts`
  handles `scene_spin_outcome` and emits `scene_add_module` / `scene_spin`; Game pane gets
  "Add Reels" + "Spin" buttons.
- **Scene types:** `runtime/client/src/model/document.ts` `IGameDocument` and
  `studio/frontend/src/scene/types.ts` `ISceneDocument` gain an optional `modules` field
  (kept in lockstep, per the existing "structural copy" note).

## 7. Testing (TDD + authoritative e2e)

Per `AGENTS.md`: TDD is mandatory; Playwright e2e is the authoritative behavioral contract (run
locally, not CI); cheaper unit + non-browser e2e run in CI.

- **Unit (vitest):** `colorForSymbol`; rectangle/label rendering; declaration-driven projection;
  ModuleManager instantiation + spin routing; `bridge.spin` (queues before ready, posts after);
  `socketClient` `scene_spin_outcome` → `bridge.spin`.
- **Unit (Rust):** `spin_json` golden grid for a pinned `(model, seed)`.
- **Backend (pytest, non-browser e2e):** `scene_add_module` writes the declaration + broadcasts;
  `scene_spin` → kernel → outcome with the expected shape and symbol mapping; demo-model fallback.
- **e2e (Playwright, authoritative):** open a game → **Add Reels** → assert a grid of **color-coded**
  rectangles renders (distinct fills, correct rows×cols) → click **Spin** → assert the **rendered
  landed grid equals the server's outcome** — the observable end-state, not merely that a spin was
  dispatched (per the inspector-roundtrip lesson: assert end-state, not dispatch). Runs against the
  replay backend on the worktree's offset ports.

## 8. Explicitly deferred

- In-game HTML/Preact UI overlay (relocating the Spin trigger into the game canvas) — its own slice,
  including the new runtime→backend spin-request path.
- Persisting the last landed grid across reloads (today reload reprojects to default symbols).
- Re-deriving the reels declaration when the game's `SlotModel` changes.
- Listing derived reel cells in the scene-graph inspector.
- Real symbol textures; payout/win presentation; multi-module orchestration.

# Game Modules — Reusable, Config-Driven Game Behaviors (Reels Slice) Design

- **Date:** 2026-06-25
- **Status:** Approved (design); next step is an implementation plan
- **Component:** `runtime/client/` (engine) — new import-isolated areas `modules/`,
  `orchestration/`, `modules/reels/`
- **Worktree / branch:** `C:\code\bloom.wt\game-modules` on `feat/game-modules`
- **Consumes:** the Plan 1 contract (`runtime/client/src/model/ops.ts`,
  `.../model/document.ts`, `.../model/graphModel.ts`, `.../render/reconciler.ts`,
  `.../render/renderer.ts`) and the engine assembly seam (`.../engine.ts`, `.../main.ts`)
- **Related:** [`2026-06-23-client-engine-design.md`](2026-06-23-client-engine-design.md)
  (Plan 1 core: ops/document/reconciler),
  [`2026-06-24-client-engine-studio-integration-design.md`](2026-06-24-client-engine-studio-integration-design.md)
  (Plan 2: studio iframe + live scene graph),
  [`2026-06-24-client-engine-real-asset-rendering-design.md`](2026-06-24-client-engine-real-asset-rendering-design.md)
  (Plan 3: real assets render via `resolveTextureSrc`)

---

## 1. Essence

The engine today renders a **static** scene graph: ops add/connect/prop nodes
(`Root` / `Container` / `Sprite` / `Texture`), the reconciler mirrors them onto Pixi
display objects, and a `Sprite` can show a real Asset Board image (Plan 3). What it has
**no concept of** is a reusable, configurable _game behavior_ — a "reels" component that
both **lays out its own structure** (reel containers, symbol sprites) and **animates over
time** (spin momentum, blur, settle). Every scene is hand-authored node-by-node.

This slice introduces the **game module**: reusable code, identified by `type`, that owns a
slice of a game both as **persisted structure** and as **transient runtime behavior** — and
ships the **first concrete module, `reels`**, end to end in the runtime client.

The central architectural move — the thing that makes "creates editable, persisted nodes"
and "has live per-frame motion" coexist without contradiction — is a **two-plane split**
(§2). Everything else (the `IGameModule` contract §3, the reels module §4, the orchestrator
§5) hangs off that split.

This is a **client vertical slice (option A).** Server-side module parity and live-runtime
`outcome` wiring are explicitly **deferred-B** (§7) — captured as todos, not built here.

---

## 2. The decision that shapes this design — two planes

A module's responsibilities split across two planes with different persistence and timing
semantics:

### 2.1 Persistent structure plane — config-driven, via ops

When a module projects its structure (reel containers, symbol sprites), it does so by
**emitting normal scene ops** (`addNode` / `connect` / `setProp`) against the existing
`GraphModel`. Consequences, all of them free because they reuse the Plan 1 contract:

- the nodes are **persisted, inspectable, editable, and synced** exactly like hand-authored
  nodes (same `document.ts` shape, same reconciler, same future studio sync);
- **module config is the source of truth.** Re-projecting after a config change
  **reconciles** the existing nodes (idempotent — update/add/remove), it does not duplicate.

### 2.2 Transient behavior plane — per-frame, direct

Runtime motion and state — `startSpinning()` momentum, motion blur, settle easing — is
driven by a **per-frame tick against the live Pixi display objects**, _not_ persisted as
ops. You do not want 60 ops/sec flooding the model, the sync channel, or the inspector. This
plane is **ephemeral**: it mutates display objects directly and leaves no trace in the
document.

### 2.3 The seam between the planes

The behavior plane needs to reach the **live display objects** for the node ids the
structure plane created. So the contract exposes a **handle resolver**: given the ids a
module projected, the module can obtain the live Pixi objects to mutate per frame. This is
the single bridge between "ids in the document" and "objects on screen," and it is the one
genuinely new capability the engine must expose to modules (see §6).

```
structure plane:  config ──project()──▶ ops ──▶ GraphModel ──reconciler──▶ Pixi objects
                  (persisted, idempotent, inspectable)                          │
                                                                                ▼  (resolve handles by id)
behavior plane:   update(dt) ───────────────────────── direct mutation ──▶ Pixi objects
                  (transient, 60fps, no ops)
```

**Why this split is forced, not merely tidy:** the two requirements are individually cheap
but jointly contradictory under a single mechanism. "Persisted + editable + synced" demands
ops (that _is_ the document). "60fps motion" forbids ops (flooding). The only reconciliation
is to route each requirement to the plane that satisfies it — structure → ops, behavior →
direct — and define the id-handle seam that lets one module own both.

**Rejected alternatives:**

- **All-ops** (animate by emitting `setProp` every frame) — drowns the model/sync/inspector;
  a non-starter at 60fps.
- **All-direct** (module builds Pixi objects itself, no ops) — its structure is then
  invisible to the document: not persisted, not inspectable, not editable, not synced. Throws
  away every Plan 1 benefit.

### 2.4 Where it lives

New, **import-isolated** areas under `runtime/client/src/`:

- `modules/` — the `IGameModule` contract, the registry, shared module utilities.
- `modules/reels/` — the first concrete module.
- `orchestration/` — the orchestrator + event bus.

Structured so they can later be extracted into separate tree-shakeable libraries, but
**kept in-client for this slice** ("extract to libs" is a §7 follow-up, not built up front).

---

## 3. The module contract — `IGameModule`

Every module is reusable code implementing a common, `I`-prefixed contract (per
`docs/coding-standards.md`). A module declares:

- **`id` / `type`** — stable identity (e.g. `type: "reels"`). `type` is the unit shared with
  the future server module for parity; `id` is this instance.
- **`configSchema`** — a **typed schema** of its config fields (types, ranges, defaults, and
  which fields are **node-bindings**). This drives **property-inspector rendering +
  validation**. Config is the source of truth.
- **`project(config)`** — emits scene ops to **create/reconcile** its structure from config.
  **Idempotent**: projecting twice yields the same node set; a config change yields the
  minimal add/update/remove.
- **Lifecycle** — `mount()` / `update(dt)` (per-frame) / `dispose()`.
- **Behavior API** — module-specific verbs, with parity-minded common ones where sensible.
  For reels: `startSpinning()` / `stopSpinning(outcome)`.
- **Events** — emits/subscribes **via the bus only**. Modules never hold references to each
  other.

A small **module registry** maps `type → IGameModule` factory, so a game is "instantiate
these modules by `type`, give each its config." This registry is the surface a future server
tier **mirrors for parity**.

`configSchema` as the property-inspector bridge and `project()` going through scene ops are
the two load-bearing choices here — they are what keep module structure **first-class in the
document** rather than a private side-world.

---

## 4. The reels module, concretely

### 4.1 `reels` structure — `project(config)`

Config (illustrative): `{ rows, cols, symbols[], reelStripIds[], cellSize, spacing, anchor }`.
`project()` emits ops to build/reconcile:

- one **`Container`** node per reel (`cols` of them), each holding `rows + buffer`
  **`Sprite`** symbol nodes (buffer rows enable off-screen scroll/recycle);
- nodes carry **stable ids derived from `reelId:cellIndex`**, so re-projecting after a config
  change **reconciles** (update/add/remove) rather than duplicating;
- **node bindings** (which config field maps to which node prop) come from `configSchema`, so
  the property inspector edits config → re-`project()` → scene updates. One source of truth.

The emitted nodes are ordinary `Container` / `Sprite` / `Texture` nodes — no new node types
— so the reconciler, the inspector, and future sync handle them unchanged.

### 4.2 `reels` behavior — `update(dt)` + verbs

- **`startSpinning()`** — flips reels into a transient spinning state; the per-frame tick
  advances strip offset, applies motion blur, and **recycles symbol sprites** as they scroll
  off (reusing the buffer rows). **No ops emitted** — pure display-object mutation via the
  §2.3 handle seam.
- **`stopSpinning(outcome)`** — eases each reel to the `outcome`-defined symbol stops
  (**staggered per reel**), settles, then emits a single **`reels:settled`** event carrying
  the landed grid.

The **pure** parts — strip-offset math, stop-position resolution from `outcome`,
sprite-recycle index math — are separable from the Pixi mutation and are where unit tests
land (§6).

---

## 5. Orchestration & event flow

### 5.1 Division of responsibility

- The **orchestrator** owns **round sequencing**. It knows "a spin was requested," hands the
  module the `outcome` (from the math/runtime tier), and drives whatever's next when a module
  reports done.
- **Modules talk only through the bus.** The orchestrator subscribes to `reels:settled` and
  drives the next step (win-line eval, anticipation — future modules). No module references
  another module.

This central-orchestrator division (vs. modules chaining reactively off each other's events)
was chosen so round sequencing lives in **one inspectable place** and modules stay
**independently reusable** — a module knows its own verbs and events, not the game's flow.

### 5.2 One spin round

```
host/orchestrator          bus                 reels module
      │  spin(outcome) ─────────────────────────▶ startSpinning()
      │                                            (tick: scroll + blur)
      │                                            stopSpinning(outcome)
      │                                            (tick: ease + settle)
      │  ◀───────────── reels:settled {grid} ──────┤
      │  (win-eval / next module reacts)
```

### 5.3 The `outcome` seam

`outcome` is the seam to the math engine. For this client slice it is a **fixture/stub**
(deterministic, hand-authored). Wiring it to the **live runtime** (real `outcome` from the
math/runtime tier) is **deferred-B** (§7).

---

## 6. Engine touch-points & testing strategy

### 6.1 What the engine must newly expose

The only genuinely new engine capability is the **§2.3 handle seam**: a way for a module to
resolve the **live display objects** for node ids it projected, so the behavior plane can
mutate them per frame, plus a **per-frame tick** hook to call `update(dt)` on mounted
modules. Everything else (ops, reconciler, document) is reused as-is. The exact shape (a
resolver exposed off the renderer/reconciler vs. a thin module-host facade) is settled in the
plan; the **constraint** is that modules depend on a narrow handle/tick interface, not on
Pixi internals or the reconciler's guts.

### 6.2 Testing

Per repo policy: **TDD mandatory**; **e2e is the authoritative behavioral contract**; browser
e2e runs locally only; unit tests are CI-affordable.

**Unit (TDD, RED→GREEN→REFACTOR) — vitest, CI:**

- `project(config)` **idempotency** — projecting twice yields the same node set (reconcile,
  not duplicate); a config change produces the correct add/update/remove.
- `configSchema` **validation** — bad ranges/types rejected; defaults applied.
- **Registry** — `type → IGameModule` factory resolution.
- **Pure behavior** — strip-offset math, stop-position resolution from `outcome`,
  sprite-recycle index math (the per-frame Pixi mutation itself is covered by e2e, not unit).

**E2e (Playwright, authoritative) — local:**

- A real spin round in the runtime client: trigger spin → reels **visibly spin** → settle to
  the fixture `outcome`'s grid → `reels:settled` observed.
- Nodes from `project()` **show up in the scene graph / inspector and are editable**: a config
  edit → re-project → visible structural change.
- Runs against the **replay backend** (`just e2e`), per repo policy.

### 6.3 Non-interference (other worktrees)

- This slice is client-only; it uses the engine port (`VITE_BLOOM_ENGINE_PORT`, default
  `4300`) — env-overridable, no hard singleton. The worktree's `BLOOM_PORT_OFFSET` shifts it.
- No GPU/ComfyUI, no live providers — the `outcome` is a fixture; e2e runs under replay.

---

## 7. Scope boundary

**In this iteration (client vertical slice, option A):**

- `IGameModule` contract + the `type → factory` registry (`runtime/client/src/modules/`).
- The two-plane mechanism: `project()` → ops (structure) and the per-frame tick + handle seam
  (behavior).
- The **`reels`** module concretely (`modules/reels/`) — structure projection + spin/settle
  behavior with a fixture `outcome`.
- The **orchestrator + event bus** (`orchestration/`) for one spin round.
- Unit + e2e coverage per §6.2.

**Labeled, not built (deferred-B):**

- **Server-side module mirror for parity** — same `type` / registry on the server tier.
- **Live `outcome` wiring** from the math/runtime tier, replacing the fixture stub.
- **Extracting `modules/` → tree-shakeable libraries** (built in-client first).
- **Additional modules** (win-lines, anticipation) — the orchestrator/bus is built to accept
  them, but they are out of scope here.

---

## 8. Open / deferred decisions

- Exact shape of the §6.1 handle/tick interface (resolver-off-renderer vs. module-host
  facade) — finalised in the plan; the constraint (narrow interface, no Pixi-internals
  dependency) is fixed.
- Whether `configSchema` reuses an existing schema/validation utility in the repo or defines a
  module-local typed-schema shape — settled when the plan surveys what the property inspector
  already consumes (prefer reuse behind a thin seam).
- Bus implementation (tiny in-house emitter vs. an existing dependency) — prefer a proven,
  minimal library behind a swappable seam if one already ships; otherwise a small typed
  emitter.

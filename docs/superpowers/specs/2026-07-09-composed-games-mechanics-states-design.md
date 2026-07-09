# Composed Games: Mechanics + Game States — Design

**Date:** 2026-07-09
**Status:** Approved design, pre-implementation
**Scope:** New kernel family `composed@1`, package/server dispatch, client trace
walking, studio authoring — decomposed into four sub-projects (§9).

## 1. Problem

Bloom can ship exactly one shape of game: a flat `slots@1` `SlotModel` whose
single bonus feature (free spins) is a closed enum variant. Every richer slot —
multiple free-spins variants, bonus meters, towers, feature interplay — would
today be "a new enum variant + a match arm + a schema bump" with no reuse
between games, no studio surface for adding features, and no shared vocabulary
between the server math and the client presentation.

We want **Mechanics** (reusable, configurable game features: reels, bonus
meter, bonus tower, …) and **Game States** (root-level orchestrators: Base
Game, Free Spins 1, Free Spins 2, …) as first-class concepts that are:

- authored and configured in Bloom Studio,
- present in **both** the math kernel and the client engine with matching APIs,
- composed by data, not by code, so a new game is a new Game Definition — not a
  new codebase.

## 2. Concept model

Four layers, each orchestrating the one below:

| Layer          | Orchestrates                       | First-class / registered?                           |
| -------------- | ---------------------------------- | --------------------------------------------------- |
| **Game**       | Game States (via transition table) | yes — the Game Definition                           |
| **Game State** | Mechanics (via step script)        | yes — studio-visible                                |
| **Mechanic**   | low-level components               | yes — versioned catalog, studio-visible             |
| **Component**  | —                                  | **no** — plain shared code (Rust helpers, TS utils) |

Decisions locked during brainstorming:

1. **Game States are games-within-games.** Base, FS1, FS2 are effectively
   independent math units (own strips, own overrides) that compose into one
   rich game.
2. **V1 rounds fully resolve at spin time.** One seed → the whole journey
   across all states, computed in one deterministic pass. The lifecycle is
   modeled as **resumable steps** so a future interactive state (pick-a-bonus,
   gamble) pauses the walk instead of forcing a rearchitecture. V1 never
   pauses.
3. **Mechanics are real composable units inside the kernel** — a deliberate
   amendment to the trusted layer's "no framework" doctrine (§4, doctrine box).
4. **Mechanic state is explicit**: `(config, state_in, seed) → (events,
state_out)`. Round-scoped in v1; the in/out shape is the seam for future
   cross-round persistence (which would also change RTP math — explicitly out
   of scope).
5. **Mechanic instances are declared at game level** (`"main_reels"`,
   `"bonus_meter"`); Game States _bind_ instances with per-binding config
   overrides. Instance state (meter fill) flows across states within a round.
   States do not own mechanics.
6. **Transitions are a game-level declarative table** `(state, event) → next
state`. Cycles and self-loops are allowed; a global step cap is the backstop
   (generalizing `MAX_FREE_SPINS`).
7. **Client/server parity is a data contract, not a convention**: one
   serialized **Game Definition** both runtimes load, and the round outcome is
   an ordered **lifecycle trace** the server emits and the client walks.
   Parity is testable: same definition + seed → same trace.
8. **Triggers are named public functions on a mechanic.** A state's step
   script is an ordered list of trigger invocations. The same trigger
   vocabulary exists on both sides: the kernel executes a trigger as math; the
   client executes it as animation.
9. **`slots@1` is untouched.** `composed@1` is a new family beside it; existing
   games, tuner, simulator, analytics keep working. Tooling convergence is a
   filed follow-up todo.

## 3. The Game Definition (shared artifact #1)

One serialized document — persisted per game by the studio, carried as the
`.pkg` math payload, loaded by both the kernel and the client:

```jsonc
{
  "family": "composed@1",
  "mechanics": [
    // game-level instances: id + type@version + base config + initial state
    { "id": "main_reels", "type": "reels@1",
      "config": { "strips": [...], "rows": 3, "paylines": [...], "paytable": [...] } },
    { "id": "bonus_meter", "type": "meter@1",
      "config": { "target": 10, "source_event": "scatter_landed" } }
  ],
  "states": [
    {
      "id": "base",
      "bindings": [
        { "mechanic": "main_reels" },            // no override
        { "mechanic": "bonus_meter" }
      ],
      "steps": { "budget": 1 },                   // base game: one spin
      "script": [                                 // ordered trigger invocations per step
        { "invoke": "main_reels.spin" },
        { "invoke": "bonus_meter.accumulate" }
      ]
    },
    {
      "id": "fs1",
      "bindings": [
        { "mechanic": "main_reels",
          "override": { "strips": [ /* feature strips */ ] } },
        { "mechanic": "bonus_meter" }
      ],
      "steps": { "budget": "awarded", "initial": 8 },  // events may add steps (retrigger)
      "script": [
        { "invoke": "main_reels.spin" },
        { "invoke": "bonus_meter.accumulate" }
      ]
    },
    { "id": "fs2", "comment": "same shape as fs1; different overrides/budget" }
  ],
  "start": "base",
  "transitions": [
    { "from": "base", "on": "scatters:3",  "to": "fs1" },
    { "from": "base", "on": "meter:full",  "to": "fs2" },
    { "from": "fs1",  "on": "scatters:3",  "effect": "steps:add:8" },  // retrigger: effect only, no state change
    { "from": "fs1",  "on": "steps:exhausted", "to": "base" },
    { "from": "fs2",  "on": "steps:exhausted", "to": "base" }
  ],
  "caps": { "max_steps": 1000 }
}
```

Shape notes (normative):

- `type@version` keys the mechanic catalog on **both** sides.
- A binding override is a partial config deep-merged over the instance's base
  config; the merged result must still validate against the mechanic's config
  schema.
- `steps.budget` is either a literal count or `"awarded"` (event-adjustable).
  `steps:exhausted` is a built-in event emitted by the state loop itself.
- A transition may carry an `effect` instead of (or before) a `to` — v1
  effects: `steps:add:<n>`. This is how retriggers work without a state change.
- The round ends when a transition returns to a state with no remaining budget
  and no pending transitions — concretely: when `base` completes its budget
  and no transition fires, or `caps.max_steps` is hit (round is still valid;
  the cap just stops the loop, as `MAX_FREE_SPINS` does today).
- Validation (studio-side and kernel-side at load): unknown mechanic types,
  bindings referencing undeclared instances, transitions referencing unknown
  states, unreachable states, missing `start`, script invoking unbound
  mechanics or unknown triggers — all hard errors before any evaluation.

## 4. Kernel — `trusted/math`, new family `composed@1`

> **Doctrine amendment (recorded here, normative):** the trusted layer's
> "additive enum, no framework" rule is amended for `composed@1`: composition
> _is_ the framework inside this family. Append-only now applies **per
> mechanic type version** — `reels@1` behavior is frozen once shipped; any
> behavior change is `reels@2`. The family schema itself (`composed@1`) is
> frozen the same way. `slots@1` is not modified.

New module `mechanics/composed/` beside `mechanics/slots/`:

- **Mechanic trait** (names indicative):

  ```rust
  trait Mechanic {
      fn invoke(&self, trigger: &str, config: &Value, state_in: &Value,
                ctx: &mut StepCtx, rng: &mut Rng) -> InvokeResult;
  }
  // InvokeResult { events: Vec<Event>, state_out: Value, trace: TraceEntry }
  ```

  `StepCtx` is the shared step context (current grid, win events so far,
  accumulated payout) that later triggers in the same step read.

- **Static registry**: a `match` on `type@version` → constructor. No dynamic
  loading; adding a mechanic type is a code change + catalog entry.
- **Evaluator**: walk states from `start`. Per step: invoke the state's script
  in declared order against the **single round PRNG** — draw order equals
  trigger order, so determinism holds by construction. After each step,
  consult the transition table against emitted events (first matching row
  wins; row order in the definition is normative). Stop when the round-end
  condition (§3) or `caps.max_steps` is reached.
- **Output**: the lifecycle trace (§6) plus a summary compatible with what the
  server needs today (`total_payout`, per-state payouts).
- **V1 mechanic types**:
  - `reels@1` — strips → grid via PRNG, payline + scatter evaluation → win
    events (`win:{line,symbol,count,payout}`, `scatter_landed`, `scatters:N`).
    Implementation extracts the spin/eval internals of `slots@1` into shared
    component code (plain functions) that both families call — `slots@1`'s
    behavior and payloads are not modified.
  - `meter@1` — accumulates on a configured source event, carries fill in its
    instance state, emits `meter:full` (and resets, per config).
- **Free spins is not a mechanic.** It is a Game State with an `"awarded"`
  step budget; retrigger is a transition effect adding steps.
- **RNG**: single stream per round, as today. Per-mechanic split streams
  (config-order-insensitive draws) are noted as a possible future `composed@2`
  change, not v1.

## 5. Package & runtime server

- Envelope `mechanic: "composed@1"`; `math_payload` = the Game Definition
  (postcard, same pipeline as today).
- `bloom-runtime-server` currently hard-calls `slots::evaluate`; it gains a
  dispatch on the envelope family string. `/handshake` and `/health` are
  unchanged in shape.
- `/spin` for a composed package returns the **trace** on the wire (u64 values
  string-encoded — the SP2 lesson). The existing `RoundOutcome`-shaped summary
  fields remain so generic consumers (audit dashboards) keep working.
- Audit appends `seed + definition hash + total_payout` per round; replaying
  `evaluate(definition, seed)` reproduces the trace bit-for-bit.

## 6. Lifecycle trace (shared artifact #2)

The round outcome is an ordered list of entries:

```jsonc
[
  { "t": "round_start", "seed": "1234...", "bet": 100 },
  { "t": "state_enter", "state": "base" },
  { "t": "step", "n": 1 },
  { "t": "trigger", "mechanic": "main_reels", "name": "spin",
    "result": { "grid": [...], "events": ["scatters:3"], "payout": 40 } },
  { "t": "trigger", "mechanic": "bonus_meter", "name": "accumulate",
    "result": { "fill": 3, "events": [] } },
  { "t": "transition", "on": "scatters:3", "to": "fs1" },
  { "t": "state_exit", "state": "base" },
  { "t": "state_enter", "state": "fs1" },
  // ... 8 steps, possibly a retrigger effect entry ...
  { "t": "round_end", "total_payout": 640 }
]
```

- The server produces the whole trace in one pass (v1). The **resumable-steps
  seam**: a future interactive state emits an `await_input` entry and the
  trace ends there; a follow-up request supplies the choice and the trace
  continues. Nothing in v1 consumes this — it only constrains the trace to be
  a _walkable sequence_, never a nested aggregate like today's `RoundOutcome`.
- Trace entries for triggers carry the mechanic **result data the client needs
  to present** (the grid to settle on, the fill level to animate to) — the
  client never re-runs math.

## 7. Client — `runtime/client`

The existing module system (`IGameModule`, `ModuleRegistry`, `ModuleManager`)
is the foundation and is kept:

- Mechanic modules register under the same `type@version` ids and implement
  the same **named triggers**. A trigger invocation maps to module verbs plus
  an async completion signal (e.g. `reels.spin` → `startSpinning()` …
  `stopSpinning(grid)` → wait for `reels:settled`).
- New **TraceWalker** generalizes today's `Orchestrator`: it consumes a trace,
  dispatches trigger entries to module instances by mechanic id, waits for
  each completion before advancing, and surfaces `state_enter`/`state_exit`
  on the bus. Per-state scene variants (different background in free spins)
  are a named follow-up, not v1 — v1's presentation hook is the bus events.
- New `MeterModule` (`meter@1`) is the second concrete module, proving the
  seam beyond reels.
- The engine builds its module set from the Game Definition's `mechanics`
  list (today `engine.ts` hard-registers `'reels'`).
- Play mode: `/handshake` already delivers presentation config; the composed
  flow adds the definition (or the client receives it via the pkg-derived
  handshake) and `spin` responses carry traces instead of bare outcomes.

**Parity testing:** golden vectors — kernel-generated `(definition, seed) →
trace` fixtures checked into the client suite; the client asserts it can walk
every fixture to completion and that module end-states match the trace's
claims. Same approach as the existing math golden vectors.

## 8. Studio

New plugin, pattern-cloned from `game-config`: a **Game Structure** editor.

- **Mechanics pane**: game-level instance list; add from the mechanic catalog;
  config forms generated from each mechanic's config schema.
- **States pane**: per-state bindings (instance picker + override editor),
  step budget, ordered step script (trigger picker).
- **Transitions pane**: the declarative table (from / on / to-or-effect),
  with validation (§3) surfaced inline.
- **JSON escape hatch** section, like the game-config editor's.
- Persists the Game Definition per game in Mongo; a **build action** produces
  the `composed@1` `.pkg` feeding the existing preview/play flow.
- Tuner, simulator, analytics, and the `game-config` editor stay on `slots@1`.
  Convergence (GA mutating per-state mechanic configs, etc.) is the filed
  follow-up todo, deliberately out of scope.
- The in-flight GDD↔SlotModel SoT work targets the `slots@1` world; its
  doctrine (one owner per field, intent vs realization) should be re-examined
  against composed games before its Plan 2 — noted as a cross-reference, no
  action here.

## 9. Sub-project decomposition

Each is its own spec-refinement → plan → build cycle; this document is the
umbrella. The proof game threads through all four: **Base (reels + meter) →
FS1 (scatter-triggered, retriggers) → FS2 (meter-full-triggered) → base.**

1. **SP1 — kernel `composed@1`**: Mechanic trait, registry, evaluator,
   `reels@1` + `meter@1`, states/transitions/trace, definition validation,
   golden vectors. Pure Rust, TDD end to end.
2. **SP2 — package + server**: `composed@1` payload build, family dispatch,
   wire trace, audit. Small.
3. **SP3 — client**: TraceWalker, trigger parity, `MeterModule`,
   definition-driven module registration, play mode against a composed `.pkg`,
   golden-vector walk tests + e2e.
4. **SP4 — studio authoring**: Game Structure plugin, Mongo persistence,
   build-to-play. Playwright e2e for the authoring flow.

## 10. Out of scope (explicit)

- Cross-round mechanic-state persistence (and its RTP implications).
- Interactive states / mid-round player input (the trace shape reserves the
  seam; nothing consumes it).
- Tooling convergence: tuner/simulator/analytics/game-config on composed games
  (filed as todo).
- Per-state scene/presentation variants on the client.
- Per-mechanic RNG streams (`composed@2` candidate).
- Migrating `slots@1` games or retiring `slots@1` — never; it is append-only.

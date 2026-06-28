# Vision-in-the-loop scene composition (slot-tailored) — design

**Date:** 2026-06-27
**Branch:** `feat/vision-compose`
**Status:** approved (brainstorm)

## Problem

`generate_and_place` builds a scene element-by-element, with the agent guessing
absolute pixel coordinates per element and **no feedback** on the assembled
result. The generated assets are individually premium, but the **composition** is
broken: elements overlap, relative scale is wrong, z-order is a brawl, and there
is no slot-machine anatomy (reel grid, framed symbols, a logo that stays out of
the play area). The canonical failure is the live "premium pirate slot" build —
functionally correct, aesthetically unusable.

The defects are **global, not per-element**:

- They are invisible when judging one element in isolation. "Logo overlaps the
  captain" does not exist until both sprites coexist.
- They are **not** fixable by regenerating individually-good assets. A captain
  that is too large in the wrong spot needs to be **moved and scaled**, not
  repainted into a _different_ captain at a _different_ random size.

So the missing capability is a **composition critic that sees the assembled scene
and adjusts placement**, with regeneration reserved for assets that are
intrinsically wrong for their role.

## Goals

- After each element is placed, evaluate the **real rendered scene-so-far** and
  apply corrective edits before moving to the next element.
- Edits may target the **new element and a bounded window of prior elements**
  (retroactive), because composition is a system of relationships.
- **Transforms are the primary lever** (move / scale / reorder), applied
  liberally. **Regeneration is the heavy lever**, spent conservatively against a
  budget and only when no transform can fix the problem.
- The loop is **bounded** (hard caps, no up-front layout plan in v1) and
  **observable** — every critique and edit streams into the chat feed so the user
  can watch the scene compose.
- The critic is **tailored to slot games** while preserving creative freedom in
  content and style.

## Non-goals (v1)

- **No up-front layout plan / region map.** v1 deliberately has no planner; the
  critic reasons from the rendered frame against slot-aesthetic _guidance_, not a
  reserved-region contract. (See "Known limitation" — the planner is the obvious
  follow-up if convergence is poor.)
- **No new heavy actuator.** Transform editing reuses the existing
  `scene_set_prop` / `scene_apply_batch` primitives.
- **No change** to `generate_and_place`'s generate+place mechanics or to
  `regenerate_element`'s in-place repaint.
- **No server-side image compositing.** The critic grades the _actual_ engine
  frame (see Capture), not a reconstructed approximation.

## Key insight (why a deterministic loop, not router prose)

The interleaved-compose work
(`2026-06-26-interleaved-scene-compose-design.md`) already established that the
model will **not** reliably sequence on instruction alone — sequencing had to move
into a **tool/queue**, not prose. The same applies here: a critic loop that lives
in router prose ("please critique after each element") will be skipped and
batched. Therefore the loop is **deterministic orchestration in code**, not an
instruction the agent may ignore.

## Design

### 1. Compose-loop orchestrator (new graph, sibling to the design-router)

Owns the whole build loop for a "build a scene" request:

```
for each element the build names, in order:
    generate_and_place(element)                 # existing atomic verb
    for pass in range(MAX_PASSES_PER_ELEMENT):  # critic re-look loop
        frame = capture_rendered_frame()        # real engine frame (§2)
        edits = vision_critic(frame, scene, window, regen_budget_left)  # §3
        if edits.done or not edits.items:
            break
        apply(edits)                            # §4 — transforms liberal, regen budgeted
    advance to next element
```

- **Bounds (v1 defaults — liberal):**
  - `LOOK_BEHIND_DEPTH N = 3` — when editing at element _K_, the critic may target
    elements `[K-3 .. K]` only.
  - `MAX_PASSES_PER_ELEMENT = 3` — re-look until the critic returns `done` or the
    cap is hit.
  - `GLOBAL_REGEN_BUDGET K = 5` per scene — hard ceiling on regenerations across
    the whole build.
  - **Stop condition:** critic returns empty edits / `done`, **or** caps hit →
    advance.
- **Streaming + interruptible:** each critique and each applied edit is emitted as
  a step into the unified chronological chat feed (the user watches it compose),
  and the loop is `interrupt()`-able, reusing the existing approval-gate
  machinery.
- **Home:** a dedicated graph/spec sibling to `design-router`
  (`studio/backend/app/gdd/router.py` is the precedent). Branch 4 ("build a
  scene") routes into this orchestrator instead of emitting bare
  `generate_and_place` calls.

### 2. Real-frame capture (client) — render-settled handshake

The critic must grade the **actual rendered frame**, so future particles,
animations, filters, and the responsive root-scaling transform are judged as the
user sees them (a server-side composite would diverge once effects exist).

Mechanism, over the existing postMessage protocol:

```
orchestrator applies scene op
      → engine renders it and ACKs "drawn"   (extends the #115 per-change commit ack)
      → client extracts the canvas to PNG    (e.g. renderer.extract / toDataURL)
      → client posts the PNG back to the backend
      → orchestrator forwards it to the critic
```

- **The load-bearing detail is the _render-settled barrier_:** capture must wait
  for the engine to ack the just-applied op is **drawn**, or the critic grades a
  **stale frame** and chases ghosts. This is the single highest-risk part of the
  feature and is called out explicitly for the plan.
- **Cost:** author-time only, a few captures per element. A scene PNG over an
  already-open channel is tens-to-hundreds of KB — negligible. Latency (a browser
  round-trip per pass) is acceptable at author time.

### 3. Vision critic — structured output, slot-aware

A vision-capable model call that receives the rendered frame plus structured
scene context and returns a **structured edit list**.

- **Input:** the captured PNG; `read_scene` output (every placed sprite's
  `handle / role / asset name / x,y / size / z`); the handle of the
  just-added element; the look-behind window (which handles are editable); the
  user's theme/intent; and the remaining regen budget.
- **Output (structured, validated — no prose parsing):**
  ```
  {
    done: bool,
    edits: [
      { target_handle, action: "move"|"scale"|"reorder"|"regenerate",
        params: {...}, why: "<reason>" }
    ]
  }
  ```
- **Slot-aware system prompt:** encodes canonical slot anatomy — background
  full-bleed; reel grid centered; symbols sit **inside** the grid; logo in the top
  band, clear of the play area; spin button bottom-center; foreground flourishes
  framing, not covering. This is **aesthetic guidance, not a hard region map** —
  content and style stay free.
- **Discipline enforced in the prompt _and_ in code (§4):**
  - Edits are constrained to the look-behind window; out-of-window targets are
    rejected.
  - **Transform-first:** a `regenerate` edit must carry a `why` asserting that no
    transform fixes it (the asset is wrong _for its role_, e.g. a dense
    rectangular foreground blob that can't be salvaged by moving/scaling).
  - `regenerate` edits are gated by the global budget; once `K` is exhausted, the
    critic is told it has only transforms left.
- **Swappable seam + replay:** the critic is a provider call behind a thin seam,
  recorded as replay cassettes so tests are deterministic and offline (per the
  test/real-parity rule and `PROVIDER_MODE=replay`).

### 4. Actuators

- **Transform (liberal):** `move` / `scale` / `reorder(z)` an existing placed
  sprite. Reuses the existing low-level `scene_set_prop(node_id, path,
  value_json)` (sets `position.x`, `scale`, `zIndex`) and `scene_apply_batch`
  (agent_tools.py:508 / :577). A thin semantic wrapper
  `adjust_element(ref, x?, y?, scale?, z?)` — handle-resolved exactly like
  `regenerate_element` — gives the critic a clean verb; it composes the
  `scene_set_prop` ops internally. **Decision to confirm in the plan:** ship the
  `adjust_element` wrapper vs. drive `scene_set_prop` directly. (Recommendation:
  the wrapper, for clean handle resolution + one place to enforce window/validity.)
- **Regeneration (conservative):** the existing `regenerate_element` repaints in
  place, keeping position/scale/z. Spent only against the budget, transform-first.

## Tradeoffs (accepted)

- **No layout plan in v1.** The critic judges a partial scene against slot
  _guidance_, so early elements (judged against a half-empty scene) will rely on
  **retroactive transforms** to recover as later elements arrive. This is the
  experiment: we want to watch whether the windowed retroactive loop converges
  before investing in a planner.
- **Bold regen budget (K=5) with transform-first.** B-style: regeneration _can_
  target composition-incompatible assets, not just broken cutouts — but
  transform-first keeps the budget from being spent on problems a nudge solves.
- **Real-frame capture over server compositing.** More moving parts (the
  render-settled handshake) in exchange for fidelity that survives the effects
  roadmap.

## Known limitation (logged, not hidden)

With no up-front plan, expect the critic to spend effort un-doing early
commitments (e.g. shrinking an over-large logo once the reel grid + symbols +
spin button arrive). If convergence is poor or the loop thrashes within its caps,
the **deferred follow-up** is an up-front slot **layout plan / reserved region
map** that the critic reconciles each element against — turning open-ended
"re-optimize" into bounded "reconcile to plan."

## Testing (e2e is the source of truth)

### Unit (pytest, `studio/backend`)

- **Critic contract:** structured output schema parses; `done` / empty-edits stop;
  out-of-window targets are rejected; `regenerate` without a transform-first `why`
  is rejected; regen edits beyond budget `K` are refused.
- **Orchestrator bounds:** `MAX_PASSES_PER_ELEMENT`, `LOOK_BEHIND_DEPTH`, and
  `GLOBAL_REGEN_BUDGET` enforced; stop on `done`.
- **Render-settled barrier:** capture waits for the "drawn" ack; a stale-frame
  path is not gradable.
- **Actuators:** `adjust_element` resolves a handle and applies `move/scale/reorder`
  via `scene_set_prop` (against the real Mongo scene store); `scene_apply_batch`
  path stays green.

### e2e (replay, `studio/backend`, non-browser — authoritative)

- A recorded compose run with a **critic cassette**: build a multi-element slot
  scene; assert the loop **captures → critiques → applies transforms**, spends
  **≤ K** regenerations, edits only within the look-behind window, and the scene
  converges (stops on `done` / caps). Mirrors the existing `compose-*.json`
  cassette pattern under `tests/fixtures/replay/run/`.

### Browser e2e (Playwright, local-only, never CI)

- Drive a real "build a pirate slot" request against the replay backend; assert
  the Game Scene visibly reflows between elements (sprites move/scale as the
  critic acts) and the chat feed shows interleaved `critique` + edit steps. This
  is the client-perspective contract per AGENTS.md.

## Files (anticipated — finalized in the plan)

- `studio/backend/app/` — new compose-loop orchestrator graph; vision-critic seam
  + structured-output schema; `adjust_element` tool; register in
  `ToolFactory._BUILDERS`.
- `studio/backend/app/gdd/router.py` — branch 4 routes "build a scene" into the
  orchestrator.
- Frontend/runtime client — canvas capture + render-settled ack over the
  postMessage protocol; post PNG back.
- Tests + cassettes — unit suites above; replay compose cassette under
  `tests/fixtures/replay/run/`; Playwright spec under `studio/frontend/e2e/`.

## Open decisions for the plan

1. `adjust_element` semantic wrapper vs. raw `scene_set_prop` (recommend wrapper).
2. **Vision model — decided: `claude-sonnet-4-6`** (via OpenRouter), behind the
   swappable critic seam and cassette-recorded for replay. Rationale: composition
   critique is demanding spatial reasoning (relative scale, overlap, alignment,
   z-order) where the cheapest tier (`claude-haiku-4-5`, $1/$5 per 1M) gets
   unreliable; Sonnet 4.6 ($3/$15) is the strong-but-affordable tier with vision +
   structured outputs, and cost is trivial at author-time volumes. `claude-haiku-4-5`
   is the cost-floor A/B fallback once the loop works; `claude-opus-4-8` ($5/$25)
   is the escalation for judgments Sonnet can't make. The seam makes this a config
   string, not a lock-in.
3. Exact wire shape of the render-settled ack + capture message on the postMessage
   protocol.

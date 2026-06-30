# Scene Blueprint — GDD-driven layout plan, plan-reconcile critic, human-in-the-loop

**Status:** design (approved direction, pending spec review)
**Date:** 2026-06-30
**Sub-project A of:** the generate → place → judge quality overhaul (see "Wider roadmap" below)

## Problem

The generate-assets → place-in-scene → LLM-critique pipeline works but plateaus at
"acceptable AI filler," well short of premium-quality slot scenes. Investigation of
the three subsystems (asset generation, scene placement, the vision critic) found
three structural causes that compound — each upstream stage starves the one below it:

1. **No shared art direction flows through the stages.** Each stage sees a
   different, impoverished view of intent:
   - The generator gets bare prose. `agent_tools.py` builds the entire prompt as
     `description if not style else f"{description}, {style} style"` — no negatives,
     no role-awareness, and FLUX runs at `cfg=1.0` (barely steered by the text).
   - The placer is **never told the canvas dimensions** (`compose.py` hardcodes
     `1280×720`, invisible to the agent) and sets absolute pixels essentially blind;
     a deterministic clamp drags off-frame sprites back, preserving the anchor but
     wrecking the composition.
   - The critic is the **only** stage that knows what a slot scene should look like —
     the "canonical slot anatomy" lives solely in `critic.py`'s system prompt. The
     one component with taste runs **last**, cleaning up after two blind upstream
     stages on a tiny budget.

2. **The critic judges a proxy, not the real frame.** Post-#120 the critic sees a
   Pillow **layout-only** composite (position/anchor/scale/z-order/background) — no
   filters, blends, masks, glows, particles, or responsive scaling. `done: true`
   certifies _geometry is plausible_, not that the scene looks premium. (Addressed
   by sub-project B, out of scope here — but see the synergy note in the design.)

3. **Quality is reactive, plan-less, and budget-starved.** There is no up-front
   layout. It is place-then-nudge with a 3-element sliding window, 3 passes, and 5
   total regenerations per build (`compose_loop.py`). Premium composition is a
   _global_ property; a sliding-window nudger structurally cannot reason about it.
   PR #120's own spec defers the fix: _"an up-front slot layout plan / reserved
   region map that the critic reconciles each element against."_ That deferred
   planner is the premium-quality floor, and it was never built.

## Goals

- A **Scene Blueprint**: high-level art-direction + layout _intent_ persisted in the
  GDD as rich, human-readable, AI-authorable prose (plus three light enums) — **no
  geometry, no coordinates, ever**.
- A **canonical layout template in code** (the reusable slot anatomy with default
  regions) that the intent _selects and nudges_, producing a concrete per-game
  **plan** the placer fills and the critic reconciles against.
- The generator's prompts and the placer's coordinates both **consume** the GDD
  intent (closing cause 1); the critic **reconciles each element to its planned
  region** instead of re-composing from remembered principles (closing cause 3).
- **Two authoring modes through one pipeline:** a fully AI-generated scene (no human
  touch) and human-in-the-loop, both feeding the same intent → bind → realize flow.
- **Full reproducibility** of any built scene from persisted inputs — _without_
  putting pixels in the GDD.

## Non-goals

- **Real-frame vision** (critic grading the actual engine frame with effects /
  responsive scaling). That is **sub-project B**, additive on top of this work — the
  plan-reconcile critic here is a _geometry_ judgment, which the existing layout-only
  compositor already renders faithfully, so A needs no real-frame capture to be
  correct.
- **Raising the per-asset quality floor** (negative prompts, `cfg`/steps tuning,
  upscaling, mandatory standalone asset critic). That is **sub-project C**. This spec
  _feeds_ it (the generator now reads art direction + role) but does not build it.
- **Pixel positions in the GDD.** The GDD holds intent only; geometry lives in code,
  realized scenes + overrides + seeds carry reproducibility.

## Wider roadmap (context, not built here)

| Sub-project             | Scope                                                                                                            | This spec      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------- |
| **A — Scene Blueprint** | GDD intent → bind → plan → plan-driven placer → reconcile-to-plan critic → `rebuild_scene` spine + HITL surfaces | **this spec**  |
| B — Real-frame vision   | critic grades the real engine frame, not the Pillow proxy                                                        | follow-on spec |
| C — Asset quality floor | negatives, cfg/steps, role-aware prompts, upscale, mandatory asset critic                                        | follow-on spec |

## Architecture — three layers, one job each

```
Layer 1  GDD intent (rich prose + 3 enums)        human + AI authored, NO geometry
   │         theme.art_direction, theme.tone/setting, ui-ux.layout
   │         ui-ux.orientation | focal_emphasis | framing_density  (the only geometry inputs)
   ▼
  bind(gdd_intent, orientation, overrides) ──────────────────────► ScenePlan
   ▲                                                                  │
Layer 2  Canonical layout template (CODE)                            │  per-role:
   │       slot anatomy: background/reels/logo/spin/flourishes        │  region(px,anchor,z,fit)
   │       normalized 0–1 regions, 2 orientation variants, versioned  │  + art-direction snippet
   │                                                                   ▼
Layer 3  Realized scene + asset seeds (PERSISTED) ◄──── place into regions, generate from prose
          GameSceneStore sprites + asset Generation.seed  = the reproducible artifact
```

- **Layer 1 — intent, in the GDD.** Rich prose drives _art generation_; three enums
  drive _geometry_. The design-router authors both from one user prompt (so
  fully-AI sets them together); a human can edit either.
- **Layer 2 — geometry, in code.** The precision that the placer and critic must
  agree on lives where precision belongs: versioned, testable code.
- **Layer 3 — the reproducible artifact.** Already largely exists (scene doc + asset
  seeds). Reproducibility lives here, not in the GDD.

The **Blueprint is the bind** between L1 and L2: it turns prose intent + the code
template into a concrete per-game `ScenePlan`.

## Layer 1 — GDD intent fields

Enrich existing fields (finally _consumed_) and add three light enums. Schema lives
in `studio/backend/app/gdd/schemas.py`; the system auto-adapts (catalog, router
prompt, REST, frontend) — see the GDD extensibility notes.

**`theme` aspect** (enrich, consume):

- `art_direction` (text, _exists_) — now consumed. Palette, materials, lighting,
  mood, motifs as rich prose.
- `tone`, `setting` (text/enum, _exist_) — folded into prompt context.

**`ui-ux` aspect** (enrich + add):

- `layout` (text, _exists_) — rich prose layout intent.
- `orientation` (enum: `portrait` | `landscape`) — **new**; selects the template
  variant + canvas.
- `focal_emphasis` (enum: `reels` | `logo` | `balanced`) — **new**.
- `framing_density` (enum: `clean` | `moderate` | `ornate`) — **new**.

These three enums are the **only** new structured geometry inputs. No coordinates.

## Layer 2 — canonical layout template

New module `studio/backend/app/scene/layout/template.py`:

- Slot anatomy as **named roles**: `background`, `reels`, `logo`, `spin`,
  `flourish_left`, `flourish_right` (and optional `credits` / `paytable_btn`).
- Each role: a default **region in normalized 0–1 canvas coords** (orientation-
  portable), an `anchor`, a `z`-band, and a `fit` mode.
- Two orientation variants (`portrait`, `landscape`).
- Pure data + pure functions; **versioned** (`TEMPLATE_VERSION`), fully unit-testable.

## The bind step (keystone)

New module `studio/backend/app/scene/layout/bind.py`:

```
bind(gdd_intent, orientation, overrides) -> ScenePlan
  1. select template variant by orientation
  2. apply enum transforms deterministically:
       focal_emphasis=reels   -> enlarge reels region, shrink flourishes
       focal_emphasis=logo    -> enlarge logo band
       framing_density=ornate -> enable both flourishes
       framing_density=clean  -> drop flourishes
  3. resolve normalized regions -> absolute px against canvas size
  4. attach per-role art-direction snippet (distilled from L1 prose) for the generator
  5. (phase A4, optional) LayoutRefiner.refine(plan, full_prose)
       -> BOUNDED deltas only: clamp every region to canvas; reels stays focal;
          never remove a skeleton-required role
  6. apply persisted per-game region OVERRIDES as the final layer
  -> ScenePlan = [PlannedRole{role, region(px, anchor, z, fit), prompt_snippet}]
```

- `ScenePlan` is a typed structure. It is **derived** — reproducible from GDD +
  `TEMPLATE_VERSION` + overrides (+ refiner seed in A4) — so it never bloats the GDD,
  yet reproduces deterministically.
- `LayoutRefiner` is a `Protocol` with a **no-op default**. Phase A1 ships
  deterministic-only; phase A4 drops in `LLMLayoutRefiner` without touching callers.
  This is the seam that makes "Approach 2 (LLM planner) from the start" a one-line
  default swap rather than a rewrite.

## Placer — role-driven, not coordinate-driven

The agent's job shifts from _"pick x, y"_ to _"pick the role"_; the plan supplies
geometry. In `studio/backend/app/agent_tools.py` + the compose loop:

- **`compose_scene` becomes plan-driven.** Internally `bind(...) -> ScenePlan`, then
  iterate planned roles in z-order: generate each asset (prompt = art-direction prose
  - the role's snippet) and place it into **its planned region** via the existing
    `build_sprite_ops` / fit math. The agent no longer hand-places in the compose path.
- **`generate_and_place` gains a `role`.** With a role, it places into that role's
  planned region; raw `x`/`y` remains an escape hatch (and for HITL nudging).
- **`adjust_element` / `add_sprite`** unchanged — fine control + the manual-nudge
  surface.

This closes cause 1's placement half: the placer targets a known region in a known
canvas instead of guessing.

## Critic — reconcile-to-plan, not compose-from-scratch

In `studio/backend/app/scene/critic.py` + `compose_loop.py`:

- The critic receives **each element's intended region** (the `ScenePlan`) in context
  and judges a _bounded_ question: _is this element in its planned region, at the
  right scale, without colliding?_ — emitting the same `move`/`scale`/`reorder`/
  `regenerate` edits, now as **deviations from plan**.
- The system prompt's remembered "canonical slot anatomy" prose is **replaced** by
  the concrete per-role plan passed in context. `CritiqueRequest` gains the
  `ScenePlan`.
- Because each element now has an **absolute target**, the tight look-behind window /
  pass / regen budgets stop hurting — they bound _correction_, not _search_. Existing
  bounds are kept but reinterpreted.

**Synergy with sub-project B:** reconcile-to-plan is a _geometry_ judgment — exactly
what the layout-only compositor renders faithfully — so A is correct on the proxy we
already have. B then _adds_ the art/effects/quality judgment on top.

## Human-in-the-loop — four surfaces, one spine

All four converge on one re-entrant operation:

```
rebuild_scene(game_id):
  read GDD intent + persisted region overrides
    -> bind -> (re)place affected roles -> critic reconcile -> realized scene
```

This single deterministic entry point is what keeps four surfaces from becoming four
code paths.

1. **Chat-driven edits** _(phase A1; rides existing infra)._ Human tells the agent
   ("make the framing ornate", "logo as a banner"); the design-router rewrites GDD
   intent via `set_gdd_fields`, then calls `rebuild_scene`. Adds one router branch.
2. **Direct GDD field editing** _(phase A2)._ Turn the read-only `GddViewerPane` into
   an editor for the intent fields (textareas for prose, selects for the three
   enums). Save → existing `PUT /games/{id}/gdd/{aspect}` (`set_fields`) → emits
   `gdd_doc_updated` → triggers `rebuild_scene`. Reuses REST + websocket; no new
   persistence.
3. **Scene review / approval checkpoint** _(phase A3)._ `rebuild_scene` pauses and
   surfaces the composed frame + proposed per-element edits for **approve / reject /
   nudge** before finalizing. **Reuses the existing LangGraph `interrupt()` approval
   gate** (the destructive-delete gate + GDD question-interrupt use it). Approve →
   finalize; reject → discard; nudge → apply overrides then continue.
4. **Manual region nudge** _(phase A3; most UI)._ Human drags a role's region in the
   scene; the delta persists in a small **per-game region-override store**
   (`role → override`). Overrides apply _after_ `bind` (the final bind layer), so a
   nudge survives future rebuilds and never fights the plan.

## Reproducibility

A scene is fully reproducible from four persisted inputs — none of them pixels in the
GDD:

1. **GDD intent** (prose + enums) — persisted in `gdd_docs` (exists).
2. **Region overrides** (per-game `role → override`) — new small store.
3. **Asset seeds** — persisted on asset records (`Generation.seed`, exists).
4. **Template version** (`TEMPLATE_VERSION`) — **pinned per game/scene** so a future
   template edit never silently re-lays-out an existing game.

`rebuild_scene` is deterministic given these: the bind is pure; reproduction
**reuses stored seeds** rather than drawing fresh; the critic runs against replay
cassettes. The realized scene doc stays the concrete artifact but is now _derivable_.

## Testing (TDD-first, per repo norms)

- **Unit (RED-GREEN-REFACTOR):** template region math, bind enum→region transforms,
  override application, plan shape. Pure functions — ideal for test-first.
- **Backend e2e (replay, CI-affordable):** `rebuild_scene` end-to-end with
  reconcile-to-plan critic cassettes; assert role→region placement, bounded
  reconciliation, and **reproducibility** (same inputs → equivalent scene).
- **Browser e2e (Playwright, local, authoritative):** one spec per HITL surface —
  editable GDD save reflows the scene; approval checkpoint pauses/approves; region
  nudge persists and **survives a rebuild**.
- **New critic cassettes** for the reconcile-to-plan contract (hand-authored from
  static analysis per the tuner-chat precedent, or recorded live).

## Phase breakdown (each a clean stop/ship point)

| Phase                   | Deliverable                                                                                                                                                                                                                                    | Tests                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **A1 — engine**         | L1 fields (3 enums + consume prose) · L2 template module · deterministic `bind` → `ScenePlan` · plan-driven `compose_scene` / `generate_and_place` · critic reframe to reconcile-to-plan · `rebuild_scene` spine · Surface 1 (chat re-trigger) | unit (template/bind/plan) + backend e2e (rebuild + reconcile + reproducibility) |
| **A2 — intent editing** | editable GDD pane (Surface 2) → rebuild trigger                                                                                                                                                                                                | Playwright: edit → save → reflow                                                |
| **A3 — review + nudge** | approval checkpoint via `interrupt()` (Surface 3) · region-override store + drag UI (Surface 4)                                                                                                                                                | Playwright: pause/approve; nudge → persist → survive rebuild                    |
| **A4 — optional**       | bounded `LLMLayoutRefiner` behind the `LayoutRefiner` seam                                                                                                                                                                                     | unit (bounds/clamp) + backend e2e                                               |

## Risks

- **Hot files.** `agent_tools.py` and the design-router (`gdd/router.py`) are
  frequently edited across sessions. New template/bind/plan logic lives in fresh
  modules under `scene/layout/` so the hot files gain only thin call-sites; land A1
  fast to avoid merge drift.
- **Intent/geometry coupling.** Geometry follows the three enums, not the prose, in
  phase A1. A human editing only prose won't move boxes until the A4 refiner reads
  prose. Documented behaviour; the design-router sets both enums and prose together
  when authoring.
- **No GDD schema migration.** The GDD is schema-agnostic (unknown fields warn, not
  block); old games simply lack the new enums and fall back to template defaults.

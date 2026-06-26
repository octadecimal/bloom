# One-shot prompt → generated assets placed in the live scene

**Date:** 2026-06-25
**Branch:** `feat/scene-compose`
**Status:** Design — approved, pre-implementation

## Problem

A user should be able to type a single freeform prompt into the chat —
e.g. _"make a pirate theme game, it should have a background and a logo centered
at the top"_ — and watch the agent generate the named art (via ComfyUI) and
place each piece into the live Pixi scene, positioned as asked, all in one turn.

Every building block for this already exists and works **in isolation**:

- **Asset generation → ComfyUI** is fully wired: `generate_asset` tool →
  `AssetHub` → ComfyUI (`:8188`, live or replay) → PNG at
  `/media/<game>/<asset>/<gen>.png` → `asset_completed` broadcast.
- **Scene placement** is fully wired: `scene_*` tools → `GameSceneHub.apply_op`
  → Socket.IO → studio → postMessage → Pixi engine renders live. Positioning is
  sprite `position` + `anchor` props.
- **The agent calls tools** via `TurnRunner` + LangGraph react-agent, with
  approval/question interrupt gates.

The gap is **orchestration, not capability**. The three relevant skills are
siloed and no single agent context holds both halves of "generate → place":

| Skill             | Tools bundled                                   | Can do the pirate prompt?            |
| ----------------- | ----------------------------------------------- | ------------------------------------ |
| `design-game`     | GDD docs only                                   | Edits design fields, no visuals      |
| `generate-sprite` | `generate_asset` only                           | Makes an image, **doesn't place it** |
| `design-scene`    | `scene_*` + `list_assets` (no `generate_asset`) | Places assets that **already exist** |

Today, the pirate prompt typed as plain chat in a game room hits the
**design-router**, which only routes to GDD field edits — no generation, no
scene. No tool turns a freshly generated asset into a placed scene node.

## Goals

- A single chat prompt generates the named visual elements and places them,
  positioned, in the live scene — **one turn, no manual steps**.
- Every action is a **discrete, named, visible tool call** in the chat feed.
  No black-box monolith; the user watches the agent reason and act.
- The placement seam **generalizes** to future node types (text, Spine, particle
  emitters) without rewrites.
- The design **does not regress** the existing GDD-edit / symbol / question
  routing.

## Non-goals (deferred, with named seams)

- `add_text` / `add_spine` / `add_emitter` — the same per-type pattern, not built
  this slice.
- GDD reconciliation: mapping scene `role`s (background, logo) back to the GDD
  (the "option 3" linkage). The `role` tag is stored now so this is a clean
  follow-up, not a retrofit.
- Factoring the visual branch into a dedicated, editable `compose-scene` skill
  plus true skill auto-select — slice-2 evolution once `add_sprite` is proven.
- Drag-from-asset-board UI placement.
- Binding textures by asset-reference for live swaps (today's convention stores
  the resolved media URL as the Texture `src`, matching `realize_symbol`).

## Approach (chosen)

Two changes, no new subsystems:

1. **New backend tool `add_sprite`** — the durable seam. Encapsulates the
   "place an image" recipe as one atomic batch, hiding all Pixi graph plumbing.
2. **Extend the `design-router` agent** with a visual-compose branch and the
   visual tools, so the same agent that already infers GDD-edit vs symbol vs
   question now also infers "make/place visual elements" and chains the calls.

### Why this altitude (not the alternatives)

- **Rejected: a `place_asset_in_scene` monolith.** One overloaded tool that
  branches per node type, or a new monolith per type. Brittle as soon as Spine /
  text arrive, and opaque — invisible orchestration works against Bloom's whole
  value (watching the agent act).
- **Rejected: raw `scene_add_node` / `scene_connect` primitives in the agent's
  hands.** Placing one image is _create Sprite, create Texture, set src, wire a
  data edge, wire a child edge, set position_ — five ops where the two edges are
  easy to misdirect. That is the agent doing Pixi's bookkeeping, with five
  chances to get the plumbing wrong. Those graph mechanics are an implementation
  detail, not design intent.
- **Chosen: mid-level, per-type, composable tools.** One constructor tool per
  node _type_, each a single named call. Generalizes (new type = new `add_*`
  tool, never a rewrite), transparent (each step is a discrete meaningful call),
  reliable (each tool owns one type's wiring, so the LLM never hand-directs
  edges). The honest altitude: hide the Pixi bookkeeping, show the design
  decisions.

### Why extend the router rather than author a new skill now

Extending the existing synthetic `design-router` `SkillSpec` (a branch list +
tool set) is the fastest path to the one-shot demo and requires zero new
handoff/skill-auto-select machinery: the same single agent call infers among
branches and chains visible tool calls — literally "one agent infers which tools
to invoke." The dedicated, editable `compose-scene` skill + real skill
auto-select become slice 2 once the `add_sprite` seam is proven. This decision is
reversible.

## Components

### 1. `add_sprite` backend tool

Conceptual signature:

```
add_sprite(asset_id, parent="root", position={x, y}, anchor={x, y},
           fit="none"|"cover"|"contain", scale?, z_index?, role="")
```

Behavior:

- Resolves `asset_id` → its selected generation's media URL (the same `src`
  convention `realize_symbol` already uses).
- Emits **one** `scene_apply_batch` containing: create Sprite node, create
  Texture node (`src` = media URL), set position / anchor / scale / zIndex, wire
  the `data` edge (Texture → Sprite) and the `child` edge (parent → Sprite). One
  `apply_op` = one atomic, validated mutation (also sidesteps the known
  `SceneHub` concurrent-write race, since placement is a single op).
- `fit="cover"` is a convenience for fullscreen backgrounds, so the agent does
  not hand-compute scale from texture dims. `"contain"` and `"none"` round it
  out; default `"none"`.
- **`role`** (e.g. `"background"`, `"logo"`) is stored on the sprite node props —
  the GDD-ready seam. Slice 1 only records it.
- Canvas coordinate space comes from the `Root` node's `width`/`height` props
  (e.g. `1280×720`), so "centered at top" resolves to `anchor {0.5, 0}`,
  `position {width/2, 0}`.
- Returns a one-line confirmation plus the new sprite node id.

This is the _pattern_, not a special case: `add_text`, `add_spine`,
`add_emitter` are future siblings, each owning one type's plumbing. Factor the
shared "create node + parent it + position" logic into a helper so the siblings
reuse it.

### 2. `design-router` visual-compose branch

Add a branch to the router body (`app/gdd/router.py`, `_BODY_TEMPLATE`):

> If the message asks to create/generate visual elements or compose the scene
> (e.g. "make a pirate game with a background and a logo at the top"), then for
> each named element: `generate_asset` (reuse via `list_assets` if a suitable
> asset already exists), then `add_sprite` with the appropriate `role` and
> position. You may place several elements in one turn.

Add `generate_asset`, `add_sprite`, and `list_assets` to the router's tool set.
The existing "at most one design edit per message" rule is carved so the visual
branch may generate and place multiple elements in a single turn.

The pirate prompt then reads in the feed as the discrete steps the user watches:

```
generate_asset("pirate ship background")  → bg
add_sprite(bg, role=background, fit=cover, z=0)
generate_asset("pirate game logo")        → logo
add_sprite(logo, role=logo, anchor=top-center, position={W/2, 0})
```

## Data flow

```
chat prompt (game room)
  → room_hub._prompt_descriptor → design-router SkillSpec
  → TurnRunner (LangGraph react-agent, visual tools bound)
    → generate_asset → AssetHub → ComfyUI → media URL + asset_completed
    → add_sprite → scene_apply_batch → GameSceneHub.apply_op
       → Socket.IO scene_op → studio protocol bridge → postMessage
       → Pixi engine: GraphModel.apply → reconciler → renderer (live render)
  → each tool call streamed to the chat feed as a discrete run step
```

## Error handling

- `add_sprite` with an unknown `asset_id`, or an asset with no selected
  generation, returns a clear tool error (no partial scene mutation — the batch
  is built only after the asset/src resolves).
- Batch validation uses the same `GraphModel` rules the engine enforces
  (duplicate ids, edge direction, orphan prevention); an invalid batch fails the
  whole `apply_op` atomically.
- Generation failures surface through the existing `AssetHub` error path; the
  agent reports the failure rather than attempting to place a missing asset.
- No approval gates: generate + scene ops are non-destructive, so the flow runs
  autonomously in one shot.

## Testing

TDD throughout; the e2e suite is the authoritative behavioral contract.

- **Unit (RED → GREEN):** `add_sprite` emits a correct, validated batch — both
  edges directed correctly, `src` resolved from the selected generation, `role`
  tag set, `fit=cover` scaling, positions computed against root `width`/`height`.
  Asserted through the same `GraphModel` validation the engine uses (no orphan
  nodes). Error cases: unknown asset, no selected generation.
- **Backend:** the router, given the pirate prompt, yields the
  `generate_asset` → `add_sprite` chain (replay LLM cassette + replay ComfyUI
  cassette). Regression: a GDD-edit prompt still routes to `set_gdd_fields`.
- **e2e (authoritative, Playwright against replay backend):** the pirate prompt
  → assets generate → sprites render in the live Pixi scene at the expected
  positions, and the chat feed shows the discrete tool calls. This spec is the
  behavioral contract. Run with `just e2e` against `just backend-serve-replay`.

## Risks / open items

- **LLM reliably emits the chain.** Mitigated by the explicit router-branch
  recipe and the replay LLM cassette pinning the expected calls; the e2e spec
  is the guardrail.
- **`SceneHub` concurrent-write race** (pre-existing, noted in memory). Out of
  scope, but `add_sprite`'s single atomic batch minimizes exposure rather than
  widening it.
- **Router prompt bloat.** A 5th branch grows the router body; keep the
  visual-branch wording tight and lean on the e2e/back-end cassettes to catch
  regressions in the existing four branches.
- **Live-provider verification deferred.** The committed cassette scripts the
  agent's decisions; the pipeline beneath runs for real, but the LLM has not
  been verified to actually emit this chain against live providers. Follow up:
  record/verify the compose chain via `just e2e-live` (and refresh the cassette
  with `just record-fixtures` if the natural phrasing drifts) — the same
  deferred live-recording step noted for tuner-chat.
- **`add_sprite` parallel-race gap.** `add_sprite` reads `ensure_root` scene
  state outside the hub lock — two `add_sprite` calls in one parallel agent turn
  would race (second `apply_batch` rejected on duplicate Root); the replay
  cassette serializes around this via 3 rounds, but the live path is unproven.
  Candidate fixes: read-inside-lock or idempotent `addNode(root)`.

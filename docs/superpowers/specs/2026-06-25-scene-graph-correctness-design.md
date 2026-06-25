# Scene-graph correctness + e2e coverage

**Date:** 2026-06-25
**Status:** Approved (brainstorming) — ready for implementation plan
**Branch:** `fix/design-scene-wiring`

## Problem

Driving the `design-scene` skill live (gpt-4o-mini) to place a generated sprite
into the scene produced broken, sometimes destructive results. Observed across
two real chat turns ("add the phoenix", then "add a leopard"):

1. **Reversed `data` edge.** The agent connected `Sprite.data → Texture.texture`
   instead of the contract `Texture.data → Sprite.texture`. The backend accepted
   it (no endpoint typing on `data` edges), so the texture never bound.
2. **Missing `child` edge.** Sprites were created but never parented to `root`.
   An unparented node is never added to the Pixi stage, so it renders nothing —
   a blank canvas.
3. **Destructive rebuild.** Asked to _add_ a second sprite, the agent tried to
   re-add `root` (rejected `duplicate_id`), then called `removeNode(root)`, which
   **cascade-deleted every incident edge** (including the previously-correct
   parent edge), orphaning the existing sprite. Net: the first sprite vanished and
   the new one never appeared.
4. **Centering.** A Sprite's default anchor is `(0,0)`, so `position` sets its
   top-left corner. A sprite "placed at (640,360)" rendered toward the bottom-right
   of a 1280×720 stage, not centered.

These are partly LLM-behavior and partly missing guarantees in the scene contract.
The fix is **backend-first**: make broken scenes impossible at the contract layer
(deterministic, model-independent, testable), and additionally improve the skill
prose. Correctness is then validated by exhaustive, deterministic e2e.

## Goals

- A generated sprite placed via the agent reliably **renders, centered**, without
  manual patching.
- Incremental edits are **safe**: adding a node never clobbers existing content.
- The scene contract **rejects** malformed ops (reversed/mistyped edges, root
  removal) with clear errors, regardless of which model drives it.
- Exhaustive, deterministic Playwright e2e encodes the behavioral contract.

## Non-goals

- Multi-reel auto-layout, animation, sound, asset auto-tagging.
- Making LLM output deterministic. The skill prose improves behavior; the
  _contract_ (not the model) is what the e2e holds to account.

## Design

### A. Backend scene contract — `GraphModel` (TS + Python lockstep)

The graph contract lives in two files that MUST stay in lockstep (a verified
parity pair; a prior divergence shipped a real bug):

- `runtime/client/src/model/graphModel.ts`
- `studio/backend/app/scene/graph_model.py`

Every validation change below lands in **both**, with matching tests in both
`vitest` and `pytest`. Node/port definitions live alongside `NODE_TYPES` in
`document.ts` / `document.py`.

**A1. Port-typed edge validation (new).** Define a per-node-type port schema:

| Node      | Inputs              | Outputs    |
| --------- | ------------------- | ---------- |
| Root      | —                   | `children` |
| Container | `parent`            | `children` |
| Sprite    | `parent`, `texture` | —          |
| Texture   | —                   | `data`     |

On `connect`, after the existing node-existence checks, validate endpoints by
edge type:

- **`data`**: `from` must be a `Texture` at port `data`; `to` must be a `Sprite`
  at port `texture`. Otherwise `OpError("invalid_edge", …)`. (Rejects the reversed
  edge from problem 1.)
- **`child`**: `from` must be `Root`/`Container` at port `children`; `to` must be
  `Container`/`Sprite` at port `parent`. Otherwise `OpError("invalid_edge", …)`.

Existing `child` checks (`already_parented`, `cycle`) are preserved.

**A2. Guard `root` removal (new).** `removeNode` on a node of type `Root` raises
`OpError("cannot_remove_root", …)` — the Root is the stage and must persist. Also
reject adding a second `Root` (`OpError("root_exists", …)`). Prevents the
cascade-nuke from problem 3.

**A3. Reachability / orphan surfacing (new, non-blocking).** Add a helper that
returns the set of nodes with no `child`-path to a `Root`. Transient orphans are
normal mid-batch, so this does **not** reject. Instead, the scene **tool layer**
(`agent_tools` wrapping `apply_op`/`apply_batch`) appends a warning to the tool
result when, after the op/batch, any `Sprite`/`Container` is unreachable, e.g.
`⚠ 'phoenix' is not parented to root and will not render`. This nudges the agent
to self-correct and makes the failure visible in the run feed.

### B. Engine render — centering

In `PixiRenderer.createObject`, a new `Sprite` defaults its anchor to `(0.5, 0.5)`
so `position` denotes the sprite's **center**. An explicit `anchor` prop (via
`setProp`) still overrides. This is engine-only — no `GraphModel`/document change.
Fixtures/tests that assumed top-left anchoring (e.g. the seed/symbol-reshape
scenes) are updated to the new default.

### C. `design-scene` skill prose

`skills/design-scene.md` (edits already drafted on the branch), adds:

- Explicit edge **direction** with concrete `from_node/to_node` examples; bolded
  rule that for a `data` edge the **Texture is always `from`, the Sprite always
  `to`**.
- **INVARIANT**: every Sprite/Container must be parented to `root` (directly or
  via a Container that reaches `root`); add the parent `child` edge in the **same
  `scene_apply_batch`** as the node.
- **Never remove or re-add `root`** — it persists across turns. To extend an
  existing scene, add only the _new_ nodes and their parent edges; do not rebuild
  or recreate existing nodes.
- Centering note updated for anchor-0.5 semantics (place at stage center
  `width/2, height/2`).

### D. Testing

**Unit — `GraphModel`, Python (`pytest`) + TS (`vitest`), in lockstep:**

- reject reversed `data` edge (`Sprite.data → Texture.texture`);
- reject mistyped `child` edge (wrong ports / node types);
- accept the correct `data` and `child` edges (regression);
- reject `removeNode(root)`; reject a second `Root`;
- reachability helper flags an unparented Sprite and clears once parented.

**Unit — engine renderer (`vitest`):**

- new Sprite defaults anchor to `(0.5, 0.5)`; explicit `anchor` prop overrides;
- a correct `data` edge still binds the texture (regression).

**Playwright e2e — authoritative, deterministic.** Driven through the real
socket-dispatch path (`window.__gameApplyInbound`), replay backend, no LLM. New
`studio/frontend/e2e/scene-correctness.spec.ts`:

1. Build `root → sprite → texture` correctly → texture binds (`textureSizeOf > 64`)
   **and** the sprite renders centered on the stage.
2. Reversed `data` edge → **rejected**; nothing binds.
3. `removeNode(root)` → **rejected**; the tree stays intact.
4. **Incremental add** — build sprite A, then add sprite B without touching `root`
   → **both** present and rendered (A preserved). (The phoenix-then-leopard case.)
5. Orphan sprite (added without a parent edge) → not rendered, and the warning is
   surfaced.

Because this spec drives ops through the **engine's** GraphModel
(`__gameApplyInbound`), rejection assertions (cases 2, 3) observe the engine's
`error` ack — the cross-frame proof stays observable, consistent with the
existing `game-scene` spec's ack-counting. The **backend** GraphModel's matching
rejection is covered by the `pytest` unit tests above (lockstep guarantees both
reject identically).

**Optional live smoke** (`just e2e-live`, never CI): one real `/generate-sprite`
then `/design-scene` round, asserting the improved skill yields a parented,
correctly-bound, centered sprite against gpt-4o-mini.

## Rollout

- Work continues in the `fix/design-scene-wiring` worktree.
- spec → plan (`writing-plans`) → **subagent-driven** execution per repo
  convention (fresh implementer per task, review after each, whole-branch review).
- PR to `main`. Browser e2e runs locally (`just e2e`); the cheaper Python/TS unit
  suites run in CI.

## Risks / notes

- **Lockstep drift** is the top risk: the TS and Python `GraphModel` validations
  must match exactly, or the backend and engine disagree about what's valid. Every
  contract task touches both files and both test suites in the same change.
- **Anchor-0.5 is a semantic change** to existing scenes. Sweep fixtures/specs
  that positioned sprites assuming top-left anchoring and update them.
- The accumulated dev data in `bloom_studio_wt2` is unrelated test pollution; not
  in scope to clean up here.

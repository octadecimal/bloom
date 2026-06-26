# Interleaved scene composition — `generate_and_place`

**Date:** 2026-06-26
**Branch:** `feat/scene-interleave`
**Status:** approved (brainstorm)

## Problem

When a user asks the design-room agent to build a scene ("make a neon cyberpunk
arcade game with a skyline background, a logo at the top, a robot bottom-left, and
a crystal bottom-right"), the model emits **parallel tool calls**: all
`generate_asset` calls first, then all `add_sprite` calls. The result is that the
Game Scene snaps into existence all at once at the end of the turn, instead of
visibly building up element-by-element.

For demos, the element-by-element build-up *is* the point. The root cause is model
batching behavior, not a code bug — so prompt text alone cannot guarantee a fix:
even with perfect "do one element at a time" wording, the placements still land in
one final clump.

## Key insight (why a tool, not just prose)

PR #102 routes `generate_and_wait` through a **per-game generation queue**, so
generations serialize one-at-a-time even when the model fires them in parallel.

- **Prompt-only (rejected as sole fix):** assets *will* appear on the Asset Board
  one-by-one (queue serializes generation), but the **placements still batch at the
  end** → the scene does not build incrementally.
- **Combined tool (chosen):** a single `generate_and_place` call generates *then*
  places one element atomically. Even if the model fires N calls in parallel, the
  generation queue serializes them and each placement lands immediately after its
  own asset finishes → the scene reliably fills in one sprite at a time.

The combined tool also makes the router prose **simpler** (one atomic verb per
element instead of a two-step a/b dance), which is what keeps complex prompts
reliable long-term.

## Design

### 1. New tool: `generate_and_place`

In `studio/backend/app/agent_tools.py`. Parameters are the union of the two
existing tools:

- Generation: `description`, `style` (default `""`), `size` (default `"512x512"`),
  `transparent` (default `True`), `slot` (default `""`).
- Placement: `role`, `parent` (default `"root"`), `x`, `y`, `anchor_x`,
  `anchor_y`, `fit`, `z_index` — same defaults as `add_sprite`.

Behavior per call:

1. **Reuse-aware / idempotent.** If `slot` is given and already resolves to an
   asset with a selected image, **skip generation** and place the existing asset.
   Otherwise generate (`create_asset` → `generate_and_wait`) and place. This keeps
   today's "reuse a fitting asset instead of regenerating" intent, now enforced in
   code, and makes a re-run of the same build cheap (good for demo re-runs).
2. Place the resolved asset via the **same internals as `add_sprite`**.
3. Return one combined confirmation line, e.g.
   `Generated 'Skyline' and placed it as sprite 'spr.background'.` (and
   `Reused '…' and placed …` on the reuse path).

A `slot` is effectively required for the reuse handle and the sprite id; if no
`slot` is given the tool generates and places using the new asset's id as the
handle (mirrors `add_sprite`'s `handle = slot or asset.id`).

### 2. Refactor: shared placement helper (DRY)

Extract `add_sprite`'s placement body — resolve parent/canvas/root, `build_sprite_ops`,
`apply_batch`, orphan suffix — into a module-level helper:

```
async def _place_in_scene(ctx, *, handle, src, role, parent, x, y,
                          anchor_x, anchor_y, fit, z_index, tex_size) -> str
```

Both `add_sprite` and `generate_and_place` call it, so the two placement paths
never drift. The existing `tests/test_add_sprite_tool.py` suite is the safety net
for this extraction (its behavior must remain green unchanged).

### 3. Router branch 4 rewrite

In `studio/backend/app/gdd/router.py` (`_BODY_TEMPLATE`, branch 4). Replace the
two-step a/b instructions with a single per-element atomic instruction:

> For EACH visual element the user names, **in order**, call `generate_and_place`
> exactly once — it generates that element's art and immediately places it in the
> scene before you move to the next element. Complete one element fully before
> starting the next; do **not** generate all the assets up front. (Same placement
> conventions: background → `fit="cover"`, `z_index=0`; "centered at the top" →
> `y=0`, `anchor_y=0`, omit `x`.)

The **#106 text-free background guidance stays verbatim** — it now attaches to the
`generate_and_place` `description` arg (END a background description with "no text,
no words, no letters, no title, no logo, no UI"; never put the game name in the
background). `generate_asset` / `add_sprite` / `list_assets` remain bound for edge
cases (place an existing asset, or generate without placing).

### 4. Tool registration

Add `generate_and_place` to `ToolFactory._BUILDERS` and to the router spec's tool
set in `build_design_router_spec()`.

## Testing (TDD)

- **`tests/test_design_router.py`** (content tests on the router body):
  - body names `generate_and_place` and instructs strict per-element sequencing
    ("do not generate all" / "one element" / "before");
  - branch 4 no longer tells the model to call `add_sprite` directly (the compose
    path goes through `generate_and_place`);
  - the existing #106 text-free assertions still pass unchanged;
  - `generate_and_place` is in `build_design_router_spec().tools`.
- **`tests/test_generate_and_place_tool.py`** (new, mirrors
  `test_add_sprite_tool.py`):
  - one call generates once and applies one placement batch (parented + bound
    sprite, nothing orphaned) — against the real Mongo scene store;
  - reuse path: a slot that already has a selected image is **not** regenerated,
    only placed;
  - friendly errors carried through from the placement helper where applicable;
  - `ToolFactory` registers `generate_and_place`.
- **`tests/test_add_sprite_tool.py`** stays green unchanged (guards the helper
  extraction).

Backend tests: `cd studio/backend && uv run pytest` (mongod on :27017).

## Live verification

With the live stack on main (backend :8000, engine :4300, frontend :4200), in a
fresh room send: *"make a neon cyberpunk arcade game with a skyline background, a
logo at the top, a robot bottom-left, and a crystal bottom-right."* Expected: the
chat feed shows tool calls alternating `generate_and_place` → `generate_and_place`
… and the Game Scene pane (View → Game Scene) fills in one sprite at a time.

## Out of scope (YAGNI)

- Disabling parallel tool calls at the API level — the serialized generation queue
  already delivers the visible sequencing; not needed.
- Removing the granular `generate_asset` / `add_sprite` tools — kept for edge cases.
- Any change to symbol realization (`realize_symbol`) or non-scene branches.

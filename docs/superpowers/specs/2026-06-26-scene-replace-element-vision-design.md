# Replace any scene element via scene vision + in-place regenerate — design

## Problem

In a game design room, telling the agent to "replace the background with
something more sunny" creates a **second** `role="background"` sprite stacked on
the first, instead of repainting the existing background. Observed on a live
session: the scene graph ended with both `spr.background_mystic_mountains…` and a
new `spr.sunny_background`, both at `role="background"`, `z=0`.

### Root cause

Game-room plain chat runs the **`design-router`** skill
(`studio/backend/app/gdd/router.py`), which classifies each message into one of
several branches. Two matter here:

- **Branch 4 — create/place visual art** → calls `generate_and_place`, which
  adds a _new_ sprite.
- **Branch 5 — fix/redo/regenerate/replace an element already in the scene** →
  calls `regenerate_element`, which swaps the matched sprite's art **in place**
  and is documented to never duplicate.

"Replace the background with something more sunny" should hit branch 5. The live
model picked branch 4 and called `generate_and_place` with a new slot
(`sunny_background`), producing a duplicate background. Two compounding causes:

1. **The agent is blind to the scene.** The router's toolset has `list_assets`
   (the asset board) but **no tool to read the placed scene**. The agent cannot
   reliably tell what is already placed, nor resolve a natural reference like
   "the flower on the left" to a specific sprite. `regenerate_element` only
   surfaces a placed-element list _after_ a failed/ambiguous match.
2. **Routing leans on corrective phrasings.** Branch 5's trigger examples are all
   corrective ("it's cut off", "that's wrong, make it again", "redo the logo").
   A "replace **X** with a different look" phrasing reads like branch-4 "create
   new art," and branch 4 has no guard that says "if this element already exists,
   regenerate it instead."

`regenerate_element` already performs the correct in-place swap. The fix is to
let the agent **see** the scene and **route** replace-style requests to it.

## Goals

- "Replace/change/swap **X** with **a new look**" — where X is any element
  already in the scene, addressed by **name or position** — repaints that one
  sprite in place. No duplicate.
- The agent can resolve natural references ("the background", "the flower on the
  left") to the exact sprite by reading the scene.

## Non-goals

- No background-specific or role-based structural de-duplication. Targeting is
  general (any element by reference), so a "singular role" rule would not
  generalize and is explicitly out of scope.
- No new spatial-reference parser in code (no hard-coded left/right/top
  vocabulary). The LLM resolves spatial references by reasoning over the real
  coordinates `read_scene` returns.
- No change to `regenerate_element`'s in-place swap mechanics, nor to
  `generate_and_place`'s generation/placement behavior.
- No frontend changes — the scene graph already renders whatever the engine doc
  holds.

## Design

### 1. New tool: `read_scene`

A read-only tool that lists what is currently placed so the agent can resolve a
reference before regenerating. One row per placed Sprite:

```
handle · role · bound asset name · position (x,y) · size (w×h) · z
```

Example:

```
read_scene() →
  background_mystic_mountains  bg    "Mystical coastal mountain…"  (640,360) 1280×720 z0
  fg_crystal_tidepools         prop  "Foreground crystal cluster"  (300,520) 360×360  z1
  fg_driftwood_arch            prop  "Ancient driftwood arch"      (980,300) 420×300  z1
```

- **Implementation:** reuse the existing `_placed_elements(document, assets)`
  helper (`agent_tools.py:591`), which already yields one `PlacedElement` per
  Sprite joined to its bound texture and board asset. Extend it to also carry the
  sprite's **position** (`props.position` → x,y) and **size** (the bound asset's
  intrinsic width×height). Optionally include `scale` and `zIndex` from `props`
  when present. `read_scene` formats these as the text block above.
- **Empty scene:** return `(nothing placed)`.
- **Binding:** add `read_scene` to the `design-router` skill's tool set
  (`build_design_router_spec().tools`). Register the builder in
  `ToolFactory._BUILDERS` under the name `read_scene`.
- The handle shown is the exact `ref` the agent passes to `regenerate_element`,
  so resolution is unambiguous (exact handle match).

### 2. Router prompt changes (`gdd/router.py`)

- **Branch 5 (regenerate/replace), broadened.** Trigger also on "replace / change
  / swap an existing element with a new look", addressed by **name or position**.
  New guidance: _when the reference is not an obvious exact handle, call
  `read_scene` first to identify the exact placed element, then call
  `regenerate_element` with that element's exact handle as `ref` and the new look
  as `description`._ Add two examples: "replace the background with something
  sunnier" and "replace the flower on the left with a red rose".
- **Branch 4 (create/place), guard added.** _If the user is changing something
  already in the scene rather than adding a brand-new element, do not
  `generate_and_place` (it adds a duplicate sprite) — handle it as a regenerate
  (branch 5). If unsure whether the element already exists, call `read_scene`._

### 3. `regenerate_element` — unchanged

It already matches `ref` against each placed element's handle/role/asset name and
swaps art in place via `_regenerate_and_rebind`, accepting a refined
`description`. Passing the exact handle from `read_scene` yields a unique match.
Its existing multi-match disambiguation message remains the fallback when the
agent passes a loose `ref`.

## Tradeoff (accepted)

Targeting is the agent reasoning over `read_scene`, not a mechanical guarantee.
This makes "replace X with Y" a **reliable** behavior rather than a hard
invariant that two backgrounds are impossible. This is the right call given the
goal is to address _any_ element by description; a deterministic role-dedup
backstop is a possible future addition, explicitly deferred.

## Testing

### Unit (pytest, `studio/backend`)

- `read_scene` lists each placed sprite with handle, role, bound asset name,
  position, and size for a built document; returns `(nothing placed)` for an
  empty scene. Reuses/extends `_placed_elements`.
- `ToolFactory` builds `read_scene`; the `design-router` spec binds it
  (`read_scene` in `spec.tools` and named in `spec.body`).
- Router-prose tests: branch 5 references `read_scene` and includes a spatial
  replace example ("flower on the left"); branch 4 carries the "already in the
  scene → do not duplicate" guard. (Extends `tests/test_design_router.py`.)

### e2e (replay, `studio/backend`, non-browser)

- A recorded run cassette for "replace the background with something sunnier"
  against a seeded scene that already has a background: assert the agent calls
  `read_scene` then `regenerate_element` (NOT `generate_and_place`), and the scene
  ends with exactly **one** `role="background"` sprite, repainted. This is the
  authoritative proof the original bug is fixed. (Mirrors the existing
  `tests/e2e/test_scene_regenerate.py` + `regenerate-seaweed` cassette pattern.)

## Files touched

- `studio/backend/app/agent_tools.py` — `build_read_scene_tool`; extend
  `PlacedElement`/`_placed_elements` with position + size; register `read_scene`
  in `ToolFactory._BUILDERS`.
- `studio/backend/app/gdd/router.py` — branch 5 broadening, branch 4 guard, bind
  `read_scene` in the spec tool set.
- `studio/backend/tests/test_read_scene_tool.py` (new), `tests/test_design_router.py`
  (extend), `tests/test_agent_tools.py` (registry), and a new e2e test + cassette
  under `tests/e2e/` + `tests/fixtures/replay/run/`.

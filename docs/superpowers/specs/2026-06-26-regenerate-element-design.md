# Regenerate a placed scene element (`regenerate_element`)

## Problem

The scene toolset can **add** art but cannot **replace** a freeform placed element.
When a user says _"regenerate the seaweed, it's cut off at the top,"_ the agent has
no "replace this placed element in place" verb, so it falls into the scene-compose
branch and **adds** a new sprite. Re-placing under the same `slot` (`spr.{slot}`) is
rejected by the `duplicate_id` guard (`graph_model.py`), so the agent picks a fresh
handle and the scene ends up with **two** sprites — the new art plus the stale
original orphaned in its original spot.

Three intents collide on one slot, and the toolset only handles the first two:

- **Build** (first time): generate + place new ✅ (`generate_and_place`)
- **Re-run build** (idempotent): slot already has art → reuse, no-op ✅
- **Regenerate / fix** ("redo it, it's cut off"): force new art, replace the
  _existing_ placed sprite ❌ — missing

The only true in-place replacement today is `realize_symbol`, which regenerates an
asset and rewrites its bound `Texture.src`. But it is hard-wired to GDD symbols
(reads `symbols-reels`, finds the sprite by `props.slot`), so it cannot replace a
background, logo, or a decorative prop like seaweed.

## Goal

A general **"replace a placed element"** capability that works for any placed
sprite, keeps its placement, and swaps only the art — with `realize_symbol`
refactored to share the same core.

## Design

### The verb split

Two single-purpose scene verbs:

- **`generate_and_place`** — _add_ a new element. Unchanged.
- **`regenerate_element`** — _replace in place_: regenerate the art and rewrite the
  existing sprite's bound `Texture.src`, **keeping the node** (position, scale,
  z-index, anchor unchanged).

```
ADD:     generate_and_place(slot=...)  -> new sprite
REPLACE: regenerate_element(ref=...)   -> swap tex src in place
```

Because the replace path issues a `setProp` on an existing Texture (never an
`addNode`), the `duplicate_id` collision that produced the double-seaweed cannot
occur.

### `regenerate_element(ref, description="")`

**Arguments**

- `ref` — fuzzy element reference, matched case-insensitively against each _placed_
  sprite's `{slot (derived from the `spr.{slot}` node id), role (`props.role`),
bound asset name}`.
- `description` — optional. When given, updates the asset's prompt (so a complaint
  like "it's cut off at the top" becomes a refined prompt, e.g. "full seaweed plant,
  fully within frame, not cropped"). When omitted, regenerates with the existing
  prompt for a fresh seed.

**Resolution outcomes**

- **1 match** → regenerate that element (mechanic below).
- **0 matches** → return a friendly message naming what _is_ placed, so the agent
  can retry with a better `ref`. Scene untouched.
- **2+ matches** → return the candidates **with their exact slots** so the agent
  disambiguates from conversation context (or asks the user) and re-calls with the
  precise slot. The tool never guesses; disambiguation goes back to the **agent**,
  not a forced human `ask_user_question` interrupt.

**Mechanic on a single match** (generalized `realize_symbol` steps 2–3):

1. Resolve the asset behind the sprite: derive the handle from the sprite id
   (`spr.{handle}`); try `get_by_slot(handle)`, falling back to `get_asset(handle)`
   for slot-less elements placed as `spr.{asset_id}`.
2. If `description` is given, `update_asset(prompt=…)`. Then `generate_and_wait`
   and select the newest generation.
3. One atomic `setProp` rewriting the bound Texture's `src` → the same sprite
   re-paints. No `addNode`.

The bound Texture is found via the `data` edge into the sprite's `texture` port
(same lookup `realize_symbol` uses today, generalized to resolve the sprite by id
convention / role rather than only `props.slot`).

### Shared core + `realize_symbol` refactor

Extract `_regenerate_and_rebind(asset, sprite_id, texture_id, new_prompt)` doing
steps 2–3 (update prompt, regenerate, select newest, `setProp` the texture `src`).

- `realize_symbol` keeps its GDD front-end (read `art_desc` from `symbols-reels`,
  resolve the sprite via `props.slot`), then calls the shared core. Its existing
  test suite must stay green — a parity guard on the refactor.
- `regenerate_element` uses the fuzzy resolver, then calls the shared core.

### Router branch

Add a branch to the `design-router` for **"fix / regenerate / redo / replace an
existing placed element"** — e.g. "regenerate the seaweed", "the logo is wrong,
redo it", "that's cut off, make it again". The branch:

- Calls `regenerate_element(ref, description?)`, translating the user's complaint
  into a refined `description` when they say what is wrong.
- Is explicitly distinguished from the scene-compose branch (which _adds_ new
  elements). Regenerate/redo/replace/fix of a thing already on screen → this branch;
  "add / make / place a new X" → compose branch.
- On a multi-match return, disambiguates from context or asks the user, then
  re-calls with the exact slot.

`regenerate_element` is added to the router's tool allowlist (alongside
`generate_and_place`, `add_sprite`, `generate_asset`, `list_assets`,
`realize_symbol`).

### Edge cases

- `ref` matches no placed element, or the matched sprite has no bound Texture →
  friendly message, scene untouched.
- Regeneration produces no image → error message, scene untouched.
- Disambiguation never guesses — it returns candidates with exact slots.

## Testing

TDD throughout.

- **Unit**
  - Resolver: fuzzy match against slot / role / asset name; 0, 1, and many
    matches; the many-match path returns exact slots.
  - `regenerate_element` happy path: asserts the **sprite node is unchanged** (same
    position/scale/z/anchor) and **only `tex.{handle}.src` changes** — no new nodes
    or edges added (node/edge counts constant).
  - `realize_symbol` refactor parity: the existing suite stays green against the
    shared core.
- **E2e (replay, authoritative)**
  - Compose a scene, then send "regenerate the seaweed" → the element's
    sprite/texture count stays at one, the Texture `src` changed, and the old node
    is not left orphaned (no duplicate). New replay cassette for the turn.

## Out of scope

- Repositioning / resizing during regenerate (keep-placement only; placement edits
  remain a separate explicit action).
- A standalone `list_scene` discovery tool (the fuzzy resolver enumerates placed
  sprites internally; exposing a scene-listing tool is deferred).
- Replacing multiple elements in one call.

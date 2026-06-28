# Asset Board → live game variant sync

**Date:** 2026-06-28
**Status:** Design approved, ready for plan

## Problem

Two Asset Board actions never reach the live client game:

1. **"Generate again"** (regenerate) appends a new variant and emits `asset_completed`
   to the asset room, but the bound scene `Texture` still points at the generation
   selected at placement time. The game does not update.
2. **Selecting a variant** updates `selected_generation_id` via REST but never rewrites
   the bound `Texture` or broadcasts a scene op. The game keeps showing the
   placement-time image.

Additionally, the variant-toggle strip is only rendered in `large` view mode, so in
small / medium / list there is no way to switch variants at all.

The agent chat path already does the right thing (`_regenerate_and_rebind` finds the
sprite by slot, regenerates, and rewrites the `Texture`'s `src` via
`scene_hub.apply_op`). The mechanism is proven; it is simply not wired to the board's
buttons, and there is no asset→texture back-reference for the board to use.

## Principle

**An asset's selected generation is the single source of truth for any scene Texture
bound to that asset.** Whenever the selection changes — by toggling a variant or by
regenerating (which auto-selects the new one) — every bound Texture's `src` is
rewritten and broadcast as a `scene_op`, so the live client reloads the texture
instantly. This reuses the existing `setProp src` → Pixi-reload path.

## Architecture

### 1. Texture carries its asset (`scene/compose.py::build_sprite_ops`)

Add an `asset_id` parameter; write `props.assetId` onto the `Texture` node alongside
`src`. Threaded through `agent_tools.py::_place_in_scene` → `add_sprite` /
`generate_and_place`, which already hold the resolved asset. This back-reference is
what makes rebinding robust and multi-placement-safe (the same asset placed in several
spots all update together).

### 2. Canonical rebinder (new helper in the `scene` package)

`rebind_asset_textures(game_id, asset)`:

- Read the scene document.
- Find every `Texture` whose `props.assetId == asset.id`. **Fallback** to the
  `tex.{slot}` / `tex.{assetId}` node-id convention for scenes placed before this
  change (so existing games keep working without a migration).
- Resolve the selected generation's `image_ref` (reuse the existing
  `_selected_media_ref` logic).
- Emit one `setProp src` op per matched Texture via `scene_hub`.
- No-op when the asset has no selected generation or is not placed in the scene.

This is the single rebind mechanism. The agent's existing slot-based
`_regenerate_and_rebind` is **converged** onto it: after regenerate + select, it calls
`rebind_asset_textures` instead of issuing its own `setProp`. Now that textures carry
`assetId`, the slot lookup becomes the legacy fallback inside the rebinder.

### 3. Variant toggle → scene (REST `POST /assets/{id}/select`)

After `asset_store.select_generation(...)`, call `rebind_asset_textures(asset.game_id,
asset)`. The board already reflects the new selection from the REST response; now the
game does too. (`app.state` exposes `scene_store` / `scene_hub`; `Asset.game_id`
exists.)

### 4. Regenerate → auto-select + scene (board socket path)

`AssetHub.request_generation` gains an `auto_select: bool` flag:

- The board's `generate_asset` socket handler passes `auto_select=True`. After the new
  generation lands in `_run`, select it (newest) and call the rebinder.
- The agent's `generate_and_wait` keeps `auto_select=False` — **no change to agent
  generation behavior**; the agent selects explicitly and rebinds via the converged
  helper.

`asset_completed` (already emitted) carries `selectedGenerationId = newest`, so the
board reflects the new selection through the existing `upsert` reducer. `AssetHub` gets
the rebinder (and the scene deps it needs) injected at construction.

### 5. Toggle reachable in every view mode (`viewConfig.ts` + `AssetCard.tsx`)

Set `showCandidates: true` for `small`, `medium`, and `large`, and render a compact
variant strip in `list` mode. The strip already wires to `selectGeneration`; clicking a
thumbnail now propagates to the game via path (3). Use compact sizing in small / list to
avoid clutter in the tight tiles.

## Data flow

**Toggle a variant**

```
click candidate → selectGeneration → REST /select
  → store.select_generation (selected_generation_id := chosen)
  → rebind_asset_textures → scene_op setProp src (room=game)
  → client engine reloads Texture → game shows the variant
  (board reflects selection from the REST response)
```

**Regenerate**

```
click "Generate again" → socket generate_asset (auto_select=True)
  → request_generation → _run → ComfyUI → add_generation
  → select newest → asset_completed (board updates, newest selected)
  → rebind_asset_textures → scene_op setProp src (room=game)
  → client engine reloads Texture → game shows the new variant
```

When the asset has not been placed in the scene, the rebinder is a no-op — board-only
assets regenerate and toggle without error.

## Error handling

- Rebinder no-ops when there is no selected generation or no bound Texture.
- Legacy scenes (no `assetId` on Texture): id-convention fallback (`tex.{slot}` /
  `tex.{assetId}`).
- Generation failure follows the existing error path (`asset_status` error, no rebind).

## Testing

Per repo policy: TDD for pure logic; Playwright e2e is the authoritative behavioral
contract and asserts the **observed end-state in the client**, never just dispatch.

- **Unit (backend):** `build_sprite_ops` writes `props.assetId`; `rebind_asset_textures`
  matches by `assetId` and by legacy id-convention, resolves the correct `image_ref`,
  and emits the expected `setProp` ops; no-op cases (no selection / not placed).
- **Backend e2e:** REST select emits a scene op with the chosen variant's `src`; socket
  regenerate auto-selects newest and emits a scene op with the new `src`; agent
  regenerate path still rebinds (converged helper) and its existing tests stay green.
- **Frontend unit:** `viewConfig` exposes candidates in all modes; `AssetCard` renders
  the strip and calls `selectGeneration` in each mode.
- **Playwright e2e (authoritative):** place an asset into the game, then:
  - regenerate on the board → assert the client iframe's bound `Texture.src` actually
    changes to the new generation;
  - select a different variant → `src` changes to that variant;
  - toggle back → `src` reverts.

## Out of scope

- Full reference-model textures (storing `assetId`+`generationId` and resolving to a URL
  client-side at render). Larger engine/runtime/replay change; not needed here.
- Per-placement variant overrides (different placements of one asset showing different
  variants). The model here is one selected generation per asset, shared by all
  placements.

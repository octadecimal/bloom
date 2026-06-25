---
name: design-scene
description: Build the game's on-screen scene as a live node graph from your
  description — a Root stage, Containers for layout, Sprites for symbols, and
  Textures bound to them — mutating the scene incrementally.
args:
  - { name: focus, type: string, required: false, description: 'Optionally focus on one part of the scene (e.g. the reels).' }
tools: [scene_add_node, scene_set_prop, scene_connect, scene_disconnect, scene_remove_node, scene_apply_batch, list_assets]
---

You build a slot game's visual scene as a node graph that renders live in the
preview. The graph has four node types: Root (the stage; props width, height,
background), Container (layout group; position, scale, rotation, alpha, visible),
Sprite (an image; position, scale, rotation, alpha, anchor, visible, zIndex), and
Texture (an image source; prop `src`). Edges are either `child` (parenting:
from_port 'children' → to_port 'parent') or `data` (bind a Texture to a Sprite:
from_port 'data' → to_port 'texture').

Choose **stable, semantic ids** you can address again later (e.g. `root`,
`reels`, `sym.r2c1`, `tex.oak`). Work incrementally — one op per change; never
rebuild the whole scene to adjust one thing.

Work in this order:

1. STAGE. Add the `root` Root node first, sizing it to the game (e.g. 1280×720).
   Everything else parents under it (directly or via Containers).

2. LAYOUT. Add Containers for the major regions (e.g. a `reels` container) and
   parent them to `root` with `child` edges. Position them with `scene_set_prop`.

3. SYMBOLS. Add Sprite nodes for the visible elements and parent them into their
   Containers. Use `scene_apply_batch` to build a repetitive group (e.g. a reel of
   5 symbols) atomically. For each symbol sprite, set `props.slot` to that symbol's
   GDD `slot`, and bind it (data edge) to a Texture whose `src` is that slot's asset
   media URL (match by `[slot=…]` in `list_assets`). Prefer one `scene_apply_batch`
   per reel/group.

4. TEXTURES. For each image, first call `list_assets` to see the Asset Board and
   copy the **media URL** of the asset you want. Add a Texture node whose `src` is
   that media URL (e.g. `/media/<game>/<asset>/<gen>.png`), then bind it to its
   Sprite with a `data` edge. If an asset shows `(no image yet)`, it has not been
   generated — pick another or skip its texture.

5. REFINE. Adjust positions, scale, alpha, and zIndex with `scene_set_prop`. If an
   op is Rejected, read the error code (e.g. unknown_node, cycle, already_parented),
   fix the cause, and retry. When the scene reads well, summarise what you built.

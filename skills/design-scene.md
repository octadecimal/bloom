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
Texture (an image source; prop `src`).

Edges have a **direction** the renderer depends on — the `from` and `to` nodes
are NOT interchangeable. Getting them backwards leaves the scene blank:

- **`child`** (parenting; builds the Pixi tree): from the **parent** node's
  `children` port → to the **child** node's `parent` port. The parent is the
  `from` node. Example — put a sprite on the stage:
  `scene_connect(type='child', from_node='root', from_port='children', to_node='sym.r1c1', to_port='parent')`.
- **`data`** (binds a Texture into a Sprite): from the **Texture** node's `data`
  port → to the **Sprite** node's `texture` port. **The Texture is always the
  `from` node, the Sprite always the `to` node** — never the reverse. Example:
  `scene_connect(type='data', from_node='tex.oak', from_port='data', to_node='sym.r1c1', to_port='texture')`.

**INVARIANT — every Sprite and Container MUST be parented** to `root` (directly
or through a Container that itself reaches `root`) with a `child` edge. A node
with no path to `root` is an orphan: it is created but never added to the stage,
so it renders nothing and the canvas stays blank. The moment you add a Sprite,
add its parenting `child` edge too — in the **same `scene_apply_batch`** as the
node whenever possible, so a node and its edges are never half-built.

Choose **stable, semantic ids** you can address again later (e.g. `root`,
`reels`, `sym.r2c1`, `tex.oak`). Work incrementally — one op per change; never
rebuild the whole scene to adjust one thing.

**`root` persists across turns — never remove or re-add it.** When extending a
scene in a follow-up turn, add only the NEW nodes and their edges; do not
call `scene_remove_node` on `root` or re-issue the `scene_add_node` for it.
Rebuilding existing nodes destroys the live scene and loses all prior state.

**Centering a Sprite.** A Sprite's `anchor` defaults to `0.5` (center of the
image). To place a sprite at the stage center set its position to
`(width/2, height/2)` — the anchor point sits at the position, so the image
is centered on that point. To place it at the top-left instead, set `anchor`
to `0` first, then position to `(0, 0)`.

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
   Sprite with a `data` edge (Texture `from` → Sprite `to`, as above). If an
   asset shows `(no image yet)`, it has not been
   generated — pick another or skip its texture.

5. REFINE. Adjust positions, scale, alpha, and zIndex with `scene_set_prop`. If an
   op is Rejected, read the error code (e.g. unknown_node, cycle, already_parented),
   fix the cause, and retry. When the scene reads well, summarise what you built.

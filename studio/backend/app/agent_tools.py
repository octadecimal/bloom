import json
from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool
from langgraph.types import interrupt

from app.gdd.store import GddEditError
from app.scene.document import OpError, unreachable_nodes, empty_document
from app.scene.compose import build_sprite_ops, DEFAULT_CANVAS
from app.scene.compose_loop import BuildElement, ComposeBounds, run_compose
from app.scene.critic import CritiqueRequest, EditParams
from app.simulator.targets import derive_target, TargetGap
from app.tuner.models import TuningParams


@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object
    gdd_store: object = None
    gdd_hub: object = None
    scene_store: object = None
    scene_hub: object = None
    sim_store: object = None
    tuner_store: object = None
    tuner_hub: object = None
    # Vision-compose Plan 4: the compose-loop orchestrator (compose_scene tool)
    # grades the rendered frame and edits placement. The critic judges; the
    # capture broker fetches the real engine frame (Plans 2 & 3).
    scene_critic: object = None
    capture_broker: object = None


def build_generate_asset_tool(ctx: ToolContext) -> BaseTool:
    async def generate_asset(
        description: str,
        style: str = "",
        size: str = "512x512",
        transparent: bool = True,
        slot: str = "",
    ) -> str:
        prompt = description if not style else f"{description}, {style} style"
        width, height = (int(x) for x in size.lower().split("x", 1))
        workflow = "schnell-transparent" if transparent else "schnell-opaque"
        asset = await ctx.asset_store.create_asset(
            ctx.game_id, description[:40] or "asset", prompt, width, height, workflow,
            slot=slot or None,
        )
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        tag = f" (slot {slot})" if slot else ""
        return f"Generated '{asset.name}' (asset {asset.id}){tag} and added it to the Asset Board."

    return StructuredTool.from_function(
        coroutine=generate_asset,
        name="generate_asset",
        description=(
            "Generate a game image from a text description and add it to the Asset Board. "
            "size is 'WIDTHxHEIGHT' (default 512x512); set transparent=false for an opaque "
            "background/scene. Pass slot='<id>' to tie a symbol's art to its design slot."
        ),
    )


def _selected_media_ref(asset) -> str | None:
    sel = getattr(asset, "selected_generation_id", None)
    if not sel:
        return None
    for g in getattr(asset, "generations", []) or []:
        if getattr(g, "id", None) == sel:
            return getattr(g, "image_ref", None)
    return None


def build_list_assets_tool(ctx: ToolContext) -> BaseTool:
    async def list_assets() -> str:
        assets = await ctx.asset_store.list_assets(ctx.game_id)
        if not assets:
            return "The Asset Board is empty."
        lines = []
        for a in assets:
            slot = getattr(a, "slot", None)
            head = f"- {a.id}: {a.name}"
            if slot:
                head += f" [slot={slot}]"
            elif getattr(a, "category", None):
                head += f" ({a.category})"
            ref = _selected_media_ref(a)
            lines.append(f"{head} — {ref}" if ref else f"{head} — (no image yet)")
        return "Assets on the board:\n" + "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=list_assets,
        name="list_assets",
        description="List the assets on the Asset Board for the current game: id, "
                    "name, category, and the image's media URL (use that URL as a "
                    "Texture's src). Assets with no generation show '(no image yet)'.",
    )


async def _place_in_scene(
    ctx: ToolContext, *, handle: str, src: str, role: str, parent: str,
    x: float | None, y: float | None, anchor_x: float, anchor_y: float,
    fit: str, z_index: int, tex_size: tuple[int, int],
) -> str:
    """Place an already-resolved asset image into the live scene as one atomic batch.

    Shared by add_sprite and generate_and_place so the two placement paths never
    drift. For the default 'root' parent the hub creates the Root idempotently UNDER
    ITS LOCK (so two parallel calls can't both emit `addNode root` and collide); the
    sprite batch never carries a Root op. A custom parent does not auto-create a Root
    — derive the canvas from a light read for centering. Returns the human message.
    """
    if parent == "root":
        info = await ctx.scene_hub.ensure_root(ctx.game_id, DEFAULT_CANVAS)
        parent_id = info["root_id"]
        canvas = info["canvas"]
    else:
        parent_id = parent
        doc = await ctx.scene_store.get_document(ctx.game_id) or empty_document()
        nodes = doc.get("nodes", {})
        root_id = next((nid for nid, n in nodes.items() if n.get("type") == "Root"), None)
        root_props = (nodes.get(root_id) or {}).get("props", {}) if root_id else {}
        canvas = (int(root_props.get("width", DEFAULT_CANVAS[0])),
                  int(root_props.get("height", DEFAULT_CANVAS[1])))

    ops = build_sprite_ops(
        handle=handle, src=src, role=role, parent_id=parent_id,
        ensure_root=False, canvas=canvas, tex_size=tex_size,
        x=x, y=y, anchor_x=anchor_x, anchor_y=anchor_y, fit=fit, z_index=z_index,
    )
    try:
        doc = await ctx.scene_hub.apply_batch(ctx.game_id, ops)
    except OpError as e:
        return f"Rejected ({e.code}): {e}"
    return f"Placed '{role or handle}' as sprite 'spr.{handle}'." + _orphan_suffix(doc)


def build_add_sprite_tool(ctx: ToolContext) -> BaseTool:
    async def add_sprite(
        slot: str = "",
        asset_id: str = "",
        role: str = "",
        parent: str = "root",
        x: float | None = None,
        y: float | None = None,
        anchor_x: float = 0.5,
        anchor_y: float = 0.5,
        fit: str = "none",
        z_index: int = 0,
    ) -> str:
        # resolve the asset by stable slot handle (preferred) or explicit id
        if slot:
            asset = await ctx.asset_store.get_by_slot(ctx.game_id, slot)
        elif asset_id:
            asset = await ctx.asset_store.get_asset(asset_id)
        else:
            return "Pass slot or asset_id to choose which asset to place."
        if asset is None:
            ref = slot or asset_id
            return f"No asset for '{ref}'; generate it first."
        src = _selected_media_ref(asset)
        if not src:
            return f"Asset '{asset.name}' has no image yet; generate it before placing it."

        return await _place_in_scene(
            ctx, handle=slot or asset.id, src=src, role=role, parent=parent,
            x=x, y=y, anchor_x=anchor_x, anchor_y=anchor_y, fit=fit, z_index=z_index,
            tex_size=(int(getattr(asset, "width", 0)), int(getattr(asset, "height", 0))),
        )

    return StructuredTool.from_function(
        coroutine=add_sprite, name="add_sprite",
        description=(
            "Place an already-generated image asset into the live scene as a Sprite, "
            "creating its Texture and wiring both edges in ONE atomic step — do NOT add "
            "Texture nodes or edges yourself. Identify the asset by the same `slot` you "
            "passed to generate_asset (preferred), or by `asset_id`. Positioning is in "
            "the Root's pixel space: omit x to centre horizontally; for the top edge pass "
            "y=0 and anchor_y=0; for a full-bleed background pass fit='cover' and "
            "z_index=0. Pass a short role like 'background' or 'logo'. If the scene has no "
            "Root yet, one is created automatically."
        ),
    )


def build_generate_and_place_tool(ctx: ToolContext) -> BaseTool:
    async def generate_and_place(
        description: str = "",
        style: str = "",
        size: str = "512x512",
        transparent: bool = True,
        slot: str = "",
        role: str = "",
        parent: str = "root",
        x: float | None = None,
        y: float | None = None,
        anchor_x: float = 0.5,
        anchor_y: float = 0.5,
        fit: str = "none",
        z_index: int = 0,
    ) -> str:
        # 1. reuse: if the slot already holds an asset with a selected image, place
        #    it as-is instead of regenerating (idempotent re-runs of the same build).
        asset = None
        reused = False
        if slot:
            existing = await ctx.asset_store.get_by_slot(ctx.game_id, slot)
            if existing is not None and _selected_media_ref(existing):
                asset, reused = existing, True

        # 2. otherwise generate this one element's art now and wait for it (the
        #    per-game queue serializes generations even when many calls run at once).
        if asset is None:
            if not description:
                return ("Pass a description to generate the element, or a slot that "
                        "already has art to place.")
            prompt = description if not style else f"{description}, {style} style"
            width, height = (int(v) for v in size.lower().split("x", 1))
            workflow = "schnell-transparent" if transparent else "schnell-opaque"
            created = await ctx.asset_store.create_asset(
                ctx.game_id, description[:40] or "asset", prompt, width, height,
                workflow, slot=slot or None,
            )
            await ctx.asset_hub.generate_and_wait(ctx.game_id, created.id)
            asset = await ctx.asset_store.get_asset(created.id)

        # 3. place it immediately, so the scene fills in element-by-element.
        src = _selected_media_ref(asset) if asset else None
        if asset is None or not src:
            ref = slot or description[:40] or "asset"
            return f"Generation for '{ref}' produced no image; nothing placed."
        placement = await _place_in_scene(
            ctx, handle=slot or asset.id, src=src, role=role, parent=parent,
            x=x, y=y, anchor_x=anchor_x, anchor_y=anchor_y, fit=fit, z_index=z_index,
            tex_size=(int(getattr(asset, "width", 0)), int(getattr(asset, "height", 0))),
        )
        if placement.startswith("Rejected"):
            return placement
        verb = "Reused" if reused else "Generated"
        return f"{verb} '{asset.name}' and {placement[0].lower()}{placement[1:]}"

    return StructuredTool.from_function(
        coroutine=generate_and_place, name="generate_and_place",
        description=(
            "Generate ONE game image and immediately place it into the live scene as a "
            "Sprite — the atomic per-element verb for building a scene so it fills in "
            "element-by-element. Combines generate_asset + add_sprite: pass the "
            "generation args (description, size 'WxH', transparent, slot) AND the "
            "placement args (role, x, y, anchor_x, anchor_y, fit, z_index). If the slot "
            "already has art, it is reused instead of regenerated. Positioning is the "
            "Root's pixel space: omit x to centre; top edge → y=0, anchor_y=0; full-bleed "
            "background → transparent=false, fit='cover', z_index=0. Call once per element, "
            "in order; do NOT generate every asset first."
        ),
    )


def build_regenerate_element_tool(ctx: ToolContext) -> BaseTool:
    async def regenerate_element(ref: str, description: str = "") -> str:
        document = await ctx.scene_store.get_document(ctx.game_id)
        if not document or not document.get("nodes"):
            return "The scene is empty; there's nothing placed to regenerate."
        assets = await ctx.asset_store.list_assets(ctx.game_id)

        matches = _resolve_placed_elements(document, assets, ref)
        if not matches:
            return (f"No placed element matches '{ref}'. "
                    f"Placed: {_placed_summary(document, assets)}. "
                    f"Use one of those, or add it with generate_and_place.")
        if len(matches) > 1:
            opts = ", ".join(
                m.handle + (f" (role {m.role})" if m.role else "") for m in matches)
            return (f"'{ref}' matches several placed elements: {opts}. "
                    f"Call regenerate_element again with ref set to the exact one.")

        el = matches[0]
        if el.texture_id is None:
            return (f"'{el.handle}' is placed but has no bound texture to repaint; "
                    f"nothing regenerated.")
        asset = el.asset
        # slot-less elements are placed as spr.{asset_id}, so the handle may be a
        # slot (get_by_slot) or an asset id (get_asset) — try both.
        if asset is None:
            asset = (await ctx.asset_store.get_by_slot(ctx.game_id, el.handle)
                     or await ctx.asset_store.get_asset(el.handle))
        if asset is None:
            return (f"Matched '{el.handle}' in the scene, but its source asset isn't "
                    f"on the board; can't regenerate.")

        new_ref = await _regenerate_and_rebind(
            ctx, asset=asset, texture_id=el.texture_id,
            new_prompt=description or None)
        if new_ref is None:
            return (f"Regeneration for '{el.handle}' produced no image; "
                    f"the scene is unchanged.")
        return (f"Regenerated '{el.handle}' in place and re-rendered "
                f"the game.")

    return StructuredTool.from_function(
        coroutine=regenerate_element, name="regenerate_element",
        description=(
            "Regenerate an element that is ALREADY placed in the scene and swap its "
            "art IN PLACE — keeping its position, scale, and z-index. Use this for "
            "'regenerate/redo/replace/fix the <thing>' on something already on "
            "screen; do NOT use generate_and_place for that (it adds a duplicate). "
            "`ref` is matched fuzzily against each placed element's slot, role, and "
            "asset name. Pass a refined `description` to fix what was wrong (e.g. "
            "'not cropped at the top'); omit it to just re-roll the art. If several "
            "elements match, the tool returns the candidates — call again with the "
            "exact one."
        ),
    )


def build_adjust_element_tool(ctx: ToolContext) -> BaseTool:
    async def adjust_element(
        ref: str,
        x: float | None = None,
        y: float | None = None,
        scale: float | None = None,
        z: int | None = None,
    ) -> str:
        document = await ctx.scene_store.get_document(ctx.game_id)
        if not document or not document.get("nodes"):
            return "The scene is empty; there's nothing placed to adjust."
        assets = await ctx.asset_store.list_assets(ctx.game_id)

        matches = _resolve_placed_elements(document, assets, ref)
        if not matches:
            return (f"No placed element matches '{ref}'. "
                    f"Placed: {_placed_summary(document, assets)}. "
                    f"Use one of those, or add it with generate_and_place.")
        if len(matches) > 1:
            opts = ", ".join(
                m.handle + (f" (role {m.role})" if m.role else "") for m in matches)
            return (f"'{ref}' matches several placed elements: {opts}. "
                    f"Call adjust_element again with ref set to the exact one.")

        el = matches[0]
        ops: list[dict] = []
        changed: list[str] = []
        if x is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "position.x", "value": x})
            changed.append(f"x={x:g}")
        if y is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "position.y", "value": y})
            changed.append(f"y={y:g}")
        if scale is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "scale.x", "value": scale})
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "scale.y", "value": scale})
            changed.append(f"scale={scale:g}")
        if z is not None:
            ops.append({"kind": "setProp", "id": el.sprite_id,
                        "path": "zIndex", "value": int(z)})
            changed.append(f"z={int(z)}")
        if not ops:
            return "Pass at least one of x, y, scale, or z to adjust."

        try:
            doc = await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return (f"Adjusted '{el.handle}': {', '.join(changed)}." + _orphan_suffix(doc))

    return StructuredTool.from_function(
        coroutine=adjust_element, name="adjust_element",
        description=(
            "MOVE, RESIZE, or REORDER an element ALREADY placed in the scene "
            "WITHOUT changing its art. Use this for pure layout fixes — 'move the "
            "logo up', 'make the captain smaller', 'bring the chest to the front'. "
            "`ref` is matched against each placed element's slot/role/asset name. "
            "Pass any of: x, y (Root pixel position of the element's anchor), scale "
            "(absolute uniform scale: 1.0 = the asset's native size, 0.4 = 40% of native; omit to keep current scale), z (z-index; higher draws on "
            "top). Omit a field to leave it unchanged. Prefer this over "
            "regenerate_element for anything that's just mispositioned or mis-sized — "
            "regeneration makes a different image, this keeps the same art."
        ),
    )


class _SceneComposeDeps:
    """Real `ComposeDeps` for `run_compose`: reuses the existing placement,
    listing, transform, regenerate, capture, and critic seams. No new node
    walking or Mongo writes — every method delegates to a merged seam."""

    def __init__(self, ctx: ToolContext):
        self._ctx = ctx
        # Build the sub-verbs once; each is a StructuredTool we ainvoke.
        self._place_tool = build_generate_and_place_tool(ctx)
        self._adjust_tool = build_adjust_element_tool(ctx)
        self._regen_tool = build_regenerate_element_tool(ctx)

    async def _elements(self) -> list:
        document = await self._ctx.scene_store.get_document(self._ctx.game_id)
        if not document or not document.get("nodes"):
            return []
        assets = await self._ctx.asset_store.list_assets(self._ctx.game_id)
        return _placed_elements(document, assets)

    async def place(self, element: BuildElement) -> str:
        return await self._place_tool.ainvoke(element.model_dump())

    async def placed_handles(self) -> list[str]:
        return [el.handle for el in await self._elements()]

    async def scene_context(self) -> dict:
        out = []
        for el in await self._elements():
            name = getattr(el.asset, "name", None) or "(unbound)"
            out.append({
                "handle": el.handle, "role": el.role, "asset": name,
                "x": el.position[0] if el.position else None,
                "y": el.position[1] if el.position else None,
                "w": el.size[0] if el.size else None,
                "h": el.size[1] if el.size else None,
                "z": el.z_index,
            })
        return {"elements": out}

    async def capture(self) -> bytes:
        return await self._ctx.capture_broker.request_capture(
            self._ctx.game_id, timeout=ComposeBounds().capture_timeout)

    async def critique(self, request: CritiqueRequest):
        return await self._ctx.scene_critic.critique(request)

    async def adjust(self, handle: str, params: EditParams) -> str:
        return await self._adjust_tool.ainvoke({
            "ref": handle, "x": params.x, "y": params.y,
            "scale": params.scale, "z": params.z})

    async def regenerate(self, handle: str) -> str:
        return await self._regen_tool.ainvoke({"ref": handle})


def build_compose_scene_tool(ctx: ToolContext) -> BaseTool:
    async def compose_scene(elements: list[dict], theme: str = "") -> str:
        if not elements:
            return "Pass at least one element to build."
        if ctx.scene_critic is None or ctx.capture_broker is None:
            return ("Compose loop unavailable: no critic/capture wired. "
                    "Place elements individually with generate_and_place.")
        build = [BuildElement(**e) for e in elements]
        deps = _SceneComposeDeps(ctx)
        result = await run_compose(build, theme, deps)
        head = (f"Composed {result.elements_placed} element(s) over "
                f"{result.passes} critique pass(es): {result.edits_applied} "
                f"edit(s) applied, {result.regens_spent} regeneration(s), "
                f"{result.rejected} edit(s) refused.")
        body = "\n".join(f"- {n}" for n in result.notes)
        return head + ("\n" + body if body else "")

    return StructuredTool.from_function(
        coroutine=compose_scene, name="compose_scene",
        description=(
            "BUILD a slot-game scene from a list of elements, composing them with "
            "a vision critic in the loop. Pass `elements` — an ordered list, one "
            "dict per visual element with the SAME fields as generate_and_place "
            "(description, slot, role, size 'WxH', transparent, x, y, anchor_x, "
            "anchor_y, fit, z_index) — and `theme` (the user's intent, e.g. "
            "'premium pirate slot'). For EACH element this generates+places it, "
            "then captures the real rendered frame and lets the critic move/scale/"
            "reorder (and, sparingly, regenerate) elements until the composition "
            "settles. Use this for ANY request to create or place new scene art — "
            "a whole build ('make a pirate game with a background and a logo') or a "
            "single add ('add a treasure chest bottom-right'). Do NOT use it to "
            "change something already on screen — that is adjust_element / "
            "regenerate_element."
        ),
    )


def build_read_scene_tool(ctx: ToolContext) -> BaseTool:
    async def read_scene() -> str:
        document = await ctx.scene_store.get_document(ctx.game_id)
        if not document or not document.get("nodes"):
            return "The scene is empty; nothing is placed yet."
        assets = await ctx.asset_store.list_assets(ctx.game_id)
        els = _placed_elements(document, assets)
        if not els:
            return "The scene is empty; nothing is placed yet."
        lines = []
        for el in els:
            name = getattr(el.asset, "name", None) or "(unbound)"
            pos = f"({el.position[0]:g},{el.position[1]:g})" if el.position else "(?,?)"
            size = f"{el.size[0]}x{el.size[1]}" if el.size else "?x?"
            role = f" {el.role}" if el.role else ""
            lines.append(f'- {el.handle}{role} "{name}" pos={pos} size={size} z={el.z_index}')
        return "Placed in the scene:\n" + "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=read_scene, name="read_scene",
        description=(
            "Read the current scene: every placed sprite with its handle, role, bound "
            "asset name, position (x,y), size (WxH) and z-index. Use this to find which "
            "element the user means — by name OR position, e.g. 'the flower on the left' "
            "— before changing it, then call regenerate_element with that exact handle "
            "as `ref`. Takes no arguments."
        ),
    )


def build_delete_asset_tool(ctx: ToolContext) -> BaseTool:
    async def delete_asset(asset_id: str) -> str:
        asset = await ctx.asset_store.get_asset(asset_id)
        if asset is None:
            return f"Asset {asset_id} not found; nothing deleted."
        label = f"Delete '{asset.name}' (id {asset_id}) — this can't be undone."
        decision = interrupt(
            {"tool": "delete_asset", "args": {"asset_id": asset_id}, "label": label}
        )
        if decision != "approve":
            return "Deletion denied by the user."
        await ctx.asset_store.delete_asset(asset_id)
        await ctx.asset_hub.notify_deleted(ctx.game_id, asset_id)
        return f"Deleted '{asset.name}' (id {asset_id}) from the Asset Board."

    return StructuredTool.from_function(
        coroutine=delete_asset,
        name="delete_asset",
        description=(
            "Delete an asset from the Asset Board by its id. This is destructive and "
            "irreversible; the studio will ask the human to approve before it runs."
        ),
    )


def build_list_gdd_docs_tool(ctx: ToolContext) -> BaseTool:
    async def list_gdd_docs() -> str:
        docs = await ctx.gdd_store.list_docs(ctx.game_id)
        if not docs:
            return "No GDD docs yet."
        lines = []
        for d in docs:
            lines.append(f"## {d.title} (aspect={d.aspect}, status={d.status})")
            lines.append(d.body or "(empty)")
        return "\n\n".join(lines)

    return StructuredTool.from_function(
        coroutine=list_gdd_docs, name="list_gdd_docs",
        description="List every GDD doc for the current game with its aspect, "
                    "status, and full markdown body.",
    )


def build_read_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def read_gdd_doc(aspect: str) -> str:
        from app.gdd.schemas import schema_for
        doc = await ctx.gdd_store.get_doc(ctx.game_id, aspect)
        if doc is None:
            return f"No GDD doc for aspect '{aspect}'."
        schema = schema_for(aspect)
        lines = [f"aspect={aspect} status={doc.status}", "fields:"]
        for f in schema:
            filled = doc.data.get(f.key) not in (None, "", [], {})
            req = " required" if f.required else ""
            lines.append(f"- {f.key} [{f.type}{req}]: {'set' if filled else 'EMPTY'}")
        missing = [
            f.key for f in schema
            if f.required and doc.data.get(f.key) in (None, "", [], {})
        ]
        if missing:
            lines.append("missing required: " + ", ".join(missing))
        return "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=read_gdd_doc, name="read_gdd_doc",
        description="Read one GDD aspect's structured fields and status. Shows each "
                    "field key, type, whether it is set, and which required fields are "
                    "still empty. Call before set_gdd_fields to learn the field keys.",
    )


def build_set_gdd_fields_tool(ctx: ToolContext) -> BaseTool:
    async def set_gdd_fields(aspect: str, fields: dict) -> str:
        try:
            doc, warnings = await ctx.gdd_hub.set_fields(ctx.game_id, aspect, fields)
        except GddEditError as e:
            return f"Could not update '{aspect}': {e}"
        msg = (f"Updated '{aspect}' ({', '.join(fields.keys())}); "
               f"status now {doc.status}.")
        if warnings:
            msg += " Warnings: " + "; ".join(warnings)
        return msg

    return StructuredTool.from_function(
        coroutine=set_gdd_fields, name="set_gdd_fields",
        description="Set one or more typed fields on a GDD aspect. 'fields' maps field "
                    "keys to values: numbers, percents ('96%'), ratios ('1:200'), enums, "
                    "lists, or table fields as a list of row objects (one key per column). "
                    "Only the keys you pass change. Read the doc first for the field keys.",
    )


def build_set_doc_status_tool(ctx: ToolContext) -> BaseTool:
    async def set_doc_status(aspect: str, status: str) -> str:
        await ctx.gdd_hub.set_status(ctx.game_id, aspect, status)
        return f"Set '{aspect}' status to {status}."

    return StructuredTool.from_function(
        coroutine=set_doc_status, name="set_doc_status",
        description="Set a GDD doc's status (empty|drafted|needs_input|complete) "
                    "without changing its body.",
    )


def build_ask_user_question_tool(ctx: ToolContext) -> BaseTool:
    async def ask_user_question(
        question: str,
        suggestions: list[str] = None,
        allow_free_text: bool = True,
        allow_delegate: bool = True,
        aspect: str = None,
    ) -> str:
        payload = {
            "kind": "question",
            "tool": "ask_user_question",
            "question": question,
            "suggestions": suggestions or [],
            "allowFreeText": allow_free_text,
            "allowDelegate": allow_delegate,
            "aspect": aspect,
        }
        answer = interrupt(payload)
        if isinstance(answer, dict) and answer.get("type") == "delegate":
            return ("The user delegated this decision to you. Use your best "
                    "judgment to choose, apply it, and note in the doc that you "
                    "made this call.")
        if isinstance(answer, dict):
            return str(answer.get("value", ""))
        return str(answer)

    return StructuredTool.from_function(
        coroutine=ask_user_question, name="ask_user_question",
        description="Ask the user ONE focused question to resolve a material "
                    "design gap. Provide 2-4 concrete suggestions. The run pauses "
                    "until the user picks one, types their own, or delegates "
                    "('you decide'). aspect is the related GDD doc aspect.",
    )


def _orphan_suffix(doc: dict) -> str:
    orphans = unreachable_nodes(doc)
    if not orphans:
        return ""
    return " ⚠ not parented to root (won't render): " + ", ".join(orphans)


def build_scene_add_node_tool(ctx: ToolContext) -> BaseTool:
    async def scene_add_node(node_id: str, type: str, props_json: str = "") -> str:
        try:
            props = json.loads(props_json) if props_json.strip() else {}
        except json.JSONDecodeError as e:
            return f"Invalid props_json: {e}"
        op = {"kind": "addNode", "id": node_id, "type": type, "props": props}
        try:
            doc = await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Added {type} node '{node_id}'." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=scene_add_node, name="scene_add_node",
        description="Add a scene node. type is Root|Container|Sprite|Texture. "
                    "node_id is a stable, semantic id you choose (e.g. 'reels', "
                    "'sym.r2c1'). props_json is an optional JSON object of initial "
                    "props (e.g. '{\"position\":{\"x\":100,\"y\":80}}').",
    )


def build_scene_set_prop_tool(ctx: ToolContext) -> BaseTool:
    async def scene_set_prop(node_id: str, path: str, value_json: str) -> str:
        try:
            value = json.loads(value_json)
        except json.JSONDecodeError as e:
            return f"Invalid value_json: {e}"
        op = {"kind": "setProp", "id": node_id, "path": path, "value": value}
        try:
            doc = await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Set {node_id}.{path}." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=scene_set_prop, name="scene_set_prop",
        description="Set one prop on a node. path supports nesting (e.g. "
                    "'position.x'). value_json is the JSON-encoded value "
                    "(e.g. '0.5', 'true', '{\"x\":10,\"y\":20}').",
    )


def build_scene_connect_tool(ctx: ToolContext) -> BaseTool:
    async def scene_connect(edge_id: str, type: str, from_node: str, from_port: str,
                            to_node: str, to_port: str) -> str:
        op = {"kind": "connect", "edgeId": edge_id, "type": type,
              "from": {"node": from_node, "port": from_port},
              "to": {"node": to_node, "port": to_port}}
        try:
            doc = await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Connected {edge_id} ({type})." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=scene_connect, name="scene_connect",
        description="Connect two nodes. type 'child' parents a node "
                    "(from_port='children', to_port='parent'); type 'data' binds a "
                    "Texture to a Sprite (from_port='data', to_port='texture').",
    )


def build_scene_disconnect_tool(ctx: ToolContext) -> BaseTool:
    async def scene_disconnect(edge_id: str) -> str:
        try:
            doc = await ctx.scene_hub.apply_op(ctx.game_id, {"kind": "disconnect", "edgeId": edge_id})
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Disconnected {edge_id}." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=scene_disconnect, name="scene_disconnect",
        description="Remove an edge by its id.",
    )


def build_scene_remove_node_tool(ctx: ToolContext) -> BaseTool:
    async def scene_remove_node(node_id: str) -> str:
        try:
            doc = await ctx.scene_hub.apply_op(ctx.game_id, {"kind": "removeNode", "id": node_id})
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Removed node '{node_id}' (and its edges)." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=scene_remove_node, name="scene_remove_node",
        description="Remove a node and all edges touching it.",
    )


def build_scene_apply_batch_tool(ctx: ToolContext) -> BaseTool:
    async def scene_apply_batch(ops_json: str) -> str:
        try:
            ops = json.loads(ops_json)
        except json.JSONDecodeError as e:
            return f"Invalid ops_json: {e}"
        if not isinstance(ops, list):
            return "ops_json must be a JSON array of op objects."
        try:
            doc = await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Applied {len(ops)} ops atomically." + _orphan_suffix(doc)

    return StructuredTool.from_function(
        coroutine=scene_apply_batch, name="scene_apply_batch",
        description="Apply many ops atomically (all-or-nothing). ops_json is a JSON "
                    "array of op objects matching the add/remove/setProp/connect/"
                    "disconnect shapes. Use for building a group (e.g. a reel of "
                    "symbols) in one step.",
    )


@dataclass
class PlacedElement:
    """A sprite that is placed in the scene, joined to its texture and asset."""
    sprite_id: str
    texture_id: str | None
    handle: str
    role: str
    asset: object | None
    src: str | None
    position: tuple[float, float] | None = None
    size: tuple[int, int] | None = None
    z_index: int = 0


def _texture_of(document: dict, sprite_id: str) -> str | None:
    """The Texture node id bound to a sprite's `texture` port, or None."""
    for e in document.get("edges", []):
        to = e.get("to") or {}
        if (e.get("type") == "data" and to.get("node") == sprite_id
                and to.get("port") == "texture"):
            return (e.get("from") or {}).get("node")
    return None


def _placed_elements(document: dict, assets: list) -> list[PlacedElement]:
    """One PlacedElement per Sprite node, joined to its bound texture and (by the
    handle derived from the `spr.{handle}` id, matched against asset slot or id)
    to an asset on the board."""
    nodes = document.get("nodes", {})
    out: list[PlacedElement] = []
    for nid, n in nodes.items():
        if n.get("type") != "Sprite":
            continue
        props = n.get("props") or {}
        handle = nid[len("spr."):] if nid.startswith("spr.") else nid
        role = props.get("role") or ""
        tex_id = _texture_of(document, nid)
        tex_node = nodes.get(tex_id) or {}
        src = (tex_node.get("props") or {}).get("src") if tex_id else None
        asset = next(
            (a for a in assets
             if getattr(a, "slot", None) == handle or getattr(a, "id", None) == handle),
            None,
        )
        pos = props.get("position") or {}
        position = (pos["x"], pos["y"]) if ("x" in pos and "y" in pos) else None
        z_index = int(props.get("zIndex", 0) or 0)
        size = None
        if asset is not None:
            w = getattr(asset, "width", None)
            h = getattr(asset, "height", None)
            if w and h:
                size = (int(w), int(h))
        out.append(PlacedElement(nid, tex_id, handle, role, asset, src,
                                 position=position, size=size, z_index=z_index))
    return out


def _resolve_placed_elements(document: dict, assets: list, ref: str) -> list[PlacedElement]:
    """Placed elements whose handle, role, or asset name contains `ref`
    (case-insensitive). An empty `ref` matches nothing."""
    needle = ref.strip().lower()
    if not needle:
        return []
    out = []
    for el in _placed_elements(document, assets):
        name = (getattr(el.asset, "name", "") or "").lower()
        if needle in el.handle.lower() or needle in el.role.lower() or needle in name:
            out.append(el)
    return out


def _placed_summary(document: dict, assets: list) -> str:
    """A short comma list of what is placed, for a no-match message."""
    els = _placed_elements(document, assets)
    if not els:
        return "(nothing placed)"
    return ", ".join(
        el.handle + (f" (role {el.role})" if el.role else "") for el in els
    )


def _find_symbol_sprite(document: dict, slot: str) -> tuple[str, str] | None:
    """Resolve (sprite_id, texture_node_id) for a slot, or None.

    The symbol Sprite carries props.slot==slot; its bound Texture is the source
    of the `data` edge into that sprite's `texture` port.
    """
    nodes = document.get("nodes", {})
    sprite_id = next(
        (nid for nid, n in nodes.items()
         if n.get("type") == "Sprite" and (n.get("props") or {}).get("slot") == slot),
        None,
    )
    if sprite_id is None:
        return None
    for e in document.get("edges", []):
        if e.get("type") == "data" and e["to"]["node"] == sprite_id and e["to"]["port"] == "texture":
            return sprite_id, e["from"]["node"]
    return None


async def _regenerate_and_rebind(
    ctx: ToolContext, *, asset, texture_id: str | None, new_prompt: str | None,
) -> str | None:
    """Regenerate an asset's art and rewrite a bound Texture's src in place.

    Updates the asset prompt (when ``new_prompt`` is truthy), regenerates and
    selects the newest generation, then issues ONE ``setProp`` writing the new
    ``image_ref`` into ``texture_id`` (skipped when ``texture_id is None``).
    Returns the new ``image_ref``, or ``None`` if regeneration produced no image
    — in which case the scene is left untouched.
    """
    if new_prompt:
        await ctx.asset_store.update_asset(asset.id, prompt=new_prompt)
    await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
    refreshed = await ctx.asset_store.get_asset(asset.id)
    if refreshed is None or not refreshed.generations:
        return None
    newest = refreshed.generations[-1]
    await ctx.asset_store.select_generation(asset.id, newest.id)
    if texture_id is not None:
        await ctx.scene_hub.apply_op(
            ctx.game_id,
            {"kind": "setProp", "id": texture_id, "path": "src",
             "value": newest.image_ref},
        )
    return newest.image_ref


def build_realize_symbol_tool(ctx: ToolContext) -> BaseTool:
    async def realize_symbol(slot: str) -> str:
        # 1. read the (already-updated) symbol art description from the GDD
        gdd = await ctx.gdd_store.get_doc(ctx.game_id, "symbols-reels")
        rows = (gdd.data.get("symbols") if gdd else None) or []
        row = next((r for r in rows if r.get("slot") == slot), None)
        if row is None:
            return f"No symbol with slot '{slot}' in the GDD; nothing to realize."
        art_desc = row.get("art_desc") or row.get("name") or slot

        # 2. resolve the slot's asset
        asset = await ctx.asset_store.get_by_slot(ctx.game_id, slot)
        if asset is None:
            return f"No asset tagged slot '{slot}'; generate it first."

        # 3. resolve the bound sprite/texture, then regenerate + rebind via the
        #    shared core. texture_id=None still regenerates the board art but skips
        #    the scene write, preserving the "regenerated but not placed" message.
        document = await ctx.scene_store.get_document(ctx.game_id)
        found = _find_symbol_sprite(document or {}, slot) if document else None
        texture_id = found[1] if found else None
        new_ref = await _regenerate_and_rebind(
            ctx, asset=asset, texture_id=texture_id, new_prompt=art_desc)
        if new_ref is None:
            return f"Regeneration for slot '{slot}' produced no image."
        if found is None:
            return (f"Regenerated slot '{slot}', but no scene Sprite is labeled "
                    f"with it; the rendered game was not updated.")
        return f"Reshaped symbol '{slot}': regenerated its art and re-rendered the game."

    return StructuredTool.from_function(
        coroutine=realize_symbol, name="realize_symbol",
        description=(
            "Realize a symbol design change on the rendered game. Given a symbol slot "
            "id (e.g. 'high1'), regenerate that symbol's art from its current GDD "
            "art_desc and rebind it in the scene so the game re-renders. Call AFTER "
            "editing the symbol's GDD row with set_gdd_fields."
        ),
    )


def build_read_tuner_setup_tool(ctx: ToolContext) -> BaseTool:
    async def read_tuner_setup() -> str:
        sim_doc = await ctx.sim_store.get_or_seed(ctx.game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        paytable = (model.get("paytable") or {}).get("entries") or []
        tuner_doc = await ctx.tuner_store.get_or_seed(ctx.game_id)
        p = tuner_doc.params

        gdd = await ctx.gdd_store.get_doc(ctx.game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            target = derive_target(math_model, sim_doc.params, num_bonuses)
            target_line = (
                f"target: RTP {target['rtp_target']} ±{target['rtp_tolerance']}, "
                f"volatility {target['volatility_min']}–{target['volatility_max']}, "
                f"{len(target['bonus_hit_rate_bands'])} bonus band(s)"
            )
        except TargetGap as gap:
            target_line = f"target: UNAVAILABLE — {gap.message}"

        result = tuner_doc.result
        if result is None:
            result_line = "last result: no tune has run yet"
        else:
            tuned = "a tuned model is pending Apply" if result.tuned_model else "no tuned model"
            result_line = f"last result: {result.status} ({tuned})"

        return (
            f"Seed model: {len(model.get('reels', []) or [])} reels, "
            f"{model.get('rows', '?')} rows, {len(paytable)} paytable entries, "
            f"{num_bonuses} bonus(es).\n"
            f"GA params: population {p.population}, generations {p.max_generations}, "
            f"search/final candidates {p.search_candidate_count}/{p.final_candidate_count}, "
            f"seed {p.master_seed}, weights rtp/vol/hit "
            f"{p.weights.rtp}/{p.weights.volatility}/{p.weights.hit_rate}.\n"
            f"{target_line}\n{result_line}"
        )

    return StructuredTool.from_function(
        coroutine=read_tuner_setup,
        name="read_tuner_setup",
        description=(
            "Report the slot-math tuner setup for the current game: the seed model "
            "shape, the GA parameters, the derived target bands (from GDD intent), and "
            "the last tune verdict. Read-only. Call this first before tuning."
        ),
    )


def build_set_tuner_params_tool(ctx: ToolContext) -> BaseTool:
    _POSITIVE = ("population", "max_generations", "search_candidate_count",
                 "final_candidate_count", "stagnation_window")

    async def set_tuner_params(
        master_seed: int | None = None,
        population: int | None = None,
        max_generations: int | None = None,
        search_candidate_count: int | None = None,
        final_candidate_count: int | None = None,
        elitism: int | None = None,
        mutation_rate: float | None = None,
        crossover_rate: float | None = None,
        stagnation_window: int | None = None,
        weight_rtp: float | None = None,
        weight_volatility: float | None = None,
        weight_hit_rate: float | None = None,
    ) -> str:
        scalars = {
            "master_seed": master_seed, "population": population,
            "max_generations": max_generations,
            "search_candidate_count": search_candidate_count,
            "final_candidate_count": final_candidate_count, "elitism": elitism,
            "mutation_rate": mutation_rate, "crossover_rate": crossover_rate,
            "stagnation_window": stagnation_window,
        }
        for key in _POSITIVE:
            v = scalars[key]
            if v is not None and v <= 0:
                return f"'{key}' must be positive (got {v}); no change made."
        if elitism is not None and elitism < 0:
            return f"'elitism' must be >= 0 (got {elitism}); no change made."
        for rate_key, rate_val in (("mutation_rate", mutation_rate), ("crossover_rate", crossover_rate)):
            if rate_val is not None and not (0.0 <= rate_val <= 1.0):
                return f"'{rate_key}' must be between 0 and 1 (got {rate_val}); no change made."
        for w_key, w_val in (("weight_rtp", weight_rtp), ("weight_volatility", weight_volatility),
                              ("weight_hit_rate", weight_hit_rate)):
            if w_val is not None and w_val < 0:
                return f"'{w_key}' must be >= 0 (got {w_val}); no change made."

        doc = await ctx.tuner_store.get_or_seed(ctx.game_id)
        data = doc.params.model_dump()
        for key, v in scalars.items():
            if v is not None:
                data[key] = v
        weights = dict(data["weights"])
        if weight_rtp is not None:
            weights["rtp"] = weight_rtp
        if weight_volatility is not None:
            weights["volatility"] = weight_volatility
        if weight_hit_rate is not None:
            weights["hit_rate"] = weight_hit_rate
        data["weights"] = weights

        updated = TuningParams.model_validate(data)
        await ctx.tuner_store.put(ctx.game_id, params=updated)
        return (
            f"Updated tuner GA params: population {updated.population}, "
            f"generations {updated.max_generations}, seed {updated.master_seed}, "
            f"weights rtp/vol/hit "
            f"{updated.weights.rtp}/{updated.weights.volatility}/{updated.weights.hit_rate}."
        )

    return StructuredTool.from_function(
        coroutine=set_tuner_params,
        name="set_tuner_params",
        description=(
            "Adjust the genetic-algorithm tuning knobs (population, generations, "
            "candidate counts, master seed, and the rtp/volatility/hit_rate fitness "
            "weights). Only the fields you pass change. This does NOT set the design "
            "target (RTP / volatility / bonus rate) — that lives in the GDD math-model; "
            "edit it with set_gdd_fields instead."
        ),
    )


def build_tune_slot_model_tool(ctx: ToolContext) -> BaseTool:
    async def tune_slot_model() -> str:
        sim_doc = await ctx.sim_store.get_or_seed(ctx.game_id)
        model = sim_doc.model or {}
        num_bonuses = len(model.get("bonuses", []) or [])
        gdd = await ctx.gdd_store.get_doc(ctx.game_id, "math-model")
        math_model = getattr(gdd, "data", {}) if gdd is not None else {}
        try:
            derive_target(math_model, sim_doc.params, num_bonuses)   # gap pre-check
        except TargetGap as gap:
            return (f"Cannot tune: {gap.message}. Complete the GDD math-model intent "
                    f"(RTP, volatility, bonus rate) first, then tune again.")

        before = await ctx.tuner_store.get(ctx.game_id)
        before_ran = before.result.ran_at if (before and before.result) else None

        await ctx.tuner_hub.request_tune(ctx.game_id)   # runs GA, streams to the pane

        after = await ctx.tuner_store.get(ctx.game_id)
        result = after.result if after else None
        if result is None or result.ran_at == before_ran:
            return ("The tune did not produce a result — check the Tuner pane or the "
                    "backend logs for a failure.")

        m = result.metrics
        head = (f"measured RTP {m.rtp}, volatility {m.volatility}, "
                f"hit-frequency {m.hit_frequency}") if m else "no metrics"
        if result.status == "pass":
            return (f"Tuned to PASS — {head}. A tuned model is ready; say 'apply it' "
                    f"to write it into the slot model (a human confirms).")
        if result.status == "near_miss":
            misses = "; ".join(
                f"{x.metric} measured {x.measured}, needs {x.band_lo}–{x.band_hi}"
                for x in result.missed) or "see the Tuner pane"
            return (f"Tuned to NEAR-MISS — {head}. Missed: {misses}. Try raising "
                    f"candidate counts / generations, re-weighting, or relaxing the "
                    f"GDD intent, then tune again.")
        return f"Tuning failed: {result.failure or 'unknown error'}."

    return StructuredTool.from_function(
        coroutine=tune_slot_model,
        name="tune_slot_model",
        description=(
            "Run the genetic tuner on the current slot model toward the GDD design "
            "intent, to completion, and report the verdict (PASS / NEAR-MISS) with "
            "measured RTP, volatility, and hit-rates. Live convergence shows in the "
            "Tuner pane. Does NOT apply the result — use apply_tuned_model for that."
        ),
    )


def build_apply_tuned_model_tool(ctx: ToolContext) -> BaseTool:
    async def apply_tuned_model() -> str:
        doc = await ctx.tuner_store.get(ctx.game_id)
        tuned = doc.result.tuned_model if (doc and doc.result) else None
        if not tuned:
            return "No tuned model to apply yet — run a tune first."
        label = ("Apply the tuned model to the slot model? This overwrites the "
                 "current realization.")
        decision = interrupt(
            {"tool": "apply_tuned_model", "args": {}, "label": label})
        if decision != "approve":
            return "Apply declined by the user; the slot model is unchanged."
        await ctx.sim_store.put(ctx.game_id, model=tuned)
        return ("Applied the tuned model to the slot model. Re-curate (in the "
                "Simulator) to confirm it still passes.")

    return StructuredTool.from_function(
        coroutine=apply_tuned_model,
        name="apply_tuned_model",
        description=(
            "Apply the most recent tuned slot model into the game's slot model, "
            "overwriting the current realization. Destructive; the studio asks the "
            "human to approve before it runs. Call only after a tune produced a model."
        ),
    )


class ToolFactory:
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "add_sprite": build_add_sprite_tool,
        "generate_and_place": build_generate_and_place_tool,
        "regenerate_element": build_regenerate_element_tool,
        "adjust_element": build_adjust_element_tool,
        "compose_scene": build_compose_scene_tool,
        "read_scene": build_read_scene_tool,
        "delete_asset": build_delete_asset_tool,
        "list_gdd_docs": build_list_gdd_docs_tool,
        "read_gdd_doc": build_read_gdd_doc_tool,
        "set_gdd_fields": build_set_gdd_fields_tool,
        "set_doc_status": build_set_doc_status_tool,
        "ask_user_question": build_ask_user_question_tool,
        "scene_add_node": build_scene_add_node_tool,
        "scene_set_prop": build_scene_set_prop_tool,
        "scene_connect": build_scene_connect_tool,
        "scene_disconnect": build_scene_disconnect_tool,
        "scene_remove_node": build_scene_remove_node_tool,
        "scene_apply_batch": build_scene_apply_batch_tool,
        "realize_symbol": build_realize_symbol_tool,
        "read_tuner_setup": build_read_tuner_setup_tool,
        "set_tuner_params": build_set_tuner_params_tool,
        "tune_slot_model": build_tune_slot_model_tool,
        "apply_tuned_model": build_apply_tuned_model_tool,
    }

    def __init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None,
                 scene_store=None, scene_hub=None,
                 sim_store=None, tuner_store=None, tuner_hub=None):
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub
        self._scene_store = scene_store
        self._scene_hub = scene_hub
        self._sim_store = sim_store
        self._tuner_store = tuner_store
        self._tuner_hub = tuner_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]

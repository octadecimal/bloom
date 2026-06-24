import json
from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool
from langgraph.types import interrupt

from app.gdd.store import GddEditError
from app.scene.document import OpError


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


def build_generate_asset_tool(ctx: ToolContext) -> BaseTool:
    async def generate_asset(
        description: str,
        style: str = "",
        size: str = "512x512",
        transparent: bool = True,
    ) -> str:
        prompt = description if not style else f"{description}, {style} style"
        width, height = (int(x) for x in size.lower().split("x", 1))
        workflow = "schnell-transparent" if transparent else "schnell-opaque"
        asset = await ctx.asset_store.create_asset(
            ctx.game_id, description[:40] or "asset", prompt, width, height, workflow
        )
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        return f"Generated '{asset.name}' (asset {asset.id}) and added it to the Asset Board."

    return StructuredTool.from_function(
        coroutine=generate_asset,
        name="generate_asset",
        description=(
            "Generate a game image from a text description and add it to the Asset Board. "
            "size is 'WIDTHxHEIGHT' (default 512x512); set transparent=false for an opaque "
            "background/scene."
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
            head = f"- {a.id}: {a.name}" + (f" ({a.category})" if getattr(a, "category", None) else "")
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
        doc = await ctx.gdd_store.get_doc(ctx.game_id, aspect)
        if doc is None:
            return f"No GDD doc for aspect '{aspect}'."
        return f"status={doc.status}\n\n{doc.body or '(empty)'}"

    return StructuredTool.from_function(
        coroutine=read_gdd_doc, name="read_gdd_doc",
        description="Read one GDD doc's exact current markdown by aspect. "
                    "Always read before editing so old_string matches real text.",
    )


def build_write_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def write_gdd_doc(aspect: str, title: str, body: str,
                            status: str = "drafted") -> str:
        await ctx.gdd_hub.write_doc(ctx.game_id, aspect, title, body, status)
        return f"Wrote '{title}' (aspect {aspect}, status {status})."

    return StructuredTool.from_function(
        coroutine=write_gdd_doc, name="write_gdd_doc",
        description="Create or fully overwrite a GDD doc's markdown body. Use for "
                    "the initial draft of each aspect. status is one of "
                    "empty|drafted|needs_input|complete.",
    )


def build_edit_gdd_doc_tool(ctx: ToolContext) -> BaseTool:
    async def edit_gdd_doc(aspect: str, old_string: str, new_string: str,
                           replace_all: bool = False) -> str:
        try:
            await ctx.gdd_hub.edit_doc(ctx.game_id, aspect, old_string,
                                       new_string, replace_all)
        except GddEditError as e:
            return f"Edit failed: {e} Read the doc again and retry."
        return f"Edited '{aspect}'."

    return StructuredTool.from_function(
        coroutine=edit_gdd_doc, name="edit_gdd_doc",
        description="Surgically replace a unique block of a GDD doc. old_string "
                    "must match the current body exactly and uniquely (or set "
                    "replace_all=true). Prefer this over rewriting a whole doc.",
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


def build_scene_add_node_tool(ctx: ToolContext) -> BaseTool:
    async def scene_add_node(node_id: str, type: str, props_json: str = "") -> str:
        try:
            props = json.loads(props_json) if props_json.strip() else {}
        except json.JSONDecodeError as e:
            return f"Invalid props_json: {e}"
        op = {"kind": "addNode", "id": node_id, "type": type, "props": props}
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Added {type} node '{node_id}'."

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
            await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Set {node_id}.{path}."

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
            await ctx.scene_hub.apply_op(ctx.game_id, op)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Connected {edge_id} ({type})."

    return StructuredTool.from_function(
        coroutine=scene_connect, name="scene_connect",
        description="Connect two nodes. type 'child' parents a node "
                    "(from_port='children', to_port='parent'); type 'data' binds a "
                    "Texture to a Sprite (from_port='data', to_port='texture').",
    )


def build_scene_disconnect_tool(ctx: ToolContext) -> BaseTool:
    async def scene_disconnect(edge_id: str) -> str:
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, {"kind": "disconnect", "edgeId": edge_id})
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Disconnected {edge_id}."

    return StructuredTool.from_function(
        coroutine=scene_disconnect, name="scene_disconnect",
        description="Remove an edge by its id.",
    )


def build_scene_remove_node_tool(ctx: ToolContext) -> BaseTool:
    async def scene_remove_node(node_id: str) -> str:
        try:
            await ctx.scene_hub.apply_op(ctx.game_id, {"kind": "removeNode", "id": node_id})
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Removed node '{node_id}' (and its edges)."

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
            await ctx.scene_hub.apply_batch(ctx.game_id, ops)
        except OpError as e:
            return f"Rejected ({e.code}): {e}"
        return f"Applied {len(ops)} ops atomically."

    return StructuredTool.from_function(
        coroutine=scene_apply_batch, name="scene_apply_batch",
        description="Apply many ops atomically (all-or-nothing). ops_json is a JSON "
                    "array of op objects matching the add/remove/setProp/connect/"
                    "disconnect shapes. Use for building a group (e.g. a reel of "
                    "symbols) in one step.",
    )


class ToolFactory:
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
        "list_gdd_docs": build_list_gdd_docs_tool,
        "read_gdd_doc": build_read_gdd_doc_tool,
        "write_gdd_doc": build_write_gdd_doc_tool,
        "edit_gdd_doc": build_edit_gdd_doc_tool,
        "set_doc_status": build_set_doc_status_tool,
        "ask_user_question": build_ask_user_question_tool,
        "scene_add_node": build_scene_add_node_tool,
        "scene_set_prop": build_scene_set_prop_tool,
        "scene_connect": build_scene_connect_tool,
        "scene_disconnect": build_scene_disconnect_tool,
        "scene_remove_node": build_scene_remove_node_tool,
        "scene_apply_batch": build_scene_apply_batch_tool,
    }

    def __init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None,
                 scene_store=None, scene_hub=None):
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub
        self._scene_store = scene_store
        self._scene_hub = scene_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]

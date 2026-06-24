from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool
from langgraph.types import interrupt

from app.gdd.store import GddEditError


@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object
    gdd_store: object = None
    gdd_hub: object = None


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


def build_list_assets_tool(ctx: ToolContext) -> BaseTool:
    async def list_assets() -> str:
        assets = await ctx.asset_store.list_assets(ctx.game_id)
        if not assets:
            return "The Asset Board is empty."
        lines = [
            f"- {a.id}: {a.name}" + (f" ({a.category})" if getattr(a, 'category', None) else "")
            for a in assets
        ]
        return "Assets on the board:\n" + "\n".join(lines)

    return StructuredTool.from_function(
        coroutine=list_assets,
        name="list_assets",
        description="List the assets on the Asset Board (id, name, category) for the current game.",
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


class ToolFactory:
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
        "list_gdd_docs": build_list_gdd_docs_tool,
        "read_gdd_doc": build_read_gdd_doc_tool,
        "set_gdd_fields": build_set_gdd_fields_tool,
        "set_doc_status": build_set_doc_status_tool,
        "ask_user_question": build_ask_user_question_tool,
    }

    def __init__(self, asset_store, asset_hub, gdd_store=None, gdd_hub=None):
        self._asset_store = asset_store
        self._asset_hub = asset_hub
        self._gdd_store = gdd_store
        self._gdd_hub = gdd_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]

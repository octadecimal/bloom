from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool
from langgraph.types import interrupt


@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object


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
            return f"No asset with id {asset_id} not found; nothing deleted."
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


class ToolFactory:
    _BUILDERS = {
        "generate_asset": build_generate_asset_tool,
        "list_assets": build_list_assets_tool,
        "delete_asset": build_delete_asset_tool,
    }

    def __init__(self, asset_store, asset_hub):
        self._asset_store = asset_store
        self._asset_hub = asset_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]

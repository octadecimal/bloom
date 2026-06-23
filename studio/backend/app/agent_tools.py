from dataclasses import dataclass

from langchain_core.tools import BaseTool, StructuredTool


@dataclass
class ToolContext:
    room_id: str
    game_id: str
    asset_store: object
    asset_hub: object


def build_generate_asset_tool(ctx: ToolContext) -> BaseTool:
    async def generate_asset(description: str, style: str = "") -> str:
        prompt = description if not style else f"{description}, {style} style"
        asset = await ctx.asset_store.create_asset(
            ctx.game_id, description[:40] or "sprite", prompt, 512, 512, "schnell-transparent"
        )
        await ctx.asset_hub.generate_and_wait(ctx.game_id, asset.id)
        return f"Generated sprite '{asset.name}' (asset {asset.id}) and added it to the Asset Board."

    return StructuredTool.from_function(
        coroutine=generate_asset,
        name="generate_asset",
        description="Generate a game sprite image from a text description and add it to the Asset Board.",
    )


class ToolFactory:
    _BUILDERS = {"generate_asset": build_generate_asset_tool}

    def __init__(self, asset_store, asset_hub):
        self._asset_store = asset_store
        self._asset_hub = asset_hub

    def known_tool_names(self) -> set[str]:
        return set(self._BUILDERS)

    def build(self, allowlist, ctx: ToolContext) -> list[BaseTool]:
        return [self._BUILDERS[name](ctx) for name in allowlist if name in self._BUILDERS]

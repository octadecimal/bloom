# studio/backend/app/replay/record.py
import asyncio
import json
from pathlib import Path

from app.assets.comfy import ImageEvent, LiveComfyProvider, ProgressEvent
from app.assets.graph import build_graph
from app.config import get_settings
from app.providers import LiveOpenRouterProvider
from app.replay.cassette import DEFAULT_FIXTURES_DIR

LLM_PROMPT = "Reply with exactly: PONG"
COMFY_DIMS = (512, 512)
COMFY_WORKFLOW = "schnell-transparent"


async def _record_llm(settings, out: Path) -> None:
    provider = LiveOpenRouterProvider(settings.openrouter_api_key, settings.openrouter_base_url)
    chunks = [c async for c in provider.stream([{"role": "user", "content": LLM_PROMPT}], settings.default_model)]
    out.mkdir(parents=True, exist_ok=True)
    (out / "default.json").write_text(json.dumps({"prompt": LLM_PROMPT, "chunks": chunks}, indent=2))
    print(f"LLM cassette: {len(chunks)} chunks -> {''.join(chunks)!r}")


async def _record_comfy(settings, out: Path) -> None:
    provider = LiveComfyProvider(base_url=settings.comfyui_url)
    graph = build_graph(COMFY_WORKFLOW, "a glowing wild slot symbol, neon", *COMFY_DIMS, 42)
    progress: list[list[int]] = []
    image = b""
    async for ev in provider.generate(graph):
        if isinstance(ev, ProgressEvent):
            progress.append([ev.value, ev.max])
        elif isinstance(ev, ImageEvent):
            image = ev.data
    out.mkdir(parents=True, exist_ok=True)
    (out / "default.png").write_bytes(image)
    (out / "default.json").write_text(json.dumps({"progress": progress, "image": "default.png"}, indent=2))
    print(f"Comfy cassette: {len(progress)} ticks, {len(image)} image bytes")


async def _record_run(settings, out: Path) -> None:
    """Run the generate-sprite skill once (live) and capture the cassette."""
    from pathlib import Path as _Path
    from app.skills import SkillRegistry
    from app.agent_tools import ToolFactory, ToolContext
    from app.assets.store import AssetStore
    from app.assets.hub import AssetHub
    from app.assets.comfy import build_provider as build_comfy_provider
    from app.assets.media import MediaStore
    from app.assets.models import asset_wire
    from app.games import GameStore
    from app.turn_runner import TurnRunner, StepStarted, StepCompleted, StepToken, RunFinished
    from app.providers import build_chat_model
    from motor.motor_asyncio import AsyncIOMotorClient
    import socketio

    # We only capture the LLM-level cassette: tool_calls + final tokens.
    # Connect to the live LLM directly via the real build_chat_model.
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import HumanMessage
    from langgraph.prebuilt import create_react_agent
    from langchain_core.tools import StructuredTool

    # Build a minimal stub tool so the LLM can "call" it and we capture what it sends.
    tool_calls_recorded: list[dict] = []
    final_recorded: list[str] = []

    async def generate_asset_stub(description: str, style: str = "") -> str:
        tool_calls_recorded.append({"name": "generate_asset", "args": {"description": description, "style": style}})
        return f"Generated sprite '{description}' (stub) and added it to the Asset Board."

    stub_tool = StructuredTool.from_function(
        coroutine=generate_asset_stub,
        name="generate_asset",
        description="Generate a game sprite image from a text description and add it to the Asset Board.",
    )

    llm = ChatOpenAI(
        model=settings.default_model,
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        streaming=True,
    )

    system = (
        "You are a game-development assistant operating inside a studio. Be concise.\n\n"
        "You generate a single game sprite for the current game. Derive a clear, concrete\n"
        "image prompt from the user's description (and style, if given) and call the\n"
        "generate_asset tool exactly once. When it returns, confirm in one sentence what\n"
        "you created and that it was added to the Asset Board."
    )
    agent = create_react_agent(llm, [stub_tool], prompt=system)
    lc = [HumanMessage("Generate a knight sprite")]

    async for ev in agent.astream_events({"messages": lc}, version="v2"):
        kind = ev["event"]
        if kind == "on_chat_model_stream":
            chunk = ev["data"]["chunk"]
            delta = getattr(chunk, "content", "") or ""
            if delta:
                final_recorded.append(delta)

    cassette = {"tool_calls": tool_calls_recorded, "final": final_recorded}
    out.mkdir(parents=True, exist_ok=True)
    (out / "default.json").write_text(json.dumps(cassette, indent=2))
    print(
        f"Run cassette: {len(tool_calls_recorded)} tool call(s), "
        f"{len(final_recorded)} final token(s) -> {''.join(final_recorded)!r}"
    )


async def main() -> None:
    settings = get_settings()
    await _record_llm(settings, DEFAULT_FIXTURES_DIR / "llm")
    await _record_comfy(settings, DEFAULT_FIXTURES_DIR / "comfy")
    await _record_run(settings, DEFAULT_FIXTURES_DIR / "run")


if __name__ == "__main__":
    asyncio.run(main())

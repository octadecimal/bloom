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


async def main() -> None:
    settings = get_settings()
    await _record_llm(settings, DEFAULT_FIXTURES_DIR / "llm")
    await _record_comfy(settings, DEFAULT_FIXTURES_DIR / "comfy")


if __name__ == "__main__":
    asyncio.run(main())

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import AsyncIterator, Protocol

from app.config import Settings

FORCE_ERROR_PROMPT = "force error"  # normalized sentinel: an asset with this prompt makes replay raise


@dataclass
class ProgressEvent:
    value: int
    max: int


@dataclass
class ImageEvent:
    data: bytes


ComfyEvent = ProgressEvent | ImageEvent


class ComfyProvider(Protocol):
    def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]: ...


class ReplayComfyProvider:
    """Replays a recorded-real generation: captured progress ticks then a real PNG.

    Construct directly with in-memory data (unit tests), or via from_dir() to
    lazy-load a cassette on first generate() — so the app can boot in replay
    mode before the fixtures are recorded.
    """

    def __init__(
        self,
        progress: list[tuple[int, int]] | None = None,
        image: bytes | None = None,
        delay: float = 0.05,
        *,
        fixtures_dir: "Path | None" = None,
    ):
        self._progress = progress
        self._image = image
        self._delay = delay
        self._dir = fixtures_dir

    @classmethod
    def from_dir(cls, fixtures_dir: Path, delay: float = 0.05) -> "ReplayComfyProvider":
        return cls(delay=delay, fixtures_dir=fixtures_dir)

    def _ensure_loaded(self) -> None:
        if self._dir is not None:
            from app.replay.cassette import load_comfy_cassette
            self._progress, self._image = load_comfy_cassette(self._dir)
            self._dir = None

    async def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]:
        self._ensure_loaded()
        from app.replay.cassette import normalize_prompt
        positive = graph.get("6", {}).get("inputs", {}).get("text", "")
        if normalize_prompt(positive) == FORCE_ERROR_PROMPT:
            raise RuntimeError("forced replay error")
        for value, maximum in self._progress:
            if self._delay:
                await asyncio.sleep(self._delay)
            yield ProgressEvent(value=value, max=maximum)
        yield ImageEvent(data=self._image)


class LiveComfyProvider:
    """Submits a graph to ComfyUI, relays progress, then yields the produced image.

    Protocol (ComfyUI 0.25.x): POST /prompt {prompt, client_id} -> {prompt_id};
    a websocket at /ws?clientId=<id> emits {"type":"progress","data":{"value","max"}}
    and {"type":"executing","data":{"node":null,"prompt_id":...}} when done; the image
    filename comes from GET /history/<prompt_id> and bytes from
    GET /view?filename=&subfolder=&type=output.
    """

    def __init__(self, base_url: str):
        self._base = base_url.rstrip("/")

    async def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]:
        import json
        from uuid import uuid4

        import httpx
        import websockets

        client_id = uuid4().hex
        async with httpx.AsyncClient(base_url=self._base, timeout=None) as http:
            ws_url = self._base.replace("http", "ws", 1) + f"/ws?clientId={client_id}"
            async with websockets.connect(ws_url) as ws:
                resp = await http.post("/prompt", json={"prompt": graph, "client_id": client_id})
                resp.raise_for_status()
                prompt_id = resp.json()["prompt_id"]

                async for raw in ws:
                    if isinstance(raw, bytes):
                        continue
                    msg = json.loads(raw)
                    if msg.get("type") == "progress":
                        d = msg["data"]
                        yield ProgressEvent(value=int(d["value"]), max=int(d["max"]))
                    elif msg.get("type") == "executing" and msg["data"].get("node") is None \
                            and msg["data"].get("prompt_id") == prompt_id:
                        break

            hist = (await http.get(f"/history/{prompt_id}")).json()[prompt_id]
            images = [
                img
                for out in hist["outputs"].values()
                for img in out.get("images", [])
            ]
            last = images[-1]
            params = {"filename": last["filename"], "subfolder": last.get("subfolder", ""), "type": last.get("type", "output")}
            img_resp = await http.get("/view", params=params)
            img_resp.raise_for_status()
            yield ImageEvent(data=img_resp.content)


def build_provider(settings: Settings) -> ComfyProvider:
    from app.replay.cassette import DEFAULT_FIXTURES_DIR
    if settings.provider_mode == "replay":
        # Use lazy loading so the app starts even before Task 6 records the fixture files.
        # The cassette is loaded on the first generate() call.
        return ReplayComfyProvider.from_dir(DEFAULT_FIXTURES_DIR, delay=0.05)
    return LiveComfyProvider(base_url=settings.comfyui_url)

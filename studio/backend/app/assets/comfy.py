import asyncio
import base64
from dataclasses import dataclass
from typing import AsyncIterator, Protocol

from app.config import Settings

# Minimal valid 1x1 transparent PNG.
FAKE_PNG: bytes = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42m"
    "NkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


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


class FakeComfyProvider:
    """Deterministic provider for tests/CI: a few progress ticks then a PNG. No GPU."""

    def __init__(self, ticks: int = 2, delay: float = 0.0):
        self._ticks = ticks
        self._delay = delay

    async def generate(self, graph: dict) -> AsyncIterator[ComfyEvent]:
        for i in range(1, self._ticks + 1):
            if self._delay:
                await asyncio.sleep(self._delay)
            yield ProgressEvent(value=i, max=self._ticks)
        yield ImageEvent(data=FAKE_PNG)


class RealComfyProvider:
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
    if settings.comfy_backend == "fake":
        return FakeComfyProvider()
    return RealComfyProvider(base_url=settings.comfyui_url)

import asyncio
import base64

import pytest

from app.scene.capture import SceneCaptureBroker, _decode_png
from app.scene.sockets import register_scene_handlers


class _FakeSio:
    def __init__(self):
        self.emits = []
        self.handlers = {}

    def on(self, event):
        def deco(fn):
            self.handlers[event] = fn
            return fn

        return deco

    async def emit(self, event, data=None, **kw):
        self.emits.append((event, data, kw))

    async def enter_room(self, *a, **k): ...
    async def leave_room(self, *a, **k): ...


def _url(raw: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(raw).decode()


def test_decode_png_strips_data_url_prefix_and_accepts_bare_base64():
    raw = b"\x89PNG\r\n\x1a\n-bytes"
    assert _decode_png(_url(raw)) == raw
    assert _decode_png(base64.b64encode(raw).decode()) == raw


@pytest.mark.asyncio
async def test_request_capture_emits_request_and_resolves_with_decoded_png():
    sio = _FakeSio()
    broker = SceneCaptureBroker(sio)
    task = asyncio.create_task(broker.request_capture("g1", timeout=5))
    await asyncio.sleep(0)  # let the coroutine emit + register its future

    event, data, _ = sio.emits[-1]
    assert event == "scene_capture_request"
    assert data["gameId"] == "g1"
    capture_id = data["captureId"]

    raw = b"\x89PNGframe-bytes"
    broker.resolve_capture(capture_id, _url(raw))
    assert await task == raw


@pytest.mark.asyncio
async def test_request_capture_times_out_when_no_result_arrives():
    broker = SceneCaptureBroker(_FakeSio())
    with pytest.raises(asyncio.TimeoutError):
        await broker.request_capture("g1", timeout=0.05)


def test_resolve_unknown_capture_id_is_a_no_op():
    broker = SceneCaptureBroker(_FakeSio())
    broker.resolve_capture("nope", _url(b"x"))  # must not raise


@pytest.mark.asyncio
async def test_scene_capture_result_handler_resolves_the_broker():
    sio = _FakeSio()
    broker = SceneCaptureBroker(sio)

    class _Hub:  # join/leave/apply handlers are registered too but unused here
        async def attach(self, *a, **k): ...
        async def apply_op(self, *a, **k): ...

    register_scene_handlers(sio, _Hub(), broker)
    assert "scene_capture_result" in sio.handlers

    task = asyncio.create_task(broker.request_capture("g1", timeout=5))
    await asyncio.sleep(0)
    capture_id = sio.emits[-1][1]["captureId"]

    raw = b"PNGpayload"
    await sio.handlers["scene_capture_result"]("sid", {"captureId": capture_id, "png": _url(raw)})
    assert await task == raw

import asyncio

from app.agent_tools import ToolContext, _SceneComposeDeps


class _Broker:
    def __init__(self, result=None, exc=None):
        self._result = result
        self._exc = exc
        self.calls = 0

    async def request_capture(self, game_id, *, timeout=10.0):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return self._result


def _deps(**ctx_kwargs):
    ctx = ToolContext("r", "g", None, None, scene_store=object(), **ctx_kwargs)
    return _SceneComposeDeps(ctx)


def test_capture_none_when_no_broker():
    deps = _deps(capture_broker=None, scene_art_critic=object())
    assert asyncio.run(deps.capture_real_frame()) is None


def test_capture_none_when_no_art_critic():
    deps = _deps(capture_broker=_Broker(result=b"png"), scene_art_critic=None)
    assert asyncio.run(deps.capture_real_frame()) is None


def test_capture_returns_bytes_when_answered():
    deps = _deps(capture_broker=_Broker(result=b"realpng"), scene_art_critic=object())
    assert asyncio.run(deps.capture_real_frame()) == b"realpng"


def test_capture_none_on_timeout():
    deps = _deps(capture_broker=_Broker(exc=asyncio.TimeoutError()),
                 scene_art_critic=object())
    assert asyncio.run(deps.capture_real_frame()) is None

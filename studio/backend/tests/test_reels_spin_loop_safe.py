import asyncio
import sys

import pytest

from app.scene.reels_spin import _LoopSafeSpinRunner, build_spin_runner
from app.config import Settings


class Inner:
    def __init__(self):
        self.calls: list[tuple[dict, int]] = []

    async def run(self, model, seed):
        self.calls.append((model, seed))
        return {"grid": [[0]]}


@pytest.mark.asyncio
async def test_passthrough_on_subprocess_capable_loops():
    inner = Inner()
    out = await _LoopSafeSpinRunner(inner).run({"m": 1}, 7)
    assert out == {"grid": [[0]]}
    assert inner.calls == [({"m": 1}, 7)]


@pytest.mark.skipif(sys.platform != "win32", reason="SelectorEventLoop subprocess gap is Windows-only")
def test_selector_loop_is_marshalled_to_a_worker_proactor_loop():
    inner = Inner()
    loop = asyncio.SelectorEventLoop()
    try:
        out = loop.run_until_complete(_LoopSafeSpinRunner(inner).run({"m": 1}, 7))
    finally:
        loop.close()
    assert out == {"grid": [[0]]}


def test_build_spin_runner_is_wrapped():
    assert isinstance(build_spin_runner(Settings()), _LoopSafeSpinRunner)

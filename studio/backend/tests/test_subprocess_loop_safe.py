"""LoopSafeRunner: math subprocess runners must work even when the ambient
event loop cannot spawn subprocesses. Under `uvicorn --reload` on Windows the
app runs on a SelectorEventLoop (the reloader's socket handoff forces it), and
asyncio.create_subprocess_exec raises NotImplementedError there — the live
Generate/Verify crash of 2026-07-04. The wrapper routes the runner's coroutine
through a private Proactor loop on a worker thread in exactly that case."""
import asyncio
import sys

from app.subprocess_guard import LoopSafeRunner


class SubprocessInner:
    """Minimal stand-in for the real runners: spawns a subprocess via
    asyncio.create_subprocess_exec and reports progress via a sync callback."""

    async def run(self, on_progress, on_spawn=None):
        proc = await asyncio.create_subprocess_exec(
            sys.executable, "-c", "print('hi')",
            stdout=asyncio.subprocess.PIPE,
        )
        out, _ = await proc.communicate()
        on_progress(out.decode().strip())
        return "ok"


def _run_on_selector_loop(coro):
    """Drive a coroutine on an explicit SelectorEventLoop — the loop type the
    uvicorn --reload worker uses on Windows."""
    loop = asyncio.SelectorEventLoop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def test_selector_loop_reproduces_the_crash_without_the_wrapper():
    """The bug itself: on Windows a bare runner dies with NotImplementedError
    on a selector loop. (On POSIX selector loops can spawn subprocesses, so
    this repro is Windows-only by nature.)"""
    if sys.platform != "win32":
        return
    import pytest

    with pytest.raises(NotImplementedError):
        _run_on_selector_loop(SubprocessInner().run(lambda p: None))


def test_loop_safe_runner_spawns_subprocess_on_selector_loop():
    seen: list[str] = []
    result = _run_on_selector_loop(
        LoopSafeRunner(SubprocessInner()).run(seen.append))
    assert result == "ok"
    assert seen == ["hi"]


def test_loop_safe_runner_accepts_on_progress_as_keyword():
    """MathHub passes on_progress as a KEYWORD argument on both call sites —
    the wrapper must accept the hub's real call shape, not just positional."""
    seen: list[str] = []
    result = _run_on_selector_loop(
        LoopSafeRunner(SubprocessInner()).run(on_progress=seen.append))
    assert result == "ok"
    assert seen == ["hi"]


def test_loop_safe_runner_is_passthrough_on_subprocess_capable_loops():
    """On a loop that supports subprocesses the wrapper must not add a thread
    hop — the inner coroutine runs on the caller's own loop."""

    class LoopCapturingInner:
        async def run(self, on_progress, on_spawn=None):
            return asyncio.get_running_loop()

    async def main():
        return asyncio.get_running_loop(), await LoopSafeRunner(
            LoopCapturingInner()).run(lambda p: None)

    if sys.platform == "win32":
        loop = asyncio.ProactorEventLoop()
        try:
            outer, inner = loop.run_until_complete(main())
        finally:
            loop.close()
    else:
        outer, inner = asyncio.new_event_loop().run_until_complete(main())
    assert inner is outer

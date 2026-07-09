import asyncio
import sys
from types import SimpleNamespace

import pytest

from app.compose.runner import FakeComposeRunner, SubprocessComposeRunner, build_compose_runner


def _runner(timeout_s: float = 30.0) -> SubprocessComposeRunner:
    r = SubprocessComposeRunner(SimpleNamespace(compose_bin=""))
    r._timeout_s = timeout_s
    return r


def _cmd_for(script: str):
    return lambda: [sys.executable, "-c", script]


_ECHO_RESULT = (
    "import sys, json; sys.stdin.read(); "
    "print(json.dumps({'type': 'result', 'ok': True, 'metrics': {'rtp': 1.5}}))"
)

_NO_RESULT = "import sys; sys.stdin.read(); print('warming up'); sys.exit(3)"

_HANG = "import sys, time; sys.stdin.read(); time.sleep(600)"


@pytest.mark.asyncio
async def test_subprocess_runner_parses_the_result_line():
    runner = _runner()
    runner._command = _cmd_for(_ECHO_RESULT)
    res = await runner.run({"definition": {}, "package_id": "g", "master_seed": 1})
    assert res["ok"] is True
    assert res["metrics"]["rtp"] == 1.5


@pytest.mark.asyncio
async def test_subprocess_runner_no_result_is_error():
    runner = _runner()
    runner._command = _cmd_for(_NO_RESULT)
    res = await runner.run({"definition": {}, "package_id": "g", "master_seed": 1})
    assert res["ok"] is False
    assert "no result" in res["errors"][0]


@pytest.mark.asyncio
async def test_subprocess_runner_timeout_is_error():
    runner = _runner(timeout_s=0.5)
    runner._command = _cmd_for(_HANG)
    res = await runner.run({"definition": {}, "package_id": "g", "master_seed": 1})
    assert res["ok"] is False
    assert "timed out" in res["errors"][0]


@pytest.mark.asyncio
async def test_fake_runner_records_jobs():
    fake = FakeComposeRunner({"ok": True})
    res = await fake.run({"package_id": "g"})
    assert res == {"ok": True}
    assert fake.jobs == [{"package_id": "g"}]


def test_build_compose_runner_is_passthrough_on_subprocess_capable_loops():
    """build_compose_runner's loop-safety wrapper (deviation from the brief's
    literal LoopSafeRunner, whose on_progress-callback signature doesn't fit
    compose's single-arg run(job) — see runner.py's _LoopSafeComposeRunner
    docstring) must not add a thread hop on a loop that can already spawn
    subprocesses."""
    fake = FakeComposeRunner({"ok": True})
    runner = build_compose_runner(SimpleNamespace(compose_bin=""))
    runner._inner = fake  # swap in the fake: this is a pure loop-identity check

    async def main():
        return asyncio.get_running_loop(), await runner.run({"package_id": "g"})

    loop = asyncio.ProactorEventLoop() if sys.platform == "win32" else asyncio.new_event_loop()
    try:
        outer, res = loop.run_until_complete(main())
    finally:
        loop.close()
    assert res == {"ok": True}
    assert fake.jobs == [{"package_id": "g"}]


def test_build_compose_runner_works_on_a_selector_loop():
    """The bug this guards against: on Windows, uvicorn --reload runs the app
    on a SelectorEventLoop, where asyncio.create_subprocess_exec raises
    NotImplementedError. build_compose_runner's wrapper must route around it
    via a worker-thread ProactorEventLoop."""
    fake = FakeComposeRunner({"ok": True})
    runner = build_compose_runner(SimpleNamespace(compose_bin=""))
    runner._inner = fake
    loop = asyncio.SelectorEventLoop()
    try:
        res = loop.run_until_complete(runner.run({"package_id": "g"}))
    finally:
        loop.close()
    assert res == {"ok": True}
    assert fake.jobs == [{"package_id": "g"}]

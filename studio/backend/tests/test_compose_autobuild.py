import asyncio
import sys

import pytest

from app.compose.autobuild import AutoBuilder
from app.compose.jobs import SEED_COUNT, build_job, master_seed
from app.compose.runner import FakeComposeRunner, SubprocessComposeRunner
from app.config import Settings


class FakeSio:
    def __init__(self):
        self.emitted: list[tuple[str, dict, str | None]] = []

    async def emit(self, event, data, room=None, to=None):
        self.emitted.append((event, data, room))


def test_build_job_matches_the_rest_build_shape(tmp_path):
    settings = Settings(packages_dir="var/packages")
    job = build_job("g1", {"family": "composed@1"}, {"cols": 3}, settings)
    assert job["package_id"] == "g1"
    assert job["seed_count"] == SEED_COUNT
    assert job["master_seed"] == master_seed("g1")
    assert job["validate_only"] is False
    assert job["out_path"].endswith("g1.pkg")


@pytest.mark.asyncio
async def test_debounced_build_emits_building_then_done():
    runner = FakeComposeRunner({"ok": True, "metrics": {"rtp": 0.96}})
    sio = FakeSio()
    b = AutoBuilder(runner, Settings(), sio, debounce_s=0.01)
    b.schedule("g1", {"family": "composed@1"}, {})
    b.schedule("g1", {"family": "composed@1"}, {})  # coalesces with the first
    await asyncio.sleep(0.2)
    assert len(runner.jobs) == 1
    statuses = [(e, d["status"]) for e, d, _ in sio.emitted if e == "game_build_status"]
    assert statuses == [("game_build_status", "building"), ("game_build_status", "done")]
    done = sio.emitted[-1][1]
    assert done["packageId"] == "g1" and done["metrics"] == {"rtp": 0.96}


@pytest.mark.asyncio
async def test_failed_build_emits_error_status():
    runner = FakeComposeRunner({"ok": False, "errors": ["UnknownState"]})
    sio = FakeSio()
    b = AutoBuilder(runner, Settings(), sio, debounce_s=0.01)
    b.schedule("g1", {}, {})
    await asyncio.sleep(0.2)
    assert sio.emitted[-1][1]["status"] == "error"
    assert sio.emitted[-1][1]["errors"] == ["UnknownState"]


@pytest.mark.asyncio
async def test_invalid_game_id_is_never_built():
    runner = FakeComposeRunner({"ok": True})
    b = AutoBuilder(runner, Settings(), FakeSio(), debounce_s=0.01)
    b.schedule("../evil", {}, {})
    await asyncio.sleep(0.2)
    assert runner.jobs == []


class GatedRunner:
    """run() blocks on a caller-controlled event so a build can be held
    'in flight' (past debounce, awaiting the subprocess)."""

    def __init__(self, gate):
        self._gate = gate
        self.jobs: list[dict] = []

    async def run(self, job):
        self.jobs.append(job)
        await self._gate.wait()
        return {"ok": True, "metrics": {"n": len(self.jobs)}}


@pytest.mark.asyncio
async def test_in_flight_build_is_not_cancelled_and_newest_runs_after():
    gate = asyncio.Event()
    runner = GatedRunner(gate)
    sio = FakeSio()
    b = AutoBuilder(runner, Settings(), sio, debounce_s=0.01)
    b.schedule("g1", {"v": 1}, {})
    await asyncio.sleep(0.05)  # past debounce → build 1 is in flight
    assert len(runner.jobs) == 1
    b.schedule("g1", {"v": 2}, {})  # must NOT cancel the in-flight build
    await asyncio.sleep(0.05)
    assert len(runner.jobs) == 1  # build 2 is queued, not started
    gate.set()
    await asyncio.sleep(0.1)
    assert len(runner.jobs) == 2  # newest ran after the in-flight one finished
    assert runner.jobs[0]["definition"] == {"v": 1}
    assert runner.jobs[1]["definition"] == {"v": 2}
    statuses = [d["status"] for e, d, _ in sio.emitted if e == "game_build_status"]
    assert statuses == ["building", "done", "building", "done"]


@pytest.mark.asyncio
async def test_cancelled_subprocess_run_kills_the_process(monkeypatch):
    """A CancelledError while awaiting the compose subprocess must hard-kill it,
    not orphan it (an orphan can finish last and overwrite the newer .pkg)."""
    procs = []
    real = asyncio.create_subprocess_exec

    async def capture(*a, **k):
        p = await real(*a, **k)
        procs.append(p)
        return p

    monkeypatch.setattr(asyncio, "create_subprocess_exec", capture)

    runner = SubprocessComposeRunner(Settings())
    runner._command = lambda: [sys.executable, "-c", "import time; time.sleep(30)"]
    task = asyncio.create_task(runner.run({"x": 1}))
    while not procs:
        await asyncio.sleep(0.02)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert procs[0].returncode is not None  # killed and reaped, not orphaned

import asyncio
import sys

import pytest
from app.subprocess_guard import watch_proc_tree

_MEM_HOG = (
    "import time\n"
    "buf = []\n"
    "for _ in range(20):\n"
    "    buf.append(bytearray(20 * 1024 * 1024))\n"
    "    time.sleep(0.1)\n"
    "time.sleep(2)\n"
)
_SLEEPER = "import time\ntime.sleep(60)\n"
_QUICK = "pass\n"


async def _spawn(script: str):
    return await asyncio.create_subprocess_exec(
        sys.executable, "-c", script,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)


@pytest.mark.asyncio
async def test_watch_trips_on_memory():
    proc = await _spawn(_MEM_HOG)
    done = asyncio.Event()
    msg = await watch_proc_tree(
        proc, done, label="curation", mem_cap_mb=120.0, timeout_s=30.0, poll_s=0.05)
    await proc.wait()
    assert msg is not None and "memory" in msg.lower()


@pytest.mark.asyncio
async def test_watch_trips_on_wall_clock():
    proc = await _spawn(_SLEEPER)
    done = asyncio.Event()
    msg = await watch_proc_tree(
        proc, done, label="tuning", mem_cap_mb=8192.0, timeout_s=0.5, poll_s=0.05)
    await proc.wait()
    assert msg is not None and "wall-clock" in msg.lower()


@pytest.mark.asyncio
async def test_watch_returns_none_when_process_finishes():
    proc = await _spawn(_QUICK)
    done = asyncio.Event()
    # Drain + signal done when the child exits, like a real runner does.
    async def _drain():
        await proc.stdout.read()
        done.set()
    msg, _ = await asyncio.gather(
        watch_proc_tree(proc, done, label="curation",
                        mem_cap_mb=8192.0, timeout_s=30.0, poll_s=0.05),
        _drain())
    await proc.wait()
    assert msg is None

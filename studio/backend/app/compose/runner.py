"""Subprocess seam to the Rust compose_json bin (mirrors runners/curate.py,
minus streaming: compose emits exactly one result line)."""

import asyncio
import json
import sys
import threading
from typing import Protocol

from app.compose.templates import REPO_ROOT
from app.subprocess_guard import kill_proc_tree


class ComposeRunner(Protocol):
    async def run(self, job: dict) -> dict: ...


class SubprocessComposeRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "compose_bin", "") or ""
        self._timeout_s = float(getattr(settings, "compose_timeout_s", 180.0) or 180.0)

    def _command(self) -> list[str]:
        if self._bin:
            return [self._bin]
        # Dev/e2e default: cargo resolves+builds; its logs go to stderr.
        return ["cargo", "run", "--release", "-p", "bloom-simulator", "--bin", "compose_json"]

    async def run(self, job: dict) -> dict:
        proc = await asyncio.create_subprocess_exec(
            *self._command(),
            cwd=str(REPO_ROOT),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            out, err = await asyncio.wait_for(
                proc.communicate(json.dumps(job).encode()), timeout=self._timeout_s
            )
        except asyncio.TimeoutError:
            kill_proc_tree(proc.pid)
            await proc.wait()
            return {"ok": False, "errors": [f"compose timed out after {self._timeout_s}s"]}
        except asyncio.CancelledError:
            # Cancel (e.g. superseded build) must kill the subprocess, not
            # orphan it — an orphan can finish last and overwrite the newer .pkg.
            kill_proc_tree(proc.pid)
            await proc.wait()
            raise
        for line in out.decode().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") == "result":
                return obj
        return {
            "ok": False,
            "errors": [
                f"compose produced no result (exit {proc.returncode}): {err.decode()[:500]}"
            ],
        }


class FakeComposeRunner:
    def __init__(self, result: dict):
        self._result = result
        self.jobs: list[dict] = []

    async def run(self, job: dict) -> dict:
        self.jobs.append(job)
        return self._result


class _LoopSafeComposeRunner:
    """ComposeRunner-shaped analogue of subprocess_guard.LoopSafeRunner.

    That wrapper's `run(*args, on_progress=None, on_spawn=None)` signature
    assumes the curate/tune on-progress-callback call shape; compose's
    single-arg `run(job)` doesn't match it (its own `if on_progress is None:
    *args, on_progress = args` fallback would swallow `job` as `on_progress`),
    so it's reused conceptually, not literally (see task-6 brief). Same
    mechanism as the original: under `uvicorn --reload` on Windows the app
    runs on a SelectorEventLoop, which cannot asyncio-spawn a subprocess, so
    the inner coroutine is driven on a private ProactorEventLoop in a worker
    thread; on subprocess-capable loops this is a pure passthrough.
    """

    def __init__(self, inner):
        self._inner = inner

    async def run(self, job: dict) -> dict:
        loop = asyncio.get_running_loop()
        if not (sys.platform == "win32" and isinstance(loop, asyncio.SelectorEventLoop)):
            return await self._inner.run(job)

        result: list[dict] = []
        error: list[BaseException] = []
        ready = asyncio.Event()

        def worker():
            inner_loop = asyncio.ProactorEventLoop()
            try:
                result.append(inner_loop.run_until_complete(self._inner.run(job)))
            except BaseException as exc:  # surfaced on the caller's loop below
                error.append(exc)
            finally:
                inner_loop.close()
                loop.call_soon_threadsafe(ready.set)

        threading.Thread(target=worker, daemon=True, name="loop-safe-compose-runner").start()
        await ready.wait()
        if error:
            raise error[0]
        return result[0]


def build_compose_runner(settings) -> ComposeRunner:
    return _LoopSafeComposeRunner(SubprocessComposeRunner(settings))

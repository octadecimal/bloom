"""Server-side reels round: pick a model, evaluate one round via the trusted
kernel binary `spin_json`, and shape it for the runtime reels module.

The declaration's grid shape and the round's grid shape both derive from the
same SlotModel, so the outcome always fills the projected grid."""
import asyncio
import json
import shutil
import sys
import tempfile
import threading
from pathlib import Path
from typing import Protocol
from app.subprocess_guard import watch_proc_tree

# Repo root = .../app/scene/reels_spin.py -> parents[4]. Verify on first run.
_REPO_ROOT = Path(__file__).resolve().parents[4]


def derive_reels_config(model: dict) -> dict:
    reels = model.get("reels") or []
    cols = len(reels) if reels else 5
    rows = int(model.get("rows") or 3)
    symbols = [str(s["id"]) for s in (model.get("symbols") or [])]
    if not symbols:
        symbols = [str(i) for i in range(5)]
    return {"cols": cols, "rows": rows, "symbols": symbols, "parentId": "root"}


def map_grid(numeric_grid: list[list[int]]) -> list[list[str]]:
    return [[str(s) for s in reel] for reel in numeric_grid]


class SpinRunner(Protocol):
    async def run(self, model: dict, seed: int) -> dict: ...


class SubprocessSpinRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "spin_bin", "") or ""
        self._mem_cap_mb = float(getattr(settings, "curation_mem_cap_mb", 1024.0) or 1024.0)
        self._timeout_s = float(getattr(settings, "curation_timeout_s", 120.0) or 120.0)

    def _command(self, model_path: str, seed: int) -> list[str]:
        if self._bin:
            return [self._bin, model_path, str(seed)]
        return ["cargo", "run", "--release", "-p", "bloom-simulator",
                "--bin", "spin_json", "--", model_path, str(seed)]

    async def run(self, model: dict, seed: int) -> dict:
        tmp = Path(tempfile.mkdtemp(prefix="bloom-spin-"))
        try:
            model_path = str(tmp / "model.json")
            Path(model_path).write_text(json.dumps(model))
            proc = await asyncio.create_subprocess_exec(
                *self._command(model_path, seed),
                cwd=str(_REPO_ROOT),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            result: dict | None = None
            guard_trip: str | None = None
            done = asyncio.Event()

            async def _drain() -> None:
                nonlocal result
                assert proc.stdout is not None
                async for raw in proc.stdout:
                    line = raw.decode().strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if "grid" in obj:
                        result = obj
                done.set()

            async def _watchdog() -> None:
                nonlocal guard_trip
                guard_trip = await watch_proc_tree(
                    proc, done, label="spin",
                    mem_cap_mb=self._mem_cap_mb,
                    timeout_s=self._timeout_s, poll_s=0.1)

            assert proc.stderr is not None
            _, stderr_bytes, _ = await asyncio.gather(_drain(), proc.stderr.read(), _watchdog())
            await proc.wait()

            if guard_trip is not None:
                raise RuntimeError(f"spin killed by watchdog: {guard_trip}")
            if result is None:
                raise RuntimeError(
                    f"spin produced no result (exit {proc.returncode}): {stderr_bytes.decode()[:300]}")
            return result
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class FakeSpinRunner:
    def __init__(self, *, result: dict):
        self._result = result

    async def run(self, model: dict, seed: int) -> dict:
        return self._result


class _LoopSafeSpinRunner:
    """SpinRunner analogue of compose/runner._LoopSafeComposeRunner: under
    `uvicorn --reload` on Windows the app runs on a SelectorEventLoop, which
    cannot asyncio-spawn a subprocess (scene Spin died with NotImplementedError);
    drive the inner coroutine on a private ProactorEventLoop in a worker thread.
    Pure passthrough on subprocess-capable loops."""

    def __init__(self, inner):
        self._inner = inner

    async def run(self, model: dict, seed: int) -> dict:
        loop = asyncio.get_running_loop()
        if not (sys.platform == "win32" and isinstance(loop, asyncio.SelectorEventLoop)):
            return await self._inner.run(model, seed)

        result: list[dict] = []
        error: list[BaseException] = []
        ready = asyncio.Event()

        def worker():
            inner_loop = asyncio.ProactorEventLoop()
            try:
                result.append(inner_loop.run_until_complete(self._inner.run(model, seed)))
            except BaseException as exc:  # surfaced on the caller's loop below
                error.append(exc)
            finally:
                inner_loop.close()
                loop.call_soon_threadsafe(ready.set)

        threading.Thread(target=worker, daemon=True, name="loop-safe-spin-runner").start()
        await ready.wait()
        if error:
            raise error[0]
        return result[0]


def build_spin_runner(settings) -> SpinRunner:
    return _LoopSafeSpinRunner(SubprocessSpinRunner(settings))

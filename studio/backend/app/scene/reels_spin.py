"""Server-side reels round: pick a model, evaluate one round via the trusted
kernel binary `spin_json`, and shape it for the runtime reels module.

The declaration's grid shape and the round's grid shape both derive from the
same SlotModel, so the outcome always fills the projected grid."""
import asyncio
import json
import shutil
import tempfile
from pathlib import Path
from typing import Protocol
from app.subprocess_guard import watch_proc_tree

# A valid slots@1 model used when a game has no realized SlotModel yet, so the
# feature is demoable before a GDD->realize/tune cycle. 3 reels x 3 rows.
DEMO_SLOT_MODEL: dict = {
    "symbols": [
        {"id": 0, "role": "normal"},
        {"id": 1, "role": "normal"},
        {"id": 2, "role": "normal"},
        {"id": 9, "role": "scatter"},
    ],
    "reels": [
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
        [0, 1, 2, 0, 1, 2, 9, 0, 1, 2],
    ],
    "rows": 3,
    "paylines": [[0, 0, 0], [1, 1, 1], [2, 2, 2]],
    "paytable": {"entries": [
        {"symbol": 0, "count": 3, "payout": 5},
        {"symbol": 1, "count": 3, "payout": 3},
        {"symbol": 2, "count": 3, "payout": 2},
    ]},
    "bonuses": [],
}

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
    return [[str(s) for s in col] for col in numeric_grid]


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
                await watch_proc_tree(proc, done, label="spin",
                                      mem_cap_mb=self._mem_cap_mb,
                                      timeout_s=self._timeout_s, poll_s=0.1)

            assert proc.stderr is not None
            _, stderr_bytes, _ = await asyncio.gather(_drain(), proc.stderr.read(), _watchdog())
            await proc.wait()
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


def build_spin_runner(settings) -> SpinRunner:
    return SubprocessSpinRunner(settings)

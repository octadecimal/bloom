"""Invoke bloom-simulator's curate_json binary as a subprocess, parsing its NDJSON
progress + result stream. A FakeCurationRunner backs unit tests."""
import asyncio
import json
import shutil
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

from app.simulator.models import CurationResult, MetricsWire
from app.subprocess_guard import watch_proc_tree


@dataclass
class CurationProgress:
    phase: str
    done: int | None = None
    total: int | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_result_line(line: str, *, ran_at: str) -> CurationResult:
    d = json.loads(line)
    metrics = MetricsWire(
        rtp=d["rtp"], volatility=d["volatility"], hit_frequency=d["hitFrequency"],
        base_rtp=d["baseRtp"], feature_rtp=d["featureRtp"],
        bonus_hit_rates=d.get("bonusHitRates", []),
    )
    return CurationResult(
        status=d["status"], metrics=metrics,
        realized_rtp=d.get("realizedRtp"), pool_size=d.get("poolSize"),
        failure=d.get("failure"), ran_at=ran_at,
    )


class CurationRunner(Protocol):
    async def run(self, model: dict, target: dict,
                  on_progress: Callable[[CurationProgress], None]) -> CurationResult: ...


# Repo root = .../app/simulator/runner.py -> parents[4]. Verify on first run.
_REPO_ROOT = Path(__file__).resolve().parents[4]


class SubprocessCurationRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "simulator_bin", "") or ""
        # Runaway guard: a degenerate realized model can drive the kernel's
        # free-spins retrigger into unbounded memory. The watchdog polls the
        # subprocess tree and hard-kills it if either bound is crossed.
        self._mem_cap_mb = float(getattr(settings, "curation_mem_cap_mb", 1024.0) or 1024.0)
        self._timeout_s = float(getattr(settings, "curation_timeout_s", 120.0) or 120.0)
        self._poll_s = 0.1

    def _command(self, model_path: str, target_path: str, pkg_path: str) -> list[str]:
        if self._bin:
            return [self._bin, model_path, target_path, "studio-curation", pkg_path]
        # Dev/e2e default: cargo resolves+builds; its own logs go to stderr.
        return ["cargo", "run", "--release", "-p", "bloom-simulator",
                "--bin", "curate_json", "--", model_path, target_path,
                "studio-curation", pkg_path]

    async def run(self, model, target, on_progress) -> CurationResult:
        ran_at = _now_iso()
        tmp = Path(tempfile.mkdtemp(prefix="bloom-curation-"))
        try:
            model_path = str(tmp / "model.json")
            target_path = str(tmp / "target.json")
            pkg_path = str(tmp / "out.pkg")
            Path(model_path).write_text(json.dumps(model))
            Path(target_path).write_text(json.dumps(target))

            proc = await asyncio.create_subprocess_exec(
                *self._command(model_path, target_path, pkg_path),
                cwd=str(_REPO_ROOT),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            result: CurationResult | None = None
            guard_trip: str | None = None
            done = asyncio.Event()

            async def _drain_stdout() -> None:
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
                    if obj.get("type") == "progress":
                        on_progress(CurationProgress(
                            phase=obj["phase"], done=obj.get("done"), total=obj.get("total")))
                    elif obj.get("type") == "result":
                        result = parse_result_line(line, ran_at=ran_at)
                done.set()

            async def _watchdog() -> None:
                nonlocal guard_trip
                guard_trip = await watch_proc_tree(
                    proc, done, label="curation",
                    mem_cap_mb=self._mem_cap_mb, timeout_s=self._timeout_s,
                    poll_s=self._poll_s)

            assert proc.stderr is not None
            _, stderr_bytes, _ = await asyncio.gather(
                _drain_stdout(), proc.stderr.read(), _watchdog())
            await proc.wait()

            if guard_trip is not None:
                return CurationResult(
                    status="error",
                    metrics=MetricsWire(rtp=0, volatility=0, hit_frequency=0,
                                        base_rtp=0, feature_rtp=0, bonus_hit_rates=[]),
                    realized_rtp=None, pool_size=None,
                    failure=guard_trip, ran_at=ran_at,
                )
            if result is None:
                return CurationResult(
                    status="error",
                    metrics=MetricsWire(rtp=0, volatility=0, hit_frequency=0,
                                        base_rtp=0, feature_rtp=0, bonus_hit_rates=[]),
                    realized_rtp=None, pool_size=None,
                    failure=f"simulator produced no result (exit {proc.returncode}): {stderr_bytes.decode()[:500]}",
                    ran_at=ran_at,
                )
            return result
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class FakeCurationRunner:
    def __init__(self, *, progress: list[CurationProgress], result: CurationResult):
        self._progress = progress
        self._result = result

    async def run(self, model, target, on_progress) -> CurationResult:
        for p in self._progress:
            on_progress(p)
        return self._result


def build_curation_runner(settings) -> CurationRunner:
    return SubprocessCurationRunner(settings)

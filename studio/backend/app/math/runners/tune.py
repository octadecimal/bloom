"""Invoke bloom-tuner's tune_json binary as a subprocess, parsing its NDJSON
per-generation progress + final result stream. A FakeTunerRunner backs unit tests."""
import asyncio
import json
import shutil
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Protocol

from app.math.models import (
    BandMissWire, GenSnapshotWire, HistogramBinWire, MetricsWire, MetricSEWire,
    PopulationStatsWire, RtpPointWire, RunProfileWire, TailWire, TuneResult,
    WinDistributionWire,
)
from app.subprocess_guard import LoopSafeRunner, watch_proc_tree, kill_proc_tree


def _empty_population() -> PopulationStatsWire:
    return PopulationStatsWire(min=0.0, q1=0.0, median=0.0, q3=0.0, max=0.0, mean=0.0, diversity=0.0)


@dataclass
class TuneProgress:
    generation: int
    max_generations: int
    best_fitness: float
    best_rtp: float
    best_volatility: float
    # Enriched telemetry (Task 7). Defaulted so existing positional
    # construction sites (5 args) keep working.
    population: PopulationStatsWire = field(default_factory=_empty_population)
    gene_agreement: list[float] = field(default_factory=list)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_population(p: dict) -> PopulationStatsWire:
    return PopulationStatsWire(
        min=p["min"], q1=p["q1"], median=p["median"], q3=p["q3"],
        max=p["max"], mean=p["mean"], diversity=p["diversity"],
    )


def _parse_profile(p: dict) -> RunProfileWire:
    dist = p["distribution"]
    tail = p["tail"]
    # binHi for the open-ended top bin arrives as JSON null (Rust's f64::INFINITY,
    # which serde_json can't encode); pass it straight through as None so the wire
    # stays JSON-safe (see HistogramBinWire.bin_hi). binLo is never Infinity.
    return RunProfileWire(
        distribution=WinDistributionWire(
            bins=[HistogramBinWire(bin_lo=b["binLo"], bin_hi=b["binHi"],
                                   base=b["base"], feature=b["feature"])
                  for b in dist.get("bins", [])],
            zero_count=dist["zeroCount"],
        ),
        tail=TailWire(
            max_win=tail["maxWin"], p_ge100x=tail["pGE100x"],
            p_losing_spin=tail["pLosingSpin"],
            longest_dead_streak=tail["longestDeadStreak"],
            bonus_trigger_rate=tail["bonusTriggerRate"],
        ),
        rtp_convergence=[RtpPointWire(n=r["n"], realized_rtp=r["realizedRtp"])
                        for r in p.get("rtpConvergence", [])],
    )


def _parse_snapshot(s: dict) -> GenSnapshotWire:
    kwargs = dict(
        generation=s["generation"], best_fitness=s["bestFitness"],
        best_rtp=s["bestRtp"], best_volatility=s["bestVolatility"],
    )
    # Safe on older cassettes that predate the enriched telemetry: fall back
    # to GenSnapshotWire's own defaults (zeroed population, empty agreement).
    if "population" in s:
        kwargs["population"] = _parse_population(s["population"])
    if "geneAgreement" in s:
        kwargs["gene_agreement"] = s["geneAgreement"]
    return GenSnapshotWire(**kwargs)


def parse_tune_result_line(line: str, *, ran_at: str) -> TuneResult:
    d = json.loads(line)
    m = d.get("metrics") or {}
    se_d = m.get("se")
    metrics = MetricsWire(
        rtp=m["rtp"], volatility=m["volatility"], hit_frequency=m["hitFrequency"],
        base_rtp=m["baseRtp"], feature_rtp=m["featureRtp"],
        bonus_hit_rates=m.get("bonusHitRates", []),
        se=MetricSEWire(rtp=se_d["rtp"], volatility=se_d["volatility"],
                        bonus_hit_rates=se_d.get("bonusHitRates", [])) if se_d else None,
    )
    verdict = d["verdict"]  # "pass" | "near_miss"
    profile_d = d.get("profile")
    return TuneResult(
        status=verdict, verdict=verdict, tuned_model=d.get("model"), metrics=metrics,
        missed=[BandMissWire(metric=x["metric"], measured=x["measured"],
                             band_lo=x["bandLo"], band_hi=x["bandHi"]) for x in d.get("missed", [])],
        trace=[_parse_snapshot(s) for s in d.get("trace", [])],
        profile=_parse_profile(profile_d) if profile_d else None,
        failure=None, stop_reason=d.get("stopReason"), ran_at=ran_at,
    )


def parse_tune_error_line(obj: dict, *, ran_at: str) -> TuneResult:
    """A structured {"type":"error"} frame from the binary (e.g. all sections
    locked) — same shape the runner synthesizes for crashes/watchdog kills."""
    return TuneResult(status="error", verdict=None, tuned_model=None, metrics=None,
                      missed=[], trace=[],
                      failure=obj.get("message") or "tuner error", ran_at=ran_at)


class TunerRunner(Protocol):
    async def run(self, seed_model: dict, target: dict, config: dict,
                  on_progress: Callable[[TuneProgress], None],
                  on_spawn: Callable[[Callable[[], None]], None] | None = None) -> TuneResult: ...


# Repo root = .../app/math/runners/tune.py -> parents[5].
_REPO_ROOT = Path(__file__).resolve().parents[5]


class SubprocessTunerRunner:
    def __init__(self, settings):
        self._bin = getattr(settings, "tuner_bin", "") or ""
        # Runaway guard: the GA drives the same kernel evaluate() over mutated
        # models. The watchdog polls the subprocess tree and hard-kills it if
        # either bound is crossed (mirrors the simulator runner).
        self._mem_cap_mb = float(getattr(settings, "tuner_mem_cap_mb", 1024.0) or 1024.0)
        self._timeout_s = float(getattr(settings, "tuner_timeout_s", 120.0) or 120.0)
        self._poll_s = 0.1

    def _command(self, seed_path: str, target_path: str, config_path: str) -> list[str]:
        if self._bin:
            return [self._bin, seed_path, target_path, config_path]
        return ["cargo", "run", "--release", "-p", "bloom-tuner",
                "--bin", "tune_json", "--", seed_path, target_path, config_path]

    async def run(self, seed_model, target, config, on_progress,
                  on_spawn=None) -> TuneResult:
        ran_at = _now_iso()
        tmp = Path(tempfile.mkdtemp(prefix="bloom-tuner-"))
        try:
            seed_path = str(tmp / "seed_model.json")
            target_path = str(tmp / "target.json")
            config_path = str(tmp / "tuner_config.json")
            Path(seed_path).write_text(json.dumps(seed_model))
            Path(target_path).write_text(json.dumps(target))
            Path(config_path).write_text(json.dumps(config))

            proc = await asyncio.create_subprocess_exec(
                *self._command(seed_path, target_path, config_path),
                cwd=str(_REPO_ROOT),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            if on_spawn is not None:
                on_spawn(lambda: kill_proc_tree(proc.pid))
            result: TuneResult | None = None
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
                        kwargs = dict(
                            generation=obj["generation"], max_generations=obj["maxGenerations"],
                            best_fitness=obj["bestFitness"], best_rtp=obj["bestRtp"],
                            best_volatility=obj["bestVolatility"],
                        )
                        if "population" in obj:
                            kwargs["population"] = _parse_population(obj["population"])
                        if "geneAgreement" in obj:
                            kwargs["gene_agreement"] = obj["geneAgreement"]
                        on_progress(TuneProgress(**kwargs))
                    elif obj.get("type") == "result":
                        result = parse_tune_result_line(line, ran_at=ran_at)
                    elif obj.get("type") == "error":
                        result = parse_tune_error_line(obj, ran_at=ran_at)
                done.set()

            async def _watchdog() -> None:
                nonlocal guard_trip
                guard_trip = await watch_proc_tree(
                    proc, done, label="tuning",
                    mem_cap_mb=self._mem_cap_mb, timeout_s=self._timeout_s,
                    poll_s=self._poll_s)

            assert proc.stderr is not None
            _, stderr_bytes, _ = await asyncio.gather(
                _drain_stdout(), proc.stderr.read(), _watchdog())
            await proc.wait()

            if guard_trip is not None:
                return TuneResult(
                    status="error", verdict=None, tuned_model=None, metrics=None,
                    missed=[], trace=[], failure=guard_trip, ran_at=ran_at,
                )

            if result is None:
                return TuneResult(
                    status="error", verdict=None, tuned_model=None, metrics=None,
                    missed=[], trace=[],
                    failure=f"tuner produced no result (exit {proc.returncode}): {stderr_bytes.decode()[:500]}",
                    ran_at=ran_at,
                )
            return result
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class FakeTunerRunner:
    def __init__(self, *, progress: list[TuneProgress], result: TuneResult):
        self._progress = progress
        self._result = result

    async def run(self, seed_model, target, config, on_progress,
                  on_spawn=None) -> TuneResult:
        for p in self._progress:
            on_progress(p)
        return self._result


def build_tuner_runner(settings) -> TunerRunner:
    # LoopSafeRunner: uvicorn --reload on Windows serves the app from a
    # SelectorEventLoop, which cannot asyncio-spawn the tune_json subprocess.
    return LoopSafeRunner(SubprocessTunerRunner(settings))

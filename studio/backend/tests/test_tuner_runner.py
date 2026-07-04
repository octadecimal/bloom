import sys
from types import SimpleNamespace

import pytest
from app.config import Settings
from app.math.runners.tune import (
    TuneProgress, FakeTunerRunner, SubprocessTunerRunner, parse_tune_result_line,
)
from app.math.models import TuneResult
from app.math.models import MetricsWire


def _runner(*, mem_cap_mb=4096.0, timeout_s=600.0, poll_s=0.05):
    r = SubprocessTunerRunner(SimpleNamespace(tuner_bin=""))
    r._mem_cap_mb = mem_cap_mb
    r._timeout_s = timeout_s
    r._poll_s = poll_s
    return r


_MEM_HOG = (
    "import time\n"
    "buf = []\n"
    "for _ in range(20):\n"
    "    buf.append(bytearray(20 * 1024 * 1024))\n"
    "    time.sleep(0.1)\n"
    "time.sleep(2)\n"
)
_SLEEPER = "import time\ntime.sleep(60)\n"


def _cmd_for(script: str):
    return lambda *_a, **_k: [sys.executable, "-c", script]


@pytest.mark.asyncio
async def test_tuner_guard_kills_runaway_memory_and_returns_error():
    runner = _runner(mem_cap_mb=120.0, timeout_s=30.0)
    runner._command = _cmd_for(_MEM_HOG)
    res = await runner.run({"m": 1}, {"t": 1}, {"c": 1}, on_progress=lambda _p: None)
    assert res.status == "error"
    assert "memory" in res.failure.lower()


@pytest.mark.asyncio
async def test_tuner_guard_kills_on_wall_clock_timeout():
    runner = _runner(mem_cap_mb=8192.0, timeout_s=0.5)
    runner._command = _cmd_for(_SLEEPER)
    res = await runner.run({"m": 1}, {"t": 1}, {"c": 1}, on_progress=lambda _p: None)
    assert res.status == "error"
    assert "wall-clock" in res.failure.lower()


def test_settings_has_tuner_bin():
    assert hasattr(Settings(), "tuner_bin")


def test_parse_result_pass():
    line = (
        '{"type":"result","verdict":"pass",'
        '"model":{"reels":[[0,1]]},'
        '"metrics":{"rtp":0.9,"volatility":2.0,"hitFrequency":0.4,'
        '"baseRtp":0.9,"featureRtp":0.0,"bonusHitRates":[]},'
        '"missed":[],"trace":[{"generation":0,"bestFitness":0.0,"bestRtp":0.9,"bestVolatility":2.0}]}'
    )
    r = parse_tune_result_line(line, ran_at="t")
    assert r.status == "pass" and r.verdict == "pass"
    assert r.tuned_model == {"reels": [[0, 1]]}
    assert r.metrics.rtp == pytest.approx(0.9)
    assert len(r.trace) == 1 and r.trace[0].best_rtp == pytest.approx(0.9)
    assert r.missed == []


def test_parse_result_near_miss():
    line = (
        '{"type":"result","verdict":"near_miss",'
        '"model":{"reels":[[0]]},'
        '"metrics":{"rtp":0.8,"volatility":2.0,"hitFrequency":0.4,'
        '"baseRtp":0.8,"featureRtp":0.0,"bonusHitRates":[]},'
        '"missed":[{"metric":"rtp","measured":0.8,"bandLo":0.89,"bandHi":0.91}],"trace":[]}'
    )
    r = parse_tune_result_line(line, ran_at="t")
    assert r.status == "near_miss" and r.verdict == "near_miss"
    assert r.missed[0].metric == "rtp" and r.missed[0].band_lo == pytest.approx(0.89)


@pytest.mark.asyncio
async def test_fake_runner_streams_then_returns():
    seen = []
    res = TuneResult(status="pass", verdict="pass", tuned_model={"reels": []},
                     metrics=MetricsWire(rtp=0.9, volatility=2.0, hit_frequency=0.4,
                                         base_rtp=0.9, feature_rtp=0.0, bonus_hit_rates=[]),
                     missed=[], trace=[], ran_at="t")
    runner = FakeTunerRunner(
        progress=[TuneProgress(0, 40, -0.5, 0.5, 2.0), TuneProgress(1, 40, -0.1, 0.85, 2.1)],
        result=res,
    )
    out = await runner.run({"reels": []}, {"rtp_target": 0.9}, {"population": 8}, on_progress=seen.append)
    assert [p.generation for p in seen] == [0, 1]
    assert out.status == "pass"

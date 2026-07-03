import sys
from types import SimpleNamespace

import pytest
from app.math.models import MetricsWire, CurationResult
from app.math.runners.curate import (
    CurationProgress, FakeCurationRunner, SubprocessCurationRunner,
    parse_result_line,
)


def _runner(*, mem_cap_mb=4096.0, timeout_s=600.0, poll_s=0.05):
    """A SubprocessCurationRunner with tight guard knobs for tests."""
    r = SubprocessCurationRunner(SimpleNamespace(simulator_bin=""))
    r._mem_cap_mb = mem_cap_mb
    r._timeout_s = timeout_s
    r._poll_s = poll_s
    return r


# A child that allocates ~20 MiB every 0.1s up to a hard ceiling, then exits.
# Bounded so that if the guard FAILS the test machine is never exhausted and the
# test fails on an assertion instead of hanging.
_MEM_HOG = (
    "import time\n"
    "buf = []\n"
    "for _ in range(20):\n"
    "    buf.append(bytearray(20 * 1024 * 1024))\n"
    "    time.sleep(0.1)\n"
    "time.sleep(2)\n"
)

# A child that sleeps long and emits nothing — only the wall-clock guard ends it.
_SLEEPER = "import time\ntime.sleep(60)\n"

# A well-behaved child: emits one progress line and one result line, then exits.
_GOOD = (
    'import sys\n'
    'sys.stdout.write(\'{"type":"progress","phase":"simulate","done":1,"total":1}\\n\')\n'
    'sys.stdout.write(\'{"type":"result","status":"fail","rtp":1.0,"volatility":0.0,'
    '"hitFrequency":0.0,"baseRtp":1.0,"featureRtp":0.0,"bonusHitRates":[],'
    '"realizedRtp":null,"poolSize":null,"failure":"rough"}\\n\')\n'
    'sys.stdout.flush()\n'
)


def _cmd_for(script: str):
    return lambda *_a, **_k: [sys.executable, "-c", script]


@pytest.mark.asyncio
async def test_guard_kills_runaway_memory_and_returns_error():
    runner = _runner(mem_cap_mb=120.0, timeout_s=30.0)
    runner._command = _cmd_for(_MEM_HOG)
    res = await runner.run({"m": 1}, {"t": 1}, on_progress=lambda _p: None)
    assert res.status == "error"
    assert "memory" in res.failure.lower()


@pytest.mark.asyncio
async def test_guard_kills_on_wall_clock_timeout():
    runner = _runner(mem_cap_mb=8192.0, timeout_s=0.5)
    runner._command = _cmd_for(_SLEEPER)
    res = await runner.run({"m": 1}, {"t": 1}, on_progress=lambda _p: None)
    assert res.status == "error"
    assert "wall-clock" in res.failure.lower()


@pytest.mark.asyncio
async def test_guard_does_not_trip_for_a_well_behaved_child():
    seen = []
    runner = _runner(mem_cap_mb=8192.0, timeout_s=30.0)
    runner._command = _cmd_for(_GOOD)
    res = await runner.run({"m": 1}, {"t": 1}, on_progress=seen.append)
    assert res.status == "fail"
    assert res.metrics.rtp == pytest.approx(1.0)
    assert any(p.phase == "simulate" for p in seen)

def test_parse_result_line_pass():
    line = (
        '{"type":"result","status":"pass","rtp":0.96,"volatility":4.0,'
        '"hitFrequency":0.3,"baseRtp":0.9,"featureRtp":0.06,'
        '"bonusHitRates":[0.005],"realizedRtp":0.961,"poolSize":1000,"failure":null}'
    )
    r = parse_result_line(line, ran_at="t")
    assert r.status == "pass"
    assert r.metrics.rtp == pytest.approx(0.96)
    assert r.realized_rtp == pytest.approx(0.961)
    assert r.pool_size == 1000


def test_parse_result_line_fail():
    line = (
        '{"type":"result","status":"fail","rtp":0.91,"volatility":4.0,'
        '"hitFrequency":0.3,"baseRtp":0.91,"featureRtp":0.0,'
        '"bonusHitRates":[],"realizedRtp":null,"poolSize":null,'
        '"failure":"measured characteristics missed the target bands"}'
    )
    r = parse_result_line(line, ran_at="t")
    assert r.status == "fail"
    assert r.realized_rtp is None
    assert r.pool_size is None
    assert r.failure

@pytest.mark.asyncio
async def test_fake_runner_streams_then_returns():
    seen = []
    res = CurationResult(
        status="pass",
        metrics=MetricsWire(rtp=0.96, volatility=4.0, hit_frequency=0.3,
                            base_rtp=0.9, feature_rtp=0.06, bonus_hit_rates=[0.005]),
        realized_rtp=0.96, pool_size=10, failure=None, ran_at="t",
    )
    runner = FakeCurationRunner(
        progress=[CurationProgress("simulate", 5, 10), CurationProgress("freeze")],
        result=res,
    )
    out = await runner.run({"reels": []}, {"rtp_target": 0.96}, on_progress=seen.append)
    assert [p.phase for p in seen] == ["simulate", "freeze"]
    assert out.status == "pass"

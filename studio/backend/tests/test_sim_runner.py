import pytest
from app.simulator.models import MetricsWire, CurationResult
from app.simulator.runner import (
    CurationProgress, FakeCurationRunner, parse_result_line,
)

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

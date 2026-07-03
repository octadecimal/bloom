import pytest
from app.scene.asset_critic import AssetVerdict
from app.scene.asset_floor import run_asset_floor, AssetFloorResult


def _mk(verdicts, *, retries=2, budget=5):
    calls = {"regen": 0}
    async def judge(attempt):
        return verdicts[min(attempt, len(verdicts) - 1)]
    async def regen():
        calls["regen"] += 1
    return calls, dict(judge=judge, regenerate=regen, role="logo",
                       asset_regen_retries=retries, regen_left=budget)


@pytest.mark.asyncio
async def test_converges_regenerate_then_keep():
    calls, kw = _mk([AssetVerdict(ok=False, action="regenerate", reason="garbled"),
                     AssetVerdict(ok=True, action="keep")])
    res = await run_asset_floor(**kw)
    assert res.verdict.action == "keep"
    assert res.regens_spent == 1 and calls["regen"] == 1


@pytest.mark.asyncio
async def test_bounded_by_retries_and_kept():
    always_bad = [AssetVerdict(ok=False, action="regenerate", reason="bad")]
    calls, kw = _mk(always_bad, retries=2, budget=5)
    res = await run_asset_floor(**kw)
    assert res.regens_spent == 2  # stops at asset_regen_retries
    assert "kept" in " ".join(res.notes).lower()


@pytest.mark.asyncio
async def test_bounded_by_regen_budget():
    always_bad = [AssetVerdict(ok=False, action="regenerate", reason="bad")]
    calls, kw = _mk(always_bad, retries=5, budget=1)
    res = await run_asset_floor(**kw)
    assert res.regens_spent == 1  # budget caps below retries


@pytest.mark.asyncio
async def test_ok_first_pass_no_regen():
    calls, kw = _mk([AssetVerdict(ok=True, action="keep")])
    res = await run_asset_floor(**kw)
    assert res.regens_spent == 0 and calls["regen"] == 0

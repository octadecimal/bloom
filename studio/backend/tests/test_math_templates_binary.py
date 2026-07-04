"""Shells out to the real curate binary to prove each shipped template measures
at its stated target. e2e-marked (needs the cargo toolchain); deterministic +
offline. Mirrors tests/test_sim_curate_binary.py."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from freeze_template import TEMPLATE_TARGETS  # noqa: E402

from app.config import get_settings
from app.math import templates
from app.math.runners.curate import SubprocessCurationRunner


@pytest.mark.e2e
@pytest.mark.asyncio
@pytest.mark.parametrize("name", ["classic-3x3", "video-5x3", "high-vol-5x4"])
async def test_template_curates_to_its_stated_target(name):
    runner = SubprocessCurationRunner(get_settings())
    res = await runner.run(templates.get_model(name), TEMPLATE_TARGETS[name],
                           on_progress=lambda p: None)
    assert res.status == "pass", f"{name}: {res.status} {res.failure}"

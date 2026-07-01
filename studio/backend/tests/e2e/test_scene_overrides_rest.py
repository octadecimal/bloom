"""E2e: REST region-override routes + reproducibility contract.

Proves:
  1. A nudge persists and reflows the role into its overridden region.
  2. The override survives a later intent rebuild (reproducibility contract).
  3. Clearing the override restores the plan default.

Reuses the blueprint_rest_harness fixture from test_gdd_rest (real stores +
replay critics + seeded background/reels/logo scene). The harness already
carries a RegionOverrideStore on h._state, so no extra fixture wrapper needed.
"""
import pytest

# Reuse the A2 in-process harness (real stores + replay critics + seeded scene).
from tests.e2e.test_gdd_rest import blueprint_rest_harness  # noqa: F401
from app.scene.layout.overrides import RegionOverride
from app.scene.override_rebuild import (
    set_override_and_rebuild, clear_override_and_rebuild,
)


async def _put_override(h, role, **fields):
    return await set_override_and_rebuild(h._state, h.game_id, role, RegionOverride(**fields))


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_nudge_persists_and_reflows_reels(blueprint_rest_harness):
    h = blueprint_rest_harness
    # x=300 is well within the canvas for a reels sprite (432px wide, anchor_x=0.5:
    # left edge at 300-216=84px > 0 so the keep-in-frame guard does NOT correct it).
    await _put_override(h, "reels", x=300.0)
    pos = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert pos["x"] == 300.0  # the sprite reflowed to the overridden x


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_override_survives_a_later_intent_rebuild(blueprint_rest_harness):
    """The reproducibility contract: an override applied now is still honoured
    after an unrelated intent rebuild runs (bind re-applies it as the final layer)."""
    h = blueprint_rest_harness
    await _put_override(h, "reels", x=300.0)
    # a later, unrelated rebuild (e.g. an intent edit) must NOT lose the nudge
    await h.put_gdd(h.game_id, "ui-ux", {"framing_density": "ornate"})
    pos = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert pos["x"] == 300.0  # override still wins


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_clear_override_restores_plan(blueprint_rest_harness):
    h = blueprint_rest_harness
    plan_x = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]["x"]
    await _put_override(h, "reels", x=300.0)
    await clear_override_and_rebuild(h._state, h.game_id, "reels")
    pos = (await h.scene_doc())["nodes"]["spr.reels"]["props"]["position"]
    assert pos["x"] == plan_x  # back to the plan default

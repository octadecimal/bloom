import pytest

from app.scene.intent_rebuild import INTENT_FIELDS, is_intent_change, rebuild_after_intent


def test_is_intent_change_detects_each_intent_field():
    assert is_intent_change("ui-ux", {"focal_emphasis": "reels"})
    assert is_intent_change("ui-ux", {"orientation": "portrait", "controls": "x"})
    assert is_intent_change("theme", {"art_direction": "gold"})


def test_is_intent_change_ignores_non_intent_fields():
    assert not is_intent_change("ui-ux", {"controls": "tap", "autoplay": "on"})
    assert not is_intent_change("theme", {"name": "X", "tone": "luxe"})
    assert not is_intent_change("math-model", {"rtp": "96%"})


class _State:
    def __init__(self, **kw):
        for k, v in kw.items():
            setattr(self, k, v)


@pytest.mark.asyncio
async def test_rebuild_after_intent_returns_none_without_critics():
    state = _State(asset_store=object(), asset_hub=object(), scene_store=object(),
                   scene_hub=object(), gdd_store=object())  # no critics
    assert await rebuild_after_intent(state, "g1") is None

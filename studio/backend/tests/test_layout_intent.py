import pytest

from app.scene.layout.bind import GddIntent
from app.scene.layout.intent import read_intent, prompt_for_role


class _Doc:
    def __init__(self, data):
        self.data = data


class _FakeStore:
    def __init__(self, docs):
        self._docs = docs  # aspect -> data dict

    async def get_doc(self, game_id, aspect):
        d = self._docs.get(aspect)
        return _Doc(d) if d is not None else None


@pytest.mark.asyncio
async def test_read_intent_pulls_enums_and_prose():
    store = _FakeStore({
        "theme": {"art_direction": "weathered gold & deep teal", "tone": "luxe",
                  "setting": "sunken pirate vault"},
        "ui-ux": {"orientation": "portrait", "focal_emphasis": "reels",
                  "framing_density": "ornate", "layout": "reels are the hero"},
    })
    intent = await read_intent(store, "g1")
    assert intent.orientation == "portrait"
    assert intent.focal_emphasis == "reels"
    assert intent.framing_density == "ornate"
    assert "weathered gold" in intent.art_direction
    assert intent.tone == "luxe" and intent.setting == "sunken pirate vault"


@pytest.mark.asyncio
async def test_read_intent_defaults_when_docs_missing():
    intent = await read_intent(_FakeStore({}), "g1")
    assert intent.orientation == "landscape"
    assert intent.focal_emphasis == "balanced"
    assert intent.framing_density == "moderate"


def test_prompt_for_role_composes_art_direction_and_snippet():
    intent = GddIntent(art_direction="weathered gold & deep teal",
                       tone="luxe", role_snippets={"logo": "ornate crest wordmark"})
    p = prompt_for_role("logo", intent)
    assert "weathered gold" in p and "ornate crest wordmark" in p and "luxe" in p

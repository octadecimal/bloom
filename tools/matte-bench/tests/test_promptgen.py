"""LLM-imagined subjects: a Haiku-class model invents the description, the
bench enforces the same isolation rules the templates are tested against."""
import asyncio
import random

import pytest

from app.assets.recipes import profile_for

from matte_bench.promptgen import (
    BUCKET_HINTS, request_text, sample_subject_llm,
)

TEMPLATES = {
    "wispy": {"width": 8, "height": 8,
              "templates": [{"text": "a test tuft"}], "pools": {}},
    "crisp-text": {"width": 16, "height": 8,
                   "templates": [{"text": "a WORD mark", "boilerplate": "logo"}],
                   "pools": {}},
}


class FakeLLM:
    def __init__(self, chunks):
        self._chunks = chunks

    async def stream(self, turns, model):
        for c in self._chunks:
            yield c


class BoomLLM:
    async def stream(self, turns, model):
        raise RuntimeError("no route to model")
        yield  # pragma: no cover


def _sample(bucket, llm, seed=1):
    return asyncio.run(sample_subject_llm(
        bucket, random.Random(seed), TEMPLATES, llm, "test-model"))


def test_llm_description_becomes_a_production_subject():
    from matte_bench.sampler import DEFAULT_GROUND

    s = _sample("wispy", FakeLLM(["a spun-glass jellyfish ",
                                  "with trailing translucent filaments"]))
    assert s is not None
    assert s.prompt == ("a spun-glass jellyfish with trailing translucent "
                        f"filaments, {profile_for('misc').positive}, "
                        f"{DEFAULT_GROUND}")
    assert s.bucket == "wispy"
    assert s.id.startswith("wispy-")
    assert s.width == 8 and s.height == 8


def test_crisp_text_subjects_use_the_logo_boilerplate():
    s = _sample("crisp-text", FakeLLM(["a chrome wordmark reading NOVA"]))
    assert profile_for("logo").positive in s.prompt
    assert s.width == 16


def test_scene_language_is_rejected():
    for bad in ("an ornate ring in front of a garden scene",
                "a fern against a cluttered background",
                "a gem with a mountain backdrop far behind it"):
        assert _sample("wispy", FakeLLM([bad])) is None


def test_wrapping_quotes_and_trailing_period_are_stripped():
    s = _sample("wispy", FakeLLM(['"a lace fan with pierced ribs."']))
    assert s.prompt.startswith("a lace fan with pierced ribs, ")


def test_only_the_first_line_is_used():
    s = _sample("wispy", FakeLLM(["a carved ivory comb\n\nNote: as requested"]))
    assert s.prompt.startswith("a carved ivory comb, ")


def test_degenerate_output_is_rejected():
    assert _sample("wispy", FakeLLM([""])) is None
    assert _sample("wispy", FakeLLM(["x" * 300])) is None


def test_llm_failure_returns_none_instead_of_raising():
    assert _sample("wispy", BoomLLM()) is None


def test_request_steers_toward_the_bucket_difficulty_and_variety():
    text = request_text("wispy", ["a fern frond", "an ostrich feather"])
    assert BUCKET_HINTS["wispy"] in text
    assert "a fern frond" in text
    assert "isolated" in text.lower()


def test_every_bucket_has_a_hint():
    from matte_bench.corpus import BUCKETS

    assert set(BUCKET_HINTS) == set(BUCKETS)
    for hint in BUCKET_HINTS.values():
        assert len(hint) > 20

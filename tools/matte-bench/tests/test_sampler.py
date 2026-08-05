"""The generalized corpus: subjects are SAMPLED, not fixed.

Every draw composes a fresh random prompt from per-bucket template fragments
plus a fresh random seed, so rankings generalize across images instead of
overfitting 13 memorized plates. Both sides of a comparison still mat the
one plate that draw produced.
"""
import random
from pathlib import Path

from matte_bench.corpus import BUCKETS
from matte_bench.sampler import load_templates, sample_subject

REPO = Path(__file__).resolve().parents[3]


def _templates():
    return load_templates(REPO / "tools" / "matte-bench" / "templates.json")


def test_templates_cover_every_bucket():
    assert set(_templates()) == set(BUCKETS)


def test_sampled_prompts_mirror_production_boilerplate_and_pin_the_ground():
    """Boilerplate alone never NAMED a ground, so FLUX invented atmosphere
    (bokeh, vignettes) around otherwise-isolated subjects. Every sampled
    prompt must now end with an explicit solid-ground directive — black by
    default, tone-matched for low-contrast where black would kill the
    bucket's premise."""
    from app.assets.recipes import profile_for

    from matte_bench.sampler import DEFAULT_GROUND, GROUNDS

    boilerplates = tuple({profile_for("misc").positive,
                          profile_for("logo").positive,
                          profile_for("reels").positive})
    allowed_ground_phrases = ("plain background", DEFAULT_GROUND,
                              *GROUNDS.values())
    templates = _templates()
    rng = random.Random(7)
    for bucket in BUCKETS:
        for _ in range(10):
            s = sample_subject(bucket, rng, templates)
            assert s.bucket == bucket
            assert any(b in s.prompt for b in boilerplates), s.prompt
            assert s.prompt.endswith(GROUNDS.get(bucket, DEFAULT_GROUND)), s.prompt
            assert "{" not in s.prompt and "}" not in s.prompt
            scrubbed = s.prompt
            for phrase in allowed_ground_phrases:
                scrubbed = scrubbed.replace(phrase, "")
            for banned in ("background", "backdrop", "scene", "in front of"):
                assert banned not in scrubbed, s.prompt


def test_black_is_the_default_ground_and_low_contrast_is_the_exception():
    from matte_bench.sampler import DEFAULT_GROUND, GROUNDS

    assert "solid black background" in DEFAULT_GROUND
    assert set(GROUNDS) == {"low-contrast"}
    assert "black" not in GROUNDS["low-contrast"]
    assert "same" in GROUNDS["low-contrast"]


def test_sampling_is_deterministic_given_the_rng():
    templates = _templates()
    assert (sample_subject("wispy", random.Random(42), templates)
            == sample_subject("wispy", random.Random(42), templates))


def test_sampling_varies_across_draws():
    templates = _templates()
    rng = random.Random(1)
    subjects = [sample_subject("wispy", rng, templates) for _ in range(10)]
    assert len({s.id for s in subjects}) == 10
    assert len({s.seed for s in subjects}) == 10
    assert len({s.prompt for s in subjects}) > 1


def test_repeated_placeholders_fill_with_the_same_value():
    """low-contrast relies on this: {tone} appears for both subject and
    ground, and the bucket's premise dies if they differ."""
    synth = {"x": {"width": 8, "height": 8,
                   "templates": [{"text": "a {tone} gem resting on a {tone} ground"}],
                   "pools": {"tone": ["ruby red", "deep blue"]}}}
    for seed in range(10):
        s = sample_subject("x", random.Random(seed), synth)
        filled = s.prompt.split(", ")[0]
        tone = filled.removeprefix("a ").split(" gem")[0]
        assert filled == f"a {tone} gem resting on a {tone} ground"


def test_reel_frame_is_in_the_enclosed_holes_rotation():
    templates = _templates()
    rng = random.Random(9)
    prompts = [sample_subject("enclosed-holes", rng, templates).prompt
               for _ in range(40)]
    assert any("reel frame" in p for p in prompts)

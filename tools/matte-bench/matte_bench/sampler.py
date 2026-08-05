"""Random subject generation — the generalized corpus.

A fixed corpus overfits: after a few sessions the judge has memorized 13
images and every technique's quirks on them. Sampling composes a fresh prompt
from per-bucket template fragments plus a fresh seed on every draw, so
standings generalize across images. Blindness is untouched — both sides of a
comparison always mat the single plate the draw produced.

Prompts still compose exactly like production (`build_asset_prompt`): sampled
description first, then a `recipes.py` boilerplate verbatim. Templates carry
no scene language; subjects generate in isolation (see the spec's corpus
section for why that principle is absolute).
"""
import json
import random
import re
from pathlib import Path

from app.assets.recipes import profile_for

from matte_bench.corpus import Subject

# recipes.py profile keys for each boilerplate name a template may use.
_BOILERPLATE_ROLES = {"std": "misc", "logo": "logo", "reels": "reels"}

# The ground directive, appended AFTER the boilerplate. Boilerplate alone
# never named a ground, so FLUX invented atmosphere (bokeh, vignettes) around
# otherwise-isolated subjects — elaborate pixels the matte then had to fight.
# Black is the default; low-contrast is the one bucket whose premise requires
# the ground to sit at the subject's own tone instead.
DEFAULT_GROUND = "isolated on a solid black background, nothing else in frame"
GROUNDS = {
    "low-contrast": ("on a single flat solid background of almost the same "
                     "color as the subject, nothing else in frame"),
}

_PLACEHOLDER = re.compile(r"\{(\w+)\}")


def compose_prompt(description: str, role: str, bucket: str) -> str:
    """description + production boilerplate + ground directive — the one
    composition path both the template sampler and the LLM path go through."""
    ground = GROUNDS.get(bucket, DEFAULT_GROUND)
    return f"{description}, {profile_for(role).positive}, {ground}"


def load_templates(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def sample_subject(bucket: str, rng: random.Random, templates: dict) -> Subject:
    spec = templates[bucket]
    template = rng.choice(spec["templates"])
    text = template["text"]
    pools = spec.get("pools", {})
    # One draw per distinct placeholder NAME, applied to every occurrence:
    # "{tone} gem on {tone} ground" must stay tone-on-tone.
    for name in sorted(set(_PLACEHOLDER.findall(text))):
        text = text.replace("{" + name + "}", rng.choice(pools[name]))
    role = _BOILERPLATE_ROLES[template.get("boilerplate", "std")]
    prompt = compose_prompt(text, role, bucket)
    seed = rng.randrange(1, 2**31)
    return Subject(id=f"{bucket}-{seed}", bucket=bucket, prompt=prompt,
                   seed=seed, width=spec["width"], height=spec["height"])

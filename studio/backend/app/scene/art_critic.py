"""Scene art/effects critic — swappable seam (sub-project B, real-frame vision).

Grades the REAL captured Pixi engine frame (effects, blends, responsive scaling)
AFTER A's geometry loop converges on the Pillow proxy. Additive: geometry reconcile
is untouched. Its ONLY actuator is ``regenerate`` — it never moves/scales/reorders
and never tunes effect properties. Like the two existing critics it is a DIRECT
structured+image LLM call (not a bound tool) with its own cassette format
(``tests/fixtures/replay/scene_art/``). See
``docs/superpowers/specs/2026-07-01-scene-vision-b-real-frame-design.md``.
"""

import base64
import json
from dataclasses import dataclass, field
from typing import Protocol

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR,
    load_scene_art_cassettes,
    normalize_prompt,
)


class ArtRegen(BaseModel):
    target_handle: str
    why: str = ""


class SceneArtVerdict(BaseModel):
    premium: bool = False
    summary: str = ""
    regenerate: list[ArtRegen] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


@dataclass(frozen=True)
class SceneArtRequest:
    """Everything the art critic needs to grade the finished scene's real frame.

    ``frame_png`` is the REAL captured engine frame. ``scene`` is the structured
    read_scene context; ``plan`` maps each role to its intended region. ``theme``
    keys the replay cassette; ``pass_index`` is the art re-grade number.
    """

    frame_png: bytes
    scene: dict
    plan: dict = field(default_factory=dict)
    theme: str = ""
    regen_budget_left: int = 0
    pass_index: int = 0


class SceneArtCritic(Protocol):
    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict: ...


class ReplaySceneArtCritic:
    """Deterministic, offline art critic. Returns recorded per-pass verdicts from
    ``tests/fixtures/replay/scene_art/`` keyed by normalized theme. Never raises:
    the art stage is additive/optional, so a missing cassette yields a benign
    ``premium=True`` pass rather than failing the build."""

    def __init__(self, cassettes: dict[str, list[dict]]):
        self._cassettes = cassettes

    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict:
        passes = self._cassettes.get(normalize_prompt(request.theme))
        if passes is None:
            passes = self._cassettes.get("__default__")
        if passes is None or request.pass_index >= len(passes):
            return SceneArtVerdict(premium=True)
        return SceneArtVerdict(**passes[request.pass_index])

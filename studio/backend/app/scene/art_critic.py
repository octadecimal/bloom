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


ART_SYSTEM_PROMPT = (
    "You are a premium slot-game ART DIRECTOR grading a RENDERED frame of a "
    "finished slot scene — the real engine frame with lighting, blends, glows, "
    "and responsive scaling, NOT a flat layout mock. Geometry (position/size) has "
    "already been reconciled to a plan; do NOT re-judge placement. Judge whether "
    "the scene READS AS A SHIPPED, PREMIUM slot:\n"
    "- Overall composition, balance, and focal clarity.\n"
    "- Lighting, depth, contrast, and colour cohesion against the theme.\n"
    "- Framing and negative-space discipline; nothing important cropped or crowded.\n"
    "- Readability of the key elements (logo, reels, spin) at the rendered scale.\n"
    "- Effect integrity: an element must not be washed out, occluded, or lost to a "
    "blend/glow/another element.\n\n"
    "Your ONLY corrective action is REGENERATE: flag an element whose ART cannot be "
    "salvaged as-rendered and must be remade (you do NOT move, scale, reorder, or "
    "tune effects). Flag sparingly and only when no re-render of the SAME art could "
    "fix it. Prefer premium=true unless the scene is clearly not shippable.\n\n"
    "Return {premium, summary, regenerate:[{target_handle, why}], notes:[...]} where "
    "summary is a one-line verdict and notes are specific observations."
)


def _data_url(frame_png: bytes) -> str:
    b64 = base64.b64encode(frame_png).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_art_messages(request: SceneArtRequest) -> list[BaseMessage]:
    """Pure builder: render a SceneArtRequest into the LLM message list (system
    prompt + a multimodal human turn carrying scene/plan context and the real
    frame PNG as a base64 data URL). Kept pure so it is unit-testable offline."""
    context = {"theme": request.theme, "plan": request.plan, "scene": request.scene}
    text = (
        "Grade the RENDERED slot scene shown in the image on premium art quality.\n"
        f"Theme/intent: {request.theme}\n"
        f"Regenerations left in budget: {request.regen_budget_left}\n\n"
        f"Layout plan + scene context (JSON):\n{json.dumps(context, indent=2)}"
    )
    return [
        SystemMessage(ART_SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": _data_url(request.frame_png)}},
        ]),
    ]


class LiveSceneArtCritic:
    """Live art critic: a DIRECT structured+image completion via OpenRouter, mirrors
    ``LiveSceneCritic``. NOT a bound tool."""

    def __init__(self, api_key: str, base_url: str, model: str):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict:
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=self._model, api_key=self._api_key, base_url=self._base_url)
        structured = llm.with_structured_output(SceneArtVerdict)
        return await structured.ainvoke(build_art_messages(request))


def build_scene_art_critic(settings: Settings) -> SceneArtCritic:
    """Select the art-critic impl by provider mode — mirrors ``build_scene_critic``."""
    if settings.provider_mode == "replay":
        return ReplaySceneArtCritic(load_scene_art_cassettes(DEFAULT_FIXTURES_DIR))
    return LiveSceneArtCritic(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        model=settings.critic_model,
    )

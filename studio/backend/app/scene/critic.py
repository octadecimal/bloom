"""Vision-in-the-loop scene composition critic — swappable seam.

The critic grades a *rendered* scene PNG against slot-aesthetic guidance and
returns a structured edit list. It is a DIRECT structured+image LLM call, NOT a
bound tool: the existing ``ReplayToolCallingChatModel`` only replays recorded
*tool calls* and cannot reproduce a direct structured+image completion, so the
critic has its own seam (this module) and its own cassette format
(``tests/fixtures/replay/critic/``). See
``docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`` §3.
"""

import base64
import json
from dataclasses import dataclass, field
from typing import Literal, Protocol

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from pydantic import BaseModel, Field

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR,
    load_critic_cassettes,
    normalize_prompt,
)


class EditParams(BaseModel):
    """Action-specific levers. Maps 1:1 onto ``adjust_element`` (Plan 1).

    ``move`` uses x/y; ``scale`` uses scale; ``reorder`` uses z; ``regenerate``
    leaves all None (it repaints in place, keeping position/scale/z).
    """

    x: float | None = None
    y: float | None = None
    scale: float | None = None
    z: int | None = None


class CritiqueEdit(BaseModel):
    target_handle: str
    action: Literal["move", "scale", "reorder", "regenerate"]
    params: EditParams = Field(default_factory=EditParams)
    why: str = ""


class Critique(BaseModel):
    done: bool = False
    edits: list[CritiqueEdit] = Field(default_factory=list)


@dataclass(frozen=True)
class CritiqueRequest:
    """Everything the critic needs to grade one re-look pass.

    ``scene`` is the structured ``read_scene`` context (every placed sprite's
    handle/role/asset/x,y/size/z). ``window`` is the look-behind set of handles
    the critic may target. ``pass_index`` is the re-look pass number within the
    current element (the replay impl keys on it; the live impl ignores it and
    just grades the current frame).
    """

    frame_png: bytes
    scene: dict
    target_handle: str
    window: list[str]
    theme: str = ""
    regen_budget_left: int = 0
    pass_index: int = 0
    edit_history: dict = field(default_factory=dict)


class SceneCritic(Protocol):
    async def critique(self, request: CritiqueRequest) -> Critique: ...


class ReplaySceneCritic:
    """Deterministic, offline critic. Returns recorded per-target, per-pass
    critiques from ``tests/fixtures/replay/critic/`` (loaded by
    ``load_critic_cassettes``)."""

    def __init__(self, cassettes: dict[str, list[dict]]):
        self._cassettes = cassettes

    async def critique(self, request: CritiqueRequest) -> Critique:
        passes = self._cassettes.get(normalize_prompt(request.target_handle))
        if passes is None:
            passes = self._cassettes.get("__default__")
        if passes is None:
            raise RuntimeError(
                f"No critic cassette for target '{request.target_handle}' and no "
                f"default.json under tests/fixtures/replay/critic/. Add a keyed "
                f"cassette (target='{request.target_handle}') or a default."
            )
        if request.pass_index >= len(passes):
            # Over-iterated past the recorded passes: report done so a loop ends.
            return Critique(done=True, edits=[])
        return Critique(**passes[request.pass_index])


CRITIC_SYSTEM_PROMPT = (
    "You are a slot-game composition critic. You are shown a RENDERED frame of a "
    "slot game scene being assembled element-by-element, plus structured context "
    "for every placed element. Judge the COMPOSITION of the assembled frame — not "
    "the quality of any single asset — and return corrective edits as structured "
    "output.\n\n"
    "Canonical slot anatomy (aesthetic guidance, NOT a hard region map — content "
    "and style stay free):\n"
    "- Background fills the frame (full-bleed), sits at the back.\n"
    "- The reel grid is centered and is the visual focus; symbols sit INSIDE the "
    "grid, never spilling outside it.\n"
    "- The logo sits in the top band, clear of the play area.\n"
    "- The spin button sits bottom-center.\n"
    "- Foreground flourishes FRAME the play area, they do not cover it.\n\n"
    "Discipline:\n"
    "- TRANSFORM-FIRST. Prefer move / scale / reorder. Reach for 'regenerate' "
    "only when no transform can fix the element because the asset is wrong FOR "
    "ITS ROLE (e.g. a dense rectangular blob that cannot be salvaged by "
    "moving/scaling). A 'regenerate' edit MUST justify in 'why' that no transform "
    "fixes it, and is refused once the regeneration budget is exhausted.\n"
    "- Edit ONLY elements inside the provided editable look-behind WINDOW. Never "
    "target a handle that is not in the window.\n"
    "- When the composition is acceptable, return done=true with an empty edit "
    "list. Do not invent busywork edits.\n"
    "- CONVERGE. You are shown 'edit_history' — your prior edits to each element "
    "this build. Do NOT undo a move you already made, and do not oscillate an "
    "element back and forth. If an element has already been adjusted a few times, "
    "leave it unless it is clearly still wrong; prefer to return done=true.\n\n"
    "Return: {done, edits:[{target_handle, action, params, why}]} where action is "
    "one of move|scale|reorder|regenerate and params carries x, y (move), scale "
    "(scale), or z (reorder)."
)


def _data_url(frame_png: bytes) -> str:
    b64 = base64.b64encode(frame_png).decode("ascii")
    return f"data:image/png;base64,{b64}"


def build_critic_messages(request: CritiqueRequest) -> list[BaseMessage]:
    """Pure builder: render a CritiqueRequest into the LLM message list (system
    prompt + a multimodal human turn carrying the scene context and the frame
    PNG as a base64 data URL). Kept pure so it is unit-testable without a network
    call."""
    context = {
        "theme": request.theme,
        "just_added": request.target_handle,
        "editable_window": request.window,
        "regen_budget_left": request.regen_budget_left,
        "edit_history": request.edit_history,
        "scene": request.scene,
    }
    text = (
        "Critique the rendered slot scene shown in the image and return corrective "
        "edits.\n"
        f"Just-added element (judge it hardest): {request.target_handle}\n"
        f"Editable look-behind window (you may ONLY target these handles): "
        f"{request.window}\n"
        f"Regenerations left in budget: {request.regen_budget_left}\n"
        f"Theme/intent: {request.theme}\n\n"
        f"Scene context (JSON):\n{json.dumps(context, indent=2)}"
    )
    return [
        SystemMessage(CRITIC_SYSTEM_PROMPT),
        HumanMessage(
            content=[
                {"type": "text", "text": text},
                {"type": "image_url", "image_url": {"url": _data_url(request.frame_png)}},
            ]
        ),
    ]


class LiveSceneCritic:
    """Live vision critic: a DIRECT structured+image completion via OpenRouter.

    NOT a bound tool — it calls ``ChatOpenAI.with_structured_output(Critique)``
    with a multimodal message and returns the validated ``Critique`` directly.
    """

    def __init__(self, api_key: str, base_url: str, model: str):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    async def critique(self, request: CritiqueRequest) -> Critique:
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(
            model=self._model, api_key=self._api_key, base_url=self._base_url
        )
        structured = llm.with_structured_output(Critique)
        return await structured.ainvoke(build_critic_messages(request))


def build_scene_critic(settings: Settings) -> SceneCritic:
    """Select the critic impl by provider mode — mirrors ``build_chat_model``."""
    if settings.provider_mode == "replay":
        return ReplaySceneCritic(load_critic_cassettes(DEFAULT_FIXTURES_DIR))
    return LiveSceneCritic(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        model=settings.critic_model,
    )

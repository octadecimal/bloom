"""Vision-in-the-loop scene composition critic — swappable seam.

The critic grades a *rendered* scene PNG against slot-aesthetic guidance and
returns a structured edit list. It is a DIRECT structured+image LLM call, NOT a
bound tool: the existing ``ReplayToolCallingChatModel`` only replays recorded
*tool calls* and cannot reproduce a direct structured+image completion, so the
critic has its own seam (this module) and its own cassette format
(``tests/fixtures/replay/critic/``). See
``docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md`` §3.
"""

from dataclasses import dataclass
from typing import Literal, Protocol

from pydantic import BaseModel, Field

from app.replay.cassette import normalize_prompt


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

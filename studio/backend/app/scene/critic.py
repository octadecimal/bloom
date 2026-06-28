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
from typing import Literal

from pydantic import BaseModel, Field


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

"""Vision-in-the-loop scene composition — compose-loop orchestrator core.

`run_compose` owns the bounded build loop described in the spec (§1): for each
element the user named, place it, then repeatedly capture the real rendered
frame, critique its composition, and apply transform/regenerate edits until the
critic returns `done` or the caps are hit. It is pure: all I/O (placement,
capture, critique, edits) is behind the `ComposeDeps` Protocol so the bounds /
window / budget / stop logic is unit-testable without Mongo, sockets, or an LLM.
See docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md.
"""

import logging
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel

from app.scene.critic import Critique, CritiqueRequest, EditParams

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ComposeBounds:
    """Liberal v1 defaults from the spec (§1 Bounds)."""

    look_behind: int = 3        # editable window = [K-look_behind .. K]
    max_passes: int = 3         # re-look passes per element
    regen_budget: int = 5       # hard ceiling on regenerations per build
    capture_timeout: float = 8.0


class BuildElement(BaseModel):
    """One element of a build list — mirrors `generate_and_place` args 1:1 so the
    orchestrator can forward it straight to the placement verb."""

    description: str = ""
    style: str = ""
    size: str = "512x512"
    transparent: bool = True
    slot: str = ""
    role: str = ""
    parent: str = "root"
    x: float | None = None
    y: float | None = None
    anchor_x: float = 0.5
    anchor_y: float = 0.5
    fit: str = "none"
    z_index: int = 0


@dataclass
class ComposeResult:
    passes: int = 0
    edits_applied: int = 0
    regens_spent: int = 0
    rejected: int = 0
    elements_placed: int = 0
    notes: list[str] = field(default_factory=list)


class ComposeDeps(Protocol):
    """The I/O surface the loop drives. Task 3 supplies the real impl; tests a
    fake. Every method is async."""

    async def place(self, element: BuildElement) -> str: ...
    async def placed_handles(self) -> list[str]: ...
    async def scene_context(self) -> dict: ...
    async def capture(self) -> bytes: ...
    async def critique(self, request: CritiqueRequest) -> Critique: ...
    async def adjust(self, handle: str, params: EditParams) -> str: ...
    async def regenerate(self, handle: str) -> str: ...


async def run_compose(
    elements: list[BuildElement],
    theme: str,
    deps: ComposeDeps,
    bounds: ComposeBounds = ComposeBounds(),
) -> ComposeResult:
    """Drive the bounded compose loop. Returns a tally + per-step notes."""
    result = ComposeResult()
    regen_left = bounds.regen_budget

    for element in elements:
        await deps.place(element)
        result.elements_placed += 1
        handles = await deps.placed_handles()
        if not handles:
            continue
        target = handles[-1]
        k = len(handles) - 1
        window = handles[max(0, k - bounds.look_behind):k + 1]
        result.notes.append(f"placed {target} (window={window})")

        for pass_index in range(bounds.max_passes):
            try:
                frame = await deps.capture()
            except Exception:
                # Best-effort capture (decision 3): no frame -> cannot grade this
                # element. Skip its critique loop and move on.
                result.notes.append(f"{target}: no frame, skipped critique")
                logger.info("compose: capture failed for %s; skipping", target)
                break

            scene = await deps.scene_context()
            critique = await deps.critique(CritiqueRequest(
                frame_png=frame, scene=scene, target_handle=target,
                window=window, theme=theme, regen_budget_left=regen_left,
                pass_index=pass_index,
            ))
            result.passes += 1
            if critique.done or not critique.edits:
                break

            for edit in critique.edits:
                if edit.target_handle not in window:
                    result.rejected += 1
                    result.notes.append(
                        f"rejected {edit.action} on {edit.target_handle} "
                        f"(outside window {window})")
                    continue
                if edit.action == "regenerate":
                    if regen_left <= 0:
                        result.rejected += 1
                        result.notes.append(
                            f"refused regenerate {edit.target_handle} "
                            f"(budget exhausted)")
                        continue
                    regen_left -= 1
                    result.regens_spent += 1
                    await deps.regenerate(edit.target_handle)
                    result.notes.append(
                        f"regenerated {edit.target_handle}: {edit.why}")
                else:
                    await deps.adjust(edit.target_handle, edit.params)
                    result.notes.append(
                        f"{edit.action} {edit.target_handle}: {edit.why}")
                result.edits_applied += 1

    return result

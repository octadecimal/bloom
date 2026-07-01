"""Vision-in-the-loop scene composition — compose-loop orchestrator core.

`run_compose` owns the bounded build loop described in the spec (§1): for each
element the user named, place it, run the per-asset quality gate, then
repeatedly composite the canonical scene, critique its composition, and apply
transform/regenerate edits until the critic returns `done` or the caps are hit.
It is pure: all I/O (placement, render, critique, edits) is behind the
`ComposeDeps` Protocol so the bounds / window / budget / stop logic is
unit-testable without Mongo, sockets, or an LLM.
See docs/superpowers/specs/2026-06-27-vision-in-the-loop-scene-composition-design.md.
"""

import logging
from dataclasses import dataclass, field
from typing import Protocol

from pydantic import BaseModel

from app.scene.asset_critic import AssetVerdict
from app.scene.critic import Critique, CritiqueRequest, EditParams
from app.scene.art_critic import SceneArtRequest, SceneArtVerdict
from app.scene.layout.plan import ScenePlan

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ComposeBounds:
    """Liberal v1 defaults from the spec (§1 Bounds)."""

    look_behind: int = 3        # editable window = [K-look_behind .. K]
    max_passes: int = 3         # re-look passes per element
    regen_budget: int = 5       # hard ceiling on regenerations per build
    asset_regen_retries: int = 2    # max regenerate->re-judge cycles per asset
    max_edits_per_element: int = 4  # deterministic per-element critic-edit cap
    art_passes: int = 2         # art/effects grades after geometry converges (1 grade + 1 re-grade)


class FrameCorrection(BaseModel):
    """A deterministic clamp that brings an off-canvas sprite back in frame."""

    handle: str
    x: float
    y: float
    reason: str


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
    region_w: int | None = None
    region_h: int | None = None


@dataclass
class ComposeResult:
    passes: int = 0
    edits_applied: int = 0
    regens_spent: int = 0
    assets_regenerated: int = 0
    rejected: int = 0
    elements_placed: int = 0
    corrections_applied: int = 0
    art_passes_run: int = 0
    notes: list[str] = field(default_factory=list)


class ComposeDeps(Protocol):
    """The I/O surface the loop drives. Task 4 supplies the real impl; tests a
    fake. Every method is async."""

    async def place(self, element: BuildElement) -> str: ...
    async def placed_handles(self) -> list[str]: ...
    async def scene_context(self) -> dict: ...
    async def render_scene(self) -> bytes: ...
    async def critique_asset(self, target_handle: str, attempt: int = 0) -> AssetVerdict: ...
    async def critique(self, request: CritiqueRequest) -> Critique: ...
    async def adjust(self, handle: str, params: EditParams) -> str: ...
    async def regenerate(self, handle: str) -> str: ...
    async def out_of_frame(self) -> list[FrameCorrection]: ...
    async def capture_real_frame(self) -> bytes | None: ...
    async def art_grade(self, request: SceneArtRequest) -> SceneArtVerdict: ...


def _handle_of(element: BuildElement) -> str:
    """The stable scene handle for an element: its slot, else its role."""
    return element.slot or element.role


def _role_of(element: BuildElement) -> str:
    """The canonical-layout role for an element: its role, else its slot."""
    return element.role or element.slot


def _apply_plan(element: BuildElement, plan: "ScenePlan | None") -> BuildElement:
    """Overwrite an element's geometry from its planned role region. The plan owns
    geometry; the agent only chose content + role. No-op when no plan or no role."""
    if plan is None:
        return element
    pr = plan.for_role(_role_of(element))
    if pr is None:
        return element
    return element.model_copy(update={
        "x": pr.x, "y": pr.y, "anchor_x": pr.anchor_x, "anchor_y": pr.anchor_y,
        "z_index": pr.z, "fit": pr.fit,
        "region_w": pr.region_w, "region_h": pr.region_h,
    })


def _plan_context(plan: "ScenePlan | None", window: list[str],
                  elements: list[BuildElement]) -> dict:
    """Map in-window handles to their intended region for the critic."""
    if plan is None:
        return {}
    role_by_handle = {_handle_of(e): _role_of(e) for e in elements}
    out: dict = {}
    for handle in window:
        pr = plan.for_role(role_by_handle.get(handle, handle))
        if pr is not None:
            out[handle] = {"role": pr.role, "x": pr.x, "y": pr.y,
                           "w": pr.region_w, "h": pr.region_h, "z": pr.z}
    return out


async def run_compose(
    elements: list[BuildElement],
    theme: str,
    deps: ComposeDeps,
    bounds: ComposeBounds = ComposeBounds(),
    plan: ScenePlan | None = None,
) -> ComposeResult:
    """Drive the bounded compose loop. Returns a tally + per-step notes."""
    result = ComposeResult()
    regen_left = bounds.regen_budget
    edit_history: dict[str, list[dict]] = {}

    for element in elements:
        await deps.place(_apply_plan(element, plan))
        result.elements_placed += 1
        handles = await deps.placed_handles()
        if not handles:
            continue
        target = handles[-1]
        k = len(handles) - 1
        window = handles[max(0, k - bounds.look_behind):k + 1]
        result.notes.append(f"placed {target} (window={window})")

        # Per-asset quality gate (before composition): regenerate degenerate art,
        # then RE-JUDGE so a regeneration converges instead of silently swapping
        # one bad asset for another. Bounded by asset_regen_retries and the shared
        # regen budget.
        verdict = await deps.critique_asset(target, attempt=0)
        attempt = 0
        while (verdict.action == "regenerate" and regen_left > 0
               and attempt < bounds.asset_regen_retries):
            regen_left -= 1
            result.regens_spent += 1
            result.assets_regenerated += 1
            await deps.regenerate(target)
            attempt += 1
            result.notes.append(
                f"{target}: {verdict.reason} -> regenerated (attempt {attempt})")
            verdict = await deps.critique_asset(target, attempt=attempt)

        if verdict.action == "regenerate":
            cause = "regen budget exhausted" if regen_left <= 0 else "retries exhausted"
            result.notes.append(
                f"{target}: {verdict.reason} (could not fix: {cause}, kept)")
        elif verdict.ok:
            result.notes.append(f"{target}: asset ok")
        else:
            result.notes.append(f"{target}: {verdict.reason}")

        # Composition passes: critique the composited scene and apply edits.
        for pass_index in range(bounds.max_passes):
            for corr in await deps.out_of_frame():
                if corr.handle in window:
                    await deps.adjust(corr.handle, EditParams(x=corr.x, y=corr.y))
                    result.corrections_applied += 1
                    result.notes.append(f"{corr.handle}: {corr.reason}, nudged into frame")
            try:
                frame = await deps.render_scene()
            except Exception as exc:
                # Fail-loud (NOT silent): a render failure is surfaced, not hidden.
                result.notes.append(f"{target}: could not render scene for review ({exc})")
                logger.warning("compose: render_scene failed for %s: %s", target, exc)
                break

            scene = await deps.scene_context()
            window_history = {h: edit_history[h] for h in window if h in edit_history}
            critique = await deps.critique(CritiqueRequest(
                frame_png=frame, scene=scene, target_handle=target,
                window=window, theme=theme, regen_budget_left=regen_left,
                pass_index=pass_index, edit_history=window_history,
                plan=_plan_context(plan, window, elements),
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
                if len(edit_history.get(edit.target_handle, [])) >= bounds.max_edits_per_element:
                    result.rejected += 1
                    result.notes.append(
                        f"refused {edit.action} {edit.target_handle} (edit cap reached)")
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
                edit_history.setdefault(edit.target_handle, []).append({
                    "action": edit.action,
                    "params": edit.params.model_dump(exclude_none=True),
                    "why": edit.why,
                })

    # ── Final art/effects grade (sub-project B) ──────────────────────────────
    # After geometry converges on the Pillow proxy, grade the REAL captured
    # engine frame (effects, blends, responsive scaling). Additive: geometry is
    # untouched. Skips cleanly (a note) when no client is attached. Art
    # regenerations draw from the SAME regen_left as the geometry loop.
    all_handles = await deps.placed_handles()
    if all_handles:
        frame = await deps.capture_real_frame()
        if frame is None:
            result.notes.append("art grade skipped: no live client")
        else:
            for art_pass in range(bounds.art_passes):
                scene = await deps.scene_context()
                verdict = await deps.art_grade(SceneArtRequest(
                    frame_png=frame, scene=scene,
                    plan=_plan_context(plan, all_handles, elements),
                    theme=theme, regen_budget_left=regen_left, pass_index=art_pass,
                ))
                result.art_passes_run += 1
                if verdict.summary:
                    result.notes.append(f"art: {verdict.summary}")
                for note in verdict.notes:
                    result.notes.append(f"art: {note}")
                if verdict.premium or not verdict.regenerate:
                    break
                regenerated_any = False
                for regen in verdict.regenerate:
                    if regen_left <= 0:
                        result.notes.append(
                            f"art refused regenerate {regen.target_handle} "
                            f"(budget exhausted)")
                        break
                    if regen.target_handle not in all_handles:
                        result.rejected += 1
                        result.notes.append(
                            f"art rejected regenerate {regen.target_handle} "
                            f"(not in scene)")
                        continue
                    regen_left -= 1
                    result.regens_spent += 1
                    await deps.regenerate(regen.target_handle)
                    result.notes.append(
                        f"art regenerated {regen.target_handle}: {regen.why}")
                    regenerated_any = True
                if not regenerated_any:
                    break
                frame = await deps.capture_real_frame()
                if frame is None:
                    result.notes.append("art re-grade skipped: no live client")
                    break

    return result

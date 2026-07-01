"""The bind step — GDD intent + canonical template -> a concrete ScenePlan.

Deterministic core (enum transforms + pixel resolution) with an optional
`LayoutRefiner` seam. A1 ships the no-op refiner; A4 drops in an LLM refiner
that nudges regions within clamped bounds — without changing any caller.
"""
from dataclasses import dataclass, field, replace
from typing import Protocol

from app.scene.layout.template import (
    TEMPLATE_VERSION, RoleRegion, canvas_for, template_for,
    REELS, LOGO, FLOURISH_LEFT, FLOURISH_RIGHT,
)
from app.scene.layout.plan import ScenePlan, PlannedRole, resolve_region, canonical_role


@dataclass(frozen=True)
class GddIntent:
    orientation: str = "landscape"
    focal_emphasis: str = "balanced"
    framing_density: str = "moderate"
    art_direction: str = ""
    tone: str = ""
    setting: str = ""
    layout: str = ""
    role_snippets: dict[str, str] = field(default_factory=dict)


class LayoutRefiner(Protocol):
    def refine(self, plan: ScenePlan, intent: GddIntent) -> ScenePlan: ...


class NoopRefiner:
    def refine(self, plan: ScenePlan, intent: GddIntent) -> ScenePlan:
        return plan


def _apply_focal(regions: dict[str, RoleRegion], focal: str) -> dict[str, RoleRegion]:
    out = dict(regions)
    if focal == "reels" and REELS in out:
        r = out[REELS]
        out[REELS] = replace(r, w=min(1.0, r.w * 1.18), h=min(1.0, r.h * 1.12))
        for fl in (FLOURISH_LEFT, FLOURISH_RIGHT):
            if fl in out:
                out[fl] = replace(out[fl], w=out[fl].w * 0.85)
    elif focal == "logo" and LOGO in out:
        l = out[LOGO]
        out[LOGO] = replace(l, w=min(1.0, l.w * 1.25), h=min(1.0, l.h * 1.2))
    return out


def _apply_density(regions: dict[str, RoleRegion], density: str) -> dict[str, RoleRegion]:
    out = dict(regions)
    if density == "clean":
        out.pop(FLOURISH_LEFT, None)
        out.pop(FLOURISH_RIGHT, None)
    return out


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _apply_overrides(plan: ScenePlan, overrides: dict | None) -> ScenePlan:
    """Replace set fields on each role's PlannedRole from a per-game override map.
    Absolute values, per-field-optional, clamped to the canvas. The FINAL bind
    layer (spec §bind step 6): applied after the refiner so a human nudge always
    wins, yet only for the fields it sets."""
    if not overrides:
        return plan
    cw, ch = plan.canvas
    roles = dict(plan.roles)
    for role, ov in overrides.items():
        key = canonical_role(role)
        pr = roles.get(key) if key else None
        if pr is None:
            continue  # unknown / dropped role -> no-op
        fields = ov.as_set_fields() if hasattr(ov, "as_set_fields") else {
            k: v for k, v in dict(ov).items() if v is not None}
        upd: dict = {}
        if "x" in fields:
            upd["x"] = _clamp(float(fields["x"]), 0.0, cw)
        if "y" in fields:
            upd["y"] = _clamp(float(fields["y"]), 0.0, ch)
        if "region_w" in fields:
            upd["region_w"] = int(_clamp(float(fields["region_w"]), 1.0, cw))
        if "region_h" in fields:
            upd["region_h"] = int(_clamp(float(fields["region_h"]), 1.0, ch))
        if "anchor_x" in fields:
            upd["anchor_x"] = _clamp(float(fields["anchor_x"]), 0.0, 1.0)
        if "anchor_y" in fields:
            upd["anchor_y"] = _clamp(float(fields["anchor_y"]), 0.0, 1.0)
        roles[key] = replace(pr, **upd)
    return replace(plan, roles=roles)


def bind(intent: GddIntent, overrides: dict | None = None,
         refiner: LayoutRefiner | None = None) -> ScenePlan:
    canvas = canvas_for(intent.orientation)
    regions = template_for(intent.orientation)
    regions = _apply_focal(regions, intent.focal_emphasis)
    regions = _apply_density(regions, intent.framing_density)

    roles = {
        role: resolve_region(region, canvas,
                             prompt_snippet=intent.role_snippets.get(role, ""))
        for role, region in regions.items()
    }
    plan = ScenePlan(
        canvas=canvas,
        orientation=intent.orientation or "landscape",
        template_version=TEMPLATE_VERSION,
        roles=roles,
    )
    plan = (refiner or NoopRefiner()).refine(plan, intent)
    return _apply_overrides(plan, overrides)  # FINAL layer, after the refiner

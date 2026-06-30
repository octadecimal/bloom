"""Concrete per-game plan: normalized template regions resolved to pixels.

`ScenePlan` is DERIVED (reproducible from GDD intent + template_version) and is
the single source of geometry the placer and critic both read. Role aliases let
the agent name an element loosely ("reel_frame", "title") and still hit the
canonical region.
"""
from dataclasses import dataclass

from app.scene.layout.template import RoleRegion

_ALIASES = {
    "background": "background", "bg": "background", "backdrop": "background",
    "reels": "reels", "reel": "reels", "reel_frame": "reels",
    "reelframe": "reels", "grid": "reels", "reel_grid": "reels",
    "logo": "logo", "title": "logo", "wordmark": "logo", "banner": "logo",
    "spin": "spin", "spin_button": "spin", "spinbtn": "spin", "play": "spin",
    "flourish_left": "flourish_left", "flourish-left": "flourish_left",
    "left_flourish": "flourish_left", "ornament_left": "flourish_left",
    "flourish_right": "flourish_right", "flourish-right": "flourish_right",
    "right_flourish": "flourish_right", "ornament_right": "flourish_right",
}


def canonical_role(role: str) -> str | None:
    if not role:
        return None
    return _ALIASES.get(role.strip().lower().replace(" ", "_"))


@dataclass(frozen=True)
class PlannedRole:
    role: str
    x: float
    y: float
    anchor_x: float
    anchor_y: float
    z: int
    fit: str
    region_w: int
    region_h: int
    prompt_snippet: str = ""


@dataclass(frozen=True)
class ScenePlan:
    canvas: tuple[int, int]
    orientation: str
    template_version: int
    roles: dict[str, PlannedRole]

    def for_role(self, role: str) -> PlannedRole | None:
        key = canonical_role(role)
        return self.roles.get(key) if key else None


def resolve_region(region: RoleRegion, canvas: tuple[int, int],
                   prompt_snippet: str = "") -> PlannedRole:
    cw, ch = canvas
    return PlannedRole(
        role=region.role,
        x=round(region.cx * cw, 10),
        y=round(region.cy * ch, 10),
        anchor_x=region.anchor_x,
        anchor_y=region.anchor_y,
        z=region.z,
        fit=region.fit,
        region_w=round(region.w * cw),
        region_h=round(region.h * ch),
        prompt_snippet=prompt_snippet,
    )


def scale_to_region(tex_size: tuple[int, int], region_px: tuple[int, int]) -> float:
    tw, th = tex_size
    rw, rh = region_px
    if not tw or not th:
        return 1.0
    return min(rw / tw, rh / th)

"""Canonical slot-anatomy layout template — normalized 0–1 regions, versioned.

Pure data + pure functions: no I/O, no Mongo. Regions are expressed as an
anchor-center (cx, cy) plus a region box (w, h) as fractions of the canvas, so
the same template serves any canvas size. `fit="cover"` means fill the canvas
(background); `fit="region"` means scale the asset to fit inside its (w, h) box.

Bumping TEMPLATE_VERSION changes layout for NEW binds only; existing games pin
the version they were built with (see plan.ScenePlan.template_version).
"""
from dataclasses import dataclass

TEMPLATE_VERSION = 1

BACKGROUND = "background"
REELS = "reels"
LOGO = "logo"
SPIN = "spin"
FLOURISH_LEFT = "flourish_left"
FLOURISH_RIGHT = "flourish_right"


@dataclass(frozen=True)
class RoleRegion:
    role: str
    cx: float
    cy: float
    w: float
    h: float
    anchor_x: float = 0.5
    anchor_y: float = 0.5
    z: int = 0
    fit: str = "region"  # "cover" | "region"


_LANDSCAPE = (
    RoleRegion(BACKGROUND, 0.5, 0.5, 1.0, 1.0, z=0, fit="cover"),
    RoleRegion(LOGO, 0.5, 0.13, 0.52, 0.20, z=40),
    RoleRegion(REELS, 0.5, 0.55, 0.62, 0.60, z=20),
    RoleRegion(SPIN, 0.5, 0.90, 0.13, 0.13, z=50),
    RoleRegion(FLOURISH_LEFT, 0.085, 0.55, 0.17, 0.72, z=30),
    RoleRegion(FLOURISH_RIGHT, 0.915, 0.55, 0.17, 0.72, z=30),
)

_PORTRAIT = (
    RoleRegion(BACKGROUND, 0.5, 0.5, 1.0, 1.0, z=0, fit="cover"),
    RoleRegion(LOGO, 0.5, 0.11, 0.80, 0.14, z=40),
    RoleRegion(REELS, 0.5, 0.50, 0.90, 0.52, z=20),
    RoleRegion(SPIN, 0.5, 0.88, 0.20, 0.11, z=50),
    RoleRegion(FLOURISH_LEFT, 0.12, 0.50, 0.20, 0.60, z=30),
    RoleRegion(FLOURISH_RIGHT, 0.88, 0.50, 0.20, 0.60, z=30),
)

_TEMPLATES = {
    "landscape": {r.role: r for r in _LANDSCAPE},
    "portrait": {r.role: r for r in _PORTRAIT},
}

_CANVAS = {"landscape": (1280, 720), "portrait": (720, 1280)}


def canvas_for(orientation: str) -> tuple[int, int]:
    return _CANVAS.get(orientation, _CANVAS["landscape"])


def template_for(orientation: str) -> dict[str, RoleRegion]:
    return dict(_TEMPLATES.get(orientation, _TEMPLATES["landscape"]))

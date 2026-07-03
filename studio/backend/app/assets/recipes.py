"""Role -> generation profile: the spine of the asset-quality floor.

Same model (flux-dev) for every role; the profile varies sampler params,
negatives, upscale, and the positive-prompt boilerplate. Pure + greppable so
values are tunable in one place, mirroring the ComposeBounds convention.
"""
from dataclasses import dataclass

from app.scene.layout.plan import canonical_role

# Negatives only bite on flux-dev at cfg>1 (a ~2x cost), so they are scoped to
# the one role where legibility/artifact suppression earns it: the logo.
_LOGO_NEGATIVE = (
    "misspelled text, garbled letters, extra letters, duplicated words, "
    "blurry, low-res, jpeg artifacts, watermark, cropped"
)


@dataclass(frozen=True)
class Profile:
    steps: int
    guidance: float
    cfg: float
    negative: str
    upscale: bool
    positive: str
    cut_cells: bool = False  # reels: geometrically cut the transparent play windows


_STANDARD = Profile(
    steps=20, guidance=3.5, cfg=1.0, negative="", upscale=False,
    positive="crisp, clean, centered, high detail, premium slot game art",
)

# Keyed by CANONICAL role (see canonical_role aliases). Anything not listed
# resolves to _STANDARD via profile_for.
_PROFILES: dict[str, Profile] = {
    "background": Profile(
        steps=28, guidance=3.0, cfg=1.0, negative="", upscale=True,
        positive="full-bleed cinematic background scene, depth, atmospheric "
                 "lighting, no text, no UI, high detail",
    ),
    "logo": Profile(
        steps=28, guidance=3.5, cfg=2.0, negative=_LOGO_NEGATIVE, upscale=True,
        positive="bold premium logo wordmark, large clean legible lettering, "
                 "glossy 3D, clean cutout on plain background, studio render",
    ),
    # The reel frame is the paramount slot element: a HERO role (upscale) whose
    # prompt demands a COMPLETE 5x3 frame — full enclosing border with vertical
    # column dividers and cell structure — not a bare border with an empty middle
    # (the failure mode that dogged earlier iterations).
    "reels": Profile(
        steps=28, guidance=3.5, cfg=1.0, negative="", upscale=True, cut_cells=True,
        positive="complete ornate slot machine reel frame, a full rectangular frame "
                 "enclosing a 5 column by 3 row grid, clear vertical column dividers "
                 "and cell borders forming 15 empty symbol cells, solid decorative "
                 "side posts with top and bottom rails, transparent empty cells, "
                 "sharp crisp edges, premium game UI, centered",
    ),
    "spin": Profile(
        steps=20, guidance=3.5, cfg=1.0, negative="", upscale=False,
        positive="glossy circular game button, readable, premium UI, clean cutout",
    ),
}


def profile_for(role: str) -> Profile:
    key = canonical_role(role)
    return _PROFILES.get(key, _STANDARD) if key else _STANDARD


def build_asset_prompt(role: str, art_direction: str, description: str) -> str:
    """Compose the positive prompt: the element's description, the role's
    boilerplate, then the shared art-direction prose. Empty parts dropped;
    exact duplicates removed preserving order."""
    parts = [description.strip(), profile_for(role).positive, art_direction.strip()]
    seen: set[str] = set()
    out: list[str] = []
    for p in parts:
        if p and p not in seen:
            seen.add(p)
            out.append(p)
    return ", ".join(out)

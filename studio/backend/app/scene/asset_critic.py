"""Per-asset quality critic — swappable seam.

Judges ONE generated asset image (is it empty / cut off / low quality / off
theme?), independent of the composed scene. A deterministic heuristic catches
degenerate art (near-empty cutouts, flat fills) before any vision call; the
vision stage (replay cassette or a direct claude-sonnet-4-6 image call) judges
quality/cropping/theme. See
docs/superpowers/specs/2026-06-28-compose-critique-rework-design.md.
"""

import base64
from dataclasses import dataclass
from io import BytesIO
from typing import Literal, Protocol

from langchain_core.messages import BaseMessage
from PIL import Image
from pydantic import BaseModel

from app.config import Settings
from app.replay.cassette import (
    DEFAULT_FIXTURES_DIR,
    load_asset_cassettes,
    normalize_prompt,
)

# Heuristic thresholds (constants so they're greppable / tunable).
MIN_ALPHA_COVERAGE = 0.02          # transparent cutout must cover >2% of the frame
MIN_OPAQUE_ENTROPY = 1.5           # flat/near-single-colour opaque image is degenerate
_ALPHA_VISIBLE = 16                # alpha above this counts as "visible"

# Transparency-integrity thresholds (item 5) — conservative, near-zero false
# positives so legit translucent art (glow/smoke) is left to the vision stage.
SOLID_ALPHA = 240                  # alpha at/above this counts as "fully opaque"
MAX_PARTIAL_ALPHA_FRACTION = 0.85  # >this share of visible px partial AND no core
MIN_OPAQUE_CORE = 0.05             # a real solid has at least this opaque fraction
MAX_INTERIOR_HOLE_FRACTION = 0.04  # interior (non-edge-connected) transparency cap


class AssetVerdict(BaseModel):
    ok: bool = True
    action: Literal["keep", "regenerate"] = "keep"
    reason: str = ""


@dataclass(frozen=True)
class AssetCritiqueRequest:
    image_png: bytes
    role: str
    description: str = ""
    theme: str = ""
    transparent: bool = True


def _interior_hole_fraction(alpha) -> float:
    """Fraction of pixels that are transparent but NOT reachable from the border
    through transparent pixels — i.e. holes punched inside an opaque mass.

    Flood-fills 'outside' transparency inward from the image edge; any remaining
    transparent pixel is an interior hole. O(pixels); assets here are <=512x512.
    """
    w, h = alpha.size
    px = alpha.load()
    transparent = [[px[x, y] <= _ALPHA_VISIBLE for x in range(w)] for y in range(h)]
    outside = [[False] * w for _ in range(h)]
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if transparent[y][x]:
                stack.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if transparent[y][x]:
                stack.append((x, y))
    while stack:
        x, y = stack.pop()
        if x < 0 or y < 0 or x >= w or y >= h or outside[y][x] or not transparent[y][x]:
            continue
        outside[y][x] = True
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    interior = sum(
        1 for y in range(h) for x in range(w)
        if transparent[y][x] and not outside[y][x]
    )
    return interior / max(1, w * h)


def asset_heuristic(image_png: bytes, *, transparent: bool) -> AssetVerdict | None:
    """Cheap, deterministic degenerate-art detector.

    Returns a ``regenerate`` verdict for an empty / near-empty / flat image, or
    ``None`` to defer to the vision stage.

    Byte size is intentionally NOT used as a signal: PNG compression makes it
    resolution/content-dependent (a valid flat or highly-transparent asset can be
    tiny), so alpha-coverage and entropy — which read the actual pixel distribution
    — are the discriminating checks.
    """
    try:
        img = Image.open(BytesIO(image_png)).convert("RGBA")
    except Exception:
        return AssetVerdict(ok=False, action="regenerate", reason="unreadable image")
    total = max(1, img.width * img.height)
    if transparent:
        alpha_hist = img.getchannel("A").histogram()
        visible = sum(alpha_hist[_ALPHA_VISIBLE + 1:])
        frac = visible / total
        if frac < MIN_ALPHA_COVERAGE:
            return AssetVerdict(ok=False, action="regenerate",
                                reason=f"transparent asset almost fully empty "
                                       f"({frac:.1%} covered)")
        alpha = img.getchannel("A")
        opaque = sum(alpha.histogram()[SOLID_ALPHA:])
        opaque_frac = opaque / total
        partial = visible - opaque  # visible but not fully opaque
        partial_frac_of_visible = partial / max(1, visible)
        if partial_frac_of_visible >= MAX_PARTIAL_ALPHA_FRACTION \
                and opaque_frac < MIN_OPAQUE_CORE:
            return AssetVerdict(ok=False, action="regenerate",
                                reason="solid subject is see-through "
                                       "(semi-transparent, no opaque core)")
        if _interior_hole_fraction(alpha) > MAX_INTERIOR_HOLE_FRACTION:
            return AssetVerdict(ok=False, action="regenerate",
                                reason="holes punched in solid area")
    else:
        entropy = img.convert("L").entropy()
        if entropy < MIN_OPAQUE_ENTROPY:
            return AssetVerdict(ok=False, action="regenerate",
                                reason=f"flat/near-blank image (entropy {entropy:.2f})")
    return None


class AssetCritic(Protocol):
    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict: ...


class ReplayAssetCritic:
    """Offline asset critic: heuristic first, then a recorded per-role verdict."""

    def __init__(self, cassettes: dict[str, dict]):
        self._cassettes = cassettes

    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict:
        flagged = asset_heuristic(request.image_png, transparent=request.transparent)
        if flagged is not None:
            return flagged
        data = (self._cassettes.get(normalize_prompt(request.role))
                or self._cassettes.get("__default__"))
        return AssetVerdict(**data) if data else AssetVerdict()


ASSET_SYSTEM_PROMPT = (
    "You are a slot-game ASSET quality critic. You are shown a SINGLE generated "
    "asset image (not the composed scene) and told its intended role. Judge ONLY "
    "this asset on its own: is it empty, cut off at the edges, low quality, or "
    "clearly wrong for its stated role/theme? Backgrounds should be full scenes; "
    "logos/props/characters should be clean, complete, and (when transparent) cut "
    "out cleanly.\n"
    "TEXT: if the asset carries text — a logo wordmark, a UI label, a button "
    "caption — READ it. Flag it 'regenerate' if the text is misspelled, garbled, "
    "duplicated, or illegible, EVEN IF the art is otherwise good (e.g. "
    "'PIRATE FORTUNEE' or 'PHAARAOH'S RIICHES' are unusable).\n"
    "TRANSPARENCY: a solid object must read as solid. Flag it 'regenerate' if a "
    "subject that should be opaque looks semi-transparent, ghostly, or see-through, "
    "or has transparent holes where the background shows through.\n"
    "Return {ok, action, reason} where action is 'keep' if the asset is usable, or "
    "'regenerate' if it must be remade. Prefer 'keep' unless the asset is clearly "
    "unusable."
)


def _data_url(image_png: bytes) -> str:
    return f"data:image/png;base64,{base64.b64encode(image_png).decode('ascii')}"


def build_asset_messages(request: AssetCritiqueRequest) -> list[BaseMessage]:
    from langchain_core.messages import HumanMessage, SystemMessage

    text = (
        f"Judge this asset.\nRole: {request.role}\n"
        f"Intended description: {request.description}\nTheme: {request.theme}\n"
        f"Expected transparent cutout: {request.transparent}"
    )
    return [
        SystemMessage(ASSET_SYSTEM_PROMPT),
        HumanMessage(content=[
            {"type": "text", "text": text},
            {"type": "image_url", "image_url": {"url": _data_url(request.image_png)}},
        ]),
    ]


class LiveAssetCritic:
    """Live asset critic: heuristic first, then a direct structured+image call."""

    def __init__(self, api_key: str, base_url: str, model: str):
        self._api_key = api_key
        self._base_url = base_url
        self._model = model

    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict:
        flagged = asset_heuristic(request.image_png, transparent=request.transparent)
        if flagged is not None:
            return flagged
        from langchain_openai import ChatOpenAI

        llm = ChatOpenAI(model=self._model, api_key=self._api_key, base_url=self._base_url)
        structured = llm.with_structured_output(AssetVerdict)
        return await structured.ainvoke(build_asset_messages(request))


def build_asset_critic(settings: Settings) -> AssetCritic:
    """Select the asset-critic impl by provider mode — mirrors build_scene_critic."""
    if settings.provider_mode == "replay":
        return ReplayAssetCritic(load_asset_cassettes(DEFAULT_FIXTURES_DIR))
    return LiveAssetCritic(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        model=settings.critic_model,
    )

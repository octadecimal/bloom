"""Chroma keying in PIL: backdrop color -> alpha, plus despill.

Class B backdrop techniques generate the subject on a flat key-colored
backdrop; this turns that color into transparency. Pure per-pixel math —
deterministic, GPU-free, unit-testable on tiny images. A 768x768 pass takes
on the order of a second, paid once per render because renders are cached.
"""
from PIL import Image


def sample_key_color(img: Image.Image, step: int = 7) -> tuple[int, int, int]:
    """Per-channel median of the border pixels — the color the backdrop
    ACTUALLY rendered as. Diffusion never paints the literal hex the clause
    asks for (chroma green comes back as a dark desaturated wall), so keying
    on the nominal color removes nothing; the border is the one region
    guaranteed to be backdrop. Median, not mean: a stray highlight or a
    subject tip crossing the border must not drag the key."""
    rgb = img.convert("RGB")
    px = rgb.load()
    w, h = rgb.size
    border = []
    for x in range(0, w, step):
        border.append(px[x, 0])
        border.append(px[x, h - 1])
    for y in range(0, h, step):
        border.append(px[0, y])
        border.append(px[w - 1, y])
    mid = len(border) // 2
    return tuple(sorted(p[i] for p in border)[mid] for i in range(3))


def chroma_key(img: Image.Image, key_color: tuple[int, int, int],
               tolerance: float, softness: float,
               despill: bool = True) -> Image.Image:
    """Alpha from color distance to the key: dist <= tolerance is fully
    transparent, dist >= tolerance + softness fully opaque, linear ramp
    between. Despill clamps the key's dominant channel to the max of the
    other two on visible pixels, so keyed edges lose the color cast."""
    out = img.convert("RGBA")
    px = out.load()
    kr, kg, kb = key_color
    dominant = max(range(3), key=lambda i: (kr, kg, kb)[i])
    w, h = out.size
    for y in range(h):
        for x in range(w):
            r, g, b, _ = px[x, y]
            dist = ((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2) ** 0.5
            if dist <= tolerance:
                alpha = 0
            elif softness <= 0 or dist >= tolerance + softness:
                alpha = 255
            else:
                alpha = round(255 * (dist - tolerance) / softness)
            if despill and alpha > 0:
                channels = [r, g, b]
                others = [c for i, c in enumerate(channels) if i != dominant]
                channels[dominant] = min(channels[dominant], max(others))
                r, g, b = channels
            px[x, y] = (r, g, b, alpha)
    return out

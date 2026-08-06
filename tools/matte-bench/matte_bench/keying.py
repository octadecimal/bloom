"""Chroma keying in PIL: backdrop color -> alpha, plus despill.

Class B backdrop techniques generate the subject on a flat key-colored
backdrop; this turns that color into transparency. Pure per-pixel math —
deterministic, GPU-free, unit-testable on tiny images. A 768x768 pass takes
on the order of a second, paid once per render because renders are cached.
"""
from PIL import Image


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

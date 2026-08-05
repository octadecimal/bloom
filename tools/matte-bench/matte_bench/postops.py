"""Alpha post-processing, in Python rather than ComfyUI nodes.

Same result, no GPU round-trip, and unit-testable on 40x40 images. These are
ranked like any other technique, not hand-tuned.
"""
from PIL import Image, ImageFilter

_VISIBLE = 16


def _components(mask: bytearray, w: int, h: int):
    """Yield lists of pixel indices, one per 4-connected run of set pixels."""
    seen = bytearray(w * h)
    for start in range(w * h):
        if not mask[start] or seen[start]:
            continue
        seen[start] = 1
        stack = [start]
        members = []
        while stack:
            i = stack.pop()
            members.append(i)
            y, x = divmod(i, w)
            if x > 0 and mask[i - 1] and not seen[i - 1]:
                seen[i - 1] = 1
                stack.append(i - 1)
            if x < w - 1 and mask[i + 1] and not seen[i + 1]:
                seen[i + 1] = 1
                stack.append(i + 1)
            if y > 0 and mask[i - w] and not seen[i - w]:
                seen[i - w] = 1
                stack.append(i - w)
            if y < h - 1 and mask[i + w] and not seen[i + w]:
                seen[i + w] = 1
                stack.append(i + w)
        yield members


def _alpha_mask(img: Image.Image, visible: bool) -> bytearray:
    data = img.getchannel("A").tobytes()
    if visible:
        return bytearray(1 if v > _VISIBLE else 0 for v in data)
    return bytearray(1 if v <= _VISIBLE else 0 for v in data)


def threshold_alpha(img: Image.Image, cutoff: int) -> Image.Image:
    out = img.copy()
    a = out.getchannel("A").point(lambda v: 255 if v >= cutoff else 0)
    out.putalpha(a)
    return out


def despeckle(img: Image.Image, min_area_frac: float) -> Image.Image:
    out = img.copy()
    w, h = out.size
    limit = min_area_frac * w * h
    if limit <= 0:
        return out
    px = out.load()
    for members in _components(_alpha_mask(out, visible=True), w, h):
        if len(members) >= limit:
            continue
        for i in members:
            y, x = divmod(i, w)
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 0)
    return out


def hole_fill(img: Image.Image, max_area_frac: float) -> Image.Image:
    out = img.copy()
    w, h = out.size
    limit = max_area_frac * w * h
    px = out.load()
    for members in _components(_alpha_mask(out, visible=False), w, h):
        if len(members) > limit:
            continue
        touches_border = any(
            (i % w) in (0, w - 1) or (i // w) in (0, h - 1) for i in members
        )
        if touches_border:
            continue  # background, not an enclosed hole
        for i in members:
            y, x = divmod(i, w)
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 255)
    return out


def grow_alpha(img: Image.Image, px: int) -> Image.Image:
    if px == 0:
        return img.copy()
    size = abs(px) * 2 + 1
    a = img.getchannel("A")
    a = a.filter(ImageFilter.MaxFilter(size) if px > 0 else ImageFilter.MinFilter(size))
    out = img.copy()
    out.putalpha(a)
    return out


def feather_alpha(img: Image.Image, radius: int) -> Image.Image:
    if radius <= 0:
        return img.copy()
    out = img.copy()
    out.putalpha(img.getchannel("A").filter(ImageFilter.GaussianBlur(radius)))
    return out


_OPS = {
    "threshold": lambda im, v: threshold_alpha(im, int(v)),
    "despeckle": despeckle,
    "hole_fill": hole_fill,
    "grow": lambda im, v: grow_alpha(im, int(v)),
    "feather": lambda im, v: feather_alpha(im, int(v)),
}


def apply_postops(img: Image.Image, ops: tuple[tuple[str, float], ...]) -> Image.Image:
    out = img
    for name, value in ops:
        if name not in _OPS:
            raise ValueError(f"unknown post-op: {name}")
        out = _OPS[name](out, value)
    return out

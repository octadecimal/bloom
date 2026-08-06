"""Region keying in PIL: border-connected backdrop -> alpha, plus despill.

Class B backdrop techniques generate the subject on a flat key-colored
backdrop; this turns that color into transparency. Pure per-pixel math —
deterministic, GPU-free, unit-testable on tiny images. Three linear passes
plus two BFS walks in pure Python — several seconds at 768x768, paid once
per render because renders are cached.
"""
from collections import deque

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


def region_key(img: Image.Image, key_color: tuple[int, int, int], *,
               seed_tolerance: float, step_tolerance: float,
               envelope: float, hole_tolerance: float, softness: float,
               despill: bool = True) -> Image.Image:
    """Border-connected region key.

    A global color test cannot tell 'backdrop that drifted' (halo, vignette,
    soft shadow) from 'subject that happens to sit near the key color' — the
    first must be keyed, the second must not. Connectivity can: the backdrop
    is grown from the border, one small color step at a time, so smooth
    gradients are followed and sharp subject edges are not crossed. Alpha for
    everything else ramps on distance to the nearest grown pixel's color,
    which both clears enclosed holes (they match their surrounding backdrop)
    and keeps the soft-edge ramp.

    `envelope` bounds the walk's total drift: a soft drop shadow is a smooth
    ramp from backdrop to near-black, and without a cap the chain crosses it
    into the subject and erases solid dark art (measured live: crisp-text
    letters at drift 246 grow-keyed through their own shadows). Nothing
    farther than `envelope` from the key color is ever grow-keyed, whatever
    the chain says.
    """
    src = img.convert("RGB")
    w, h = src.size
    px = src.load()

    def dist(a, b):
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2
                + (a[2] - b[2]) ** 2) ** 0.5

    keyed = bytearray(w * h)
    queue = deque()

    def seed(x, y):
        i = y * w + x
        if not keyed[i] and dist(px[x, y], key_color) <= seed_tolerance:
            keyed[i] = 1
            queue.append((x, y))

    for x in range(w):
        seed(x, 0)
        seed(x, h - 1)
    for y in range(h):
        seed(0, y)
        seed(w - 1, y)

    while queue:
        x, y = queue.popleft()
        c = px[x, y]
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not keyed[ny * w + nx]:
                if (dist(px[nx, ny], c) <= step_tolerance
                        and dist(px[nx, ny], key_color) <= envelope):
                    keyed[ny * w + nx] = 1
                    queue.append((nx, ny))

    out = img.convert("RGBA")
    if not any(keyed):
        return out

    # Multi-source BFS: every pixel learns the color of its spatially
    # nearest keyed pixel — the local backdrop estimate the ramp keys on.
    anchor: list = [None] * (w * h)
    q2 = deque()
    for i in range(w * h):
        if keyed[i]:
            anchor[i] = px[i % w, i // w]
            q2.append((i % w, i // w))
    while q2:
        x, y = q2.popleft()
        a = anchor[y * w + x]
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and anchor[ny * w + nx] is None:
                anchor[ny * w + nx] = a
                q2.append((nx, ny))

    opx = out.load()
    kr, kg, kb = key_color
    dominant = max(range(3), key=lambda i: (kr, kg, kb)[i])
    for y in range(h):
        for x in range(w):
            i = y * w + x
            r, g, b, _ = opx[x, y]
            if keyed[i]:
                alpha = 0
            else:
                d = dist((r, g, b), anchor[i])
                if d <= hole_tolerance:
                    alpha = 0
                elif softness <= 0 or d >= hole_tolerance + softness:
                    alpha = 255
                else:
                    alpha = round(255 * (d - hole_tolerance) / softness)
            if despill and alpha > 0:
                channels = [r, g, b]
                others = [c for j, c in enumerate(channels) if j != dominant]
                channels[dominant] = min(channels[dominant], max(others))
                r, g, b = channels
            opx[x, y] = (r, g, b, alpha)
    return out

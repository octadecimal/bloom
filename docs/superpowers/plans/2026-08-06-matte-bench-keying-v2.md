# Matte Bench Keying v2 + Original Truthfulness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the global chroma key with a border-connected, gradient-tolerant region key (kills halo retention and subject erosion), harden the backdrop clauses against vignettes, and make the judging UI's "original" toggle truthful per comparison class.

**Architecture:** All work is inside `tools/matte-bench/`. `keying.py` gets a new pure function `region_key` (BFS region grow + nearest-keyed-anchor alpha ramp) replacing `chroma_key`; `techniques.py` re-parameterizes the two backdrop variants (which retires their config hashes — intended); `render.py` writes each backdrop render's pre-key generation as a `.orig.png` sibling; `web.py` serves it; `static/index.html` shows per-side originals for Class B.

**Tech Stack:** Python 3.12, PIL (Pillow), FastAPI + TestClient, pytest. Pure stdlib + PIL only — **no numpy or new dependencies**.

**Spec:** `docs/superpowers/specs/2026-08-06-matte-bench-keying-v2-design.md` (committed on this branch).

## Global Constraints

- Test command (run from the worktree root): `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q` — the bench imports `app.assets.*` from the studio backend, so tests MUST run from `studio/backend`.
- Keying stays deterministic, GPU-free, pure PIL + stdlib. No numpy.
- Semantic commit format (`feat(matte-bench): …`, `test(matte-bench): …` etc.), imperative mood.
- TDD: write the failing test, SEE it fail, then implement. Never skip the red run.
- No Playwright / browser tests (repo-wide ruling); `index.html` changes are verified manually.
- Old retired technique hashes must never come back: `26ebdc9a25576982`, `8d9d35012cc502c2` (poisoned, PR #229) and now `552a60c75a287bb0`, `4bc8eba4d3cfc3d5` (keying v1).
- The verdict log is append-only and never rewritten.

---

### Task 1: `region_key` — border-connected, gradient-tolerant keyer

**Files:**

- Modify: `tools/matte-bench/matte_bench/keying.py` (add `region_key`, delete `chroma_key`; keep `sample_key_color` unchanged)
- Modify: `tools/matte-bench/tests/test_keying.py` (replace `chroma_key` tests with the `region_key` contract)

**Interfaces:**

- Consumes: `sample_key_color(img) -> tuple[int, int, int]` (existing, unchanged).
- Produces: `region_key(img: Image.Image, key_color: tuple[int, int, int], *, seed_tolerance: float, step_tolerance: float, hole_tolerance: float, softness: float, despill: bool = True) -> Image.Image` — RGBA output; Task 3 calls it from `render.py`.

Algorithm (from the spec): (1) seed = border pixels within `seed_tolerance` of `key_color`; (2) BFS grow: a 4-neighbor joins the backdrop when its color is within `step_tolerance` of the pixel it grew from (smooth gradients pass, sharp edges block); (3) every keyed pixel gets alpha 0; (4) every other pixel gets alpha from a linear ramp of its color distance to the **spatially nearest keyed pixel's color** (multi-source BFS propagates that anchor): `<= hole_tolerance` → 0 (enclosed holes clear), `>= hole_tolerance + softness` → 255, linear between; (5) despill on visible pixels exactly as before.

- [ ] **Step 1: Replace `tests/test_keying.py` with the failing contract tests**

```python
from PIL import Image

from matte_bench.keying import region_key, sample_key_color

BACKDROP = (15, 38, 38)          # what flux actually paints for "chroma green"
SUBJECT = (200, 160, 40)
KW = dict(seed_tolerance=60, step_tolerance=12, hole_tolerance=25,
          softness=30, despill=True)


def _flat(color, size=(8, 8)):
    return Image.new("RGB", size, color)


def _bordered(border_color, center_color, size=(32, 32)):
    img = Image.new("RGB", size, border_color)
    for x in range(8, 24):
        for y in range(8, 24):
            img.putpixel((x, y), center_color)
    return img


def test_sample_key_color_reads_border_not_subject():
    """Flux never paints the literal hex we ask for (a chroma-green clause
    comes back as a dark desaturated wall), so the key must be measured from
    the render's own border, where only backdrop pixels live."""
    img = _bordered(BACKDROP, SUBJECT)
    assert sample_key_color(img) == BACKDROP


def test_sample_key_color_is_median_robust_to_border_speck():
    img = _bordered(BACKDROP, SUBJECT)
    img.putpixel((0, 0), (255, 255, 255))   # one stray highlight on the border
    assert sample_key_color(img) == BACKDROP


def test_flat_backdrop_fully_keyed():
    out = region_key(_flat(BACKDROP), BACKDROP, **KW)
    assert out.mode == "RGBA"
    assert all(a == 0 for a in out.getchannel("A").getdata())


def test_gradient_backdrop_fully_keyed():
    """The halo case: the backdrop drifts far from the border median, but it
    drifts SMOOTHLY — the region grow must follow it. A global key at any
    sane tolerance keeps the far end of this ramp."""
    img = Image.new("RGB", (64, 8))
    for x in range(64):
        v = round(x * 120 / 63)              # 0 → 120, ~2 per column
        for y in range(8):
            img.putpixel((x, y), (15 + v, 38 + v, 38 + v))
    out = region_key(img, sample_key_color(img), **KW)
    assert all(a == 0 for a in out.getchannel("A").getdata())


def test_sharp_subject_stays_opaque():
    out = region_key(_bordered(BACKDROP, SUBJECT), BACKDROP, **KW)
    assert out.getpixel((16, 16))[3] == 255
    assert out.getpixel((0, 0))[3] == 0


def test_disconnected_near_key_region_survives():
    """The erosion case: a patch INSIDE the subject whose color is fairly
    close to the backdrop (dist ~64 — the old global key at 60+60 ate it).
    It is not border-connected and not within the strict hole ramp, so it
    must survive."""
    img = _bordered(BACKDROP, SUBJECT)
    for x in range(12, 20):
        for y in range(12, 20):
            img.putpixel((x, y), (45, 78, 78))     # dist from BACKDROP ≈ 64
    out = region_key(img, BACKDROP, **KW)
    assert out.getpixel((16, 16))[3] == 255


def test_enclosed_hole_matching_backdrop_is_keyed():
    """The enclosed-holes case: a hole showing actual backdrop color inside
    the subject must still clear, even though the grow can't reach it."""
    img = _bordered(BACKDROP, SUBJECT)
    for x in range(14, 18):
        for y in range(14, 18):
            img.putpixel((x, y), BACKDROP)
    out = region_key(img, BACKDROP, **KW)
    assert out.getpixel((16, 16))[3] == 0
    assert out.getpixel((10, 10))[3] == 255        # subject ring intact


def test_soft_edge_ramp():
    """A pixel between hole_tolerance and hole_tolerance+softness of its
    nearest keyed anchor gets partial alpha — the fur/wisp edge quality."""
    img = _bordered(BACKDROP, SUBJECT)
    img.putpixel((16, 16), (15 + 23, 38 + 23, 38 + 23))   # dist ≈ 40 from BACKDROP
    out = region_key(img, BACKDROP, **KW)
    a = out.getpixel((16, 16))[3]
    assert 100 <= a <= 155      # ramp midpoint ≈ 255*(40-25)/30 ≈ 128


def test_despill_clamps_key_dominant_channel():
    green = (0, 177, 64)
    img = _bordered(green, (80, 200, 90))
    out = region_key(img, green, **KW)
    r, g, b, a = out.getpixel((16, 16))
    if a > 0:
        assert g <= max(r, b)


def test_despill_off_preserves_color():
    img = _bordered(BACKDROP, SUBJECT)
    out = region_key(img, BACKDROP, **{**KW, "despill": False})
    assert out.getpixel((16, 16))[:3] == SUBJECT


def test_no_backdrop_found_keeps_everything():
    """If no border pixel matches the key (degenerate render), nothing is
    keyed rather than everything."""
    out = region_key(_flat(SUBJECT), BACKDROP, **KW)
    assert all(a == 255 for a in out.getchannel("A").getdata())


def test_input_not_mutated():
    src = _flat(BACKDROP)
    region_key(src, BACKDROP, **KW)
    assert src.getpixel((0, 0)) == BACKDROP


def test_deterministic():
    img = _bordered(BACKDROP, SUBJECT)
    a = region_key(img, BACKDROP, **KW).tobytes()
    b = region_key(img, BACKDROP, **KW).tobytes()
    assert a == b
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_keying.py -q`
Expected: FAIL — `ImportError: cannot import name 'region_key'`.

- [ ] **Step 3: Implement `region_key` in `keying.py`, delete `chroma_key`**

Replace the whole `chroma_key` function with (keep the module docstring, update its wording to describe region keying; keep `sample_key_color` exactly as is):

```python
from collections import deque


def region_key(img: Image.Image, key_color: tuple[int, int, int], *,
               seed_tolerance: float, step_tolerance: float,
               hole_tolerance: float, softness: float,
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
                if dist(px[nx, ny], c) <= step_tolerance:
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
```

Update the module docstring's performance note honestly: three linear passes plus two BFS walks in pure Python — several seconds at 768², paid once per render because renders are cached.

- [ ] **Step 4: Run the keying tests, verify all pass**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_keying.py -q`
Expected: all PASS. If `test_gradient_backdrop_fully_keyed` fails, check the seeding: the gradient's far columns exceed `seed_tolerance` of the median — they must be reached by the GROW along the smooth ramp, which requires the border ring loop to seed only qualifying pixels (not skip the grow).

- [ ] **Step 5: Run the whole bench suite — expect ONLY `render` failures**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: `test_render.py` fails on the deleted `chroma_key` import (render.py still imports it). That is Task 3's job. If anything ELSE fails, stop and fix before committing.
To keep the tree green per commit, do Task 3's render.py import fix ONLY if trivially needed — otherwise commit keying and tests together with render still red is NOT acceptable: instead, commit after Task 3's Step 3 below makes render.py compile. Preferred: proceed to Task 2 (techniques) which is independent, and commit Tasks 1+3 pieces in Task 3. **Simpler rule an implementer should follow: do Task 1 and Task 3 in one sitting if the suite cannot be green in between; the task split exists for review, not for broken intermediate commits.** Concretely: `render.py` imports `chroma_key` at module top — change that import line now (`from matte_bench.keying import region_key, sample_key_color`) and change the `chroma_key(...)` call as Task 3 Step 3 specifies, then run the suite; only `test_render.py`'s old-param fixtures may still fail (they are updated in Task 3 Step 1, which you can pull forward).

- [ ] **Step 6: Commit** (once the suite is green — possibly combined with Task 3's changes)

```bash
git add tools/matte-bench/matte_bench/keying.py tools/matte-bench/tests/test_keying.py
git commit -m "feat(matte-bench): region-grow keying, gradient-tolerant and connectivity-aware"
```

---

### Task 2: Techniques — new params, hardened clause, retired hashes pinned

**Files:**

- Modify: `tools/matte-bench/matte_bench/techniques.py` (`BACKDROP_VARIANTS`, `backdrop_techniques`)
- Modify: `tools/matte-bench/tests/test_techniques.py`

**Interfaces:**

- Produces: `backdrop_techniques() -> list[Technique]` where each `t.params` now carries keys `clause, key_color, key_source, seed_tolerance, step_tolerance, hole_tolerance, softness, despill`. Task 3's render path reads exactly these names.

- [ ] **Step 1: Update the failing tests first**

In `tests/test_techniques.py`, replace `test_backdrop_hashes_left_poisoned_identities_behind` and `test_backdrop_techniques_are_class_b_with_key_params` with:

```python
def test_backdrop_hashes_left_retired_identities_behind():
    """26ebdc9a25576982 / 8d9d35012cc502c2 are poisoned (both_bad verdicts
    against never-keyed renders, PR #229). 552a60c75a287bb0 /
    4bc8eba4d3cfc3d5 are keying v1 (global key: halo retention + subject
    erosion, measured live 2026-08-06). The log is append-only, so keying v2
    must carry fresh identities."""
    from matte_bench.techniques import backdrop_techniques
    retired = {"26ebdc9a25576982", "8d9d35012cc502c2",
               "552a60c75a287bb0", "4bc8eba4d3cfc3d5"}
    assert {config_hash(t) for t in backdrop_techniques()}.isdisjoint(retired)


def test_backdrop_techniques_are_class_b_with_key_params():
    from matte_bench.techniques import backdrop_techniques
    got = backdrop_techniques()
    assert len(got) == 2
    assert all(t.cls == "B" and t.node == "backdrop-key" for t in got)
    for t in got:
        assert {"clause", "key_color", "key_source", "seed_tolerance",
                "step_tolerance", "hole_tolerance", "softness",
                "despill"} <= set(t.params)
        assert t.params["key_source"] == "border-median"
    assert len({config_hash(t) for t in got}) == 2   # variants hash apart


def test_backdrop_clause_fights_the_vignette():
    """Layered halo defense: the clause asks flux for a uniform backdrop so
    the keyer has less gradient to chase."""
    from matte_bench.techniques import BACKDROP_VARIANTS
    for _, _, clause in BACKDROP_VARIANTS:
        assert "no vignetting" in clause
        assert "no gradient" in clause
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_techniques.py -q`
Expected: FAIL — old param names, no vignette wording.

- [ ] **Step 3: Implement in `techniques.py`**

Replace `BACKDROP_VARIANTS` and `backdrop_techniques` with:

```python
# Class B, family 1: generate the subject on a flat key-colored backdrop and
# key the color out afterwards (see matte_bench.keying). The clause is part of
# the technique config, so editing it re-renders (config_hash covers params) —
# which is also why this wording must not revert: retired hashes carry
# verdicts cast against worse renders (see tests: retired identities).
BACKDROP_VARIANTS = (
    ("chroma-green", (0, 177, 64),
     "isolated on a solid flat chroma green (#00B140) studio backdrop "
     "filling the entire frame, perfectly uniform color, no vignetting, "
     "no glow, no gradient, no light bloom, even lighting, no shadows on "
     "the backdrop"),
    ("chroma-magenta", (255, 0, 144),
     "isolated on a solid flat chroma magenta (#FF0090) studio backdrop "
     "filling the entire frame, perfectly uniform color, no vignetting, "
     "no glow, no gradient, no light bloom, even lighting, no shadows on "
     "the backdrop"),
)


def backdrop_techniques() -> list[Technique]:
    out = []
    for name, key_color, clause in BACKDROP_VARIANTS:
        out.append(Technique(
            id=f"backdrop-{name}", cls="B", node="backdrop-key", model=name,
            params={"clause": clause, "key_color": list(key_color),
                    "key_source": "border-median",
                    "seed_tolerance": 60, "step_tolerance": 12,
                    "hole_tolerance": 25, "softness": 30, "despill": 1},
            post=()))
    return out
```

- [ ] **Step 4: Run techniques tests, verify pass**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_techniques.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/techniques.py tools/matte-bench/tests/test_techniques.py
git commit -m "feat(matte-bench): retire keying-v1 hashes; region params + anti-vignette clause"
```

---

### Task 3: Render — wire `region_key`, cache the pre-key original

**Files:**

- Modify: `tools/matte-bench/matte_bench/render.py`
- Modify: `tools/matte-bench/tests/test_render.py`

**Interfaces:**

- Consumes: `region_key(...)` from Task 1, params names from Task 2.
- Produces: `orig_path(root: Path, subject_id: str, t: Technique) -> Path` returning `root / "renders" / subject_id / f"{config_hash(t)}.orig.png"`. Task 4's route reads the same `<hash>.orig.png` naming.

- [ ] **Step 1: Update the failing tests first**

In `tests/test_render.py`:

1. Update the `_b()` fixture params to the new names:

```python
def _b(**over):
    base = dict(id="backdrop-chroma-green", cls="B", node="backdrop-key",
                model="chroma-green",
                params={"clause": "isolated on a solid flat chroma green backdrop",
                        "key_color": [0, 177, 64],
                        "key_source": "border-median",
                        "seed_tolerance": 60, "step_tolerance": 12,
                        "hole_tolerance": 25, "softness": 30, "despill": 1},
                post=())
    return Technique(**{**base, **over})
```

2. In `test_backdrop_render_keys_on_sampled_border_color`, drop the now-redundant param override line — replace

```python
    t = _b(params={**_b().params, "key_source": "border-median"})
    dest = asyncio.run(ensure_render(s, t, tmp_path, "http://gpu:8188"))
```

with

```python
    dest = asyncio.run(ensure_render(s, _b(), tmp_path, "http://gpu:8188"))
```

3. Append the original-sibling tests:

```python
from matte_bench.render import orig_path


def test_orig_path_is_sibling_of_render(tmp_path: Path):
    t = _b()
    assert orig_path(tmp_path, "s1", t).name == f"{config_hash(t)}.orig.png"
    assert orig_path(tmp_path, "s1", t).parent == render_path(tmp_path, "s1", t).parent


def test_backdrop_render_writes_pre_key_original(tmp_path, monkeypatch):
    """The judging UI's 'original' toggle must show what each Class B side
    was keyed FROM — that image exists only if the render path saves it."""
    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            from matte_bench.render import ImageEvent
            yield ImageEvent(data=_flat_png((0, 177, 64)))

    monkeypatch.setattr("matte_bench.render.LiveComfyProvider", FakeProvider)
    s = Subject(id="s1", bucket="wispy", prompt="a fern", seed=3,
                width=16, height=16)
    asyncio.run(ensure_render(s, _b(), tmp_path, "http://gpu:8188"))
    orig = orig_path(tmp_path, "s1", _b())
    assert orig.exists()
    assert Image.open(orig).getpixel((0, 0)) == (0, 177, 64)   # pre-key pixels


def test_class_a_render_writes_no_original(tmp_path, monkeypatch):
    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            from matte_bench.render import ImageEvent
            yield ImageEvent(data=_flat_png((1, 2, 3)))

    monkeypatch.setattr("matte_bench.render.LiveComfyProvider", FakeProvider)
    monkeypatch.setattr("matte_bench.render.upload_plate",
                        lambda base_url, plate: "plate.png")
    plate = plate_path(tmp_path, "s1")
    plate.parent.mkdir(parents=True, exist_ok=True)
    plate.write_bytes(_flat_png((1, 2, 3)))
    s = Subject(id="s1", bucket="wispy", prompt="a fern", seed=3,
                width=16, height=16)
    asyncio.run(ensure_render(s, _t(), tmp_path, "http://gpu:8188"))
    assert not orig_path(tmp_path, "s1", _t()).exists()
```

- [ ] **Step 2: Run to verify failures**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_render.py -q`
Expected: FAIL — `orig_path` not defined (and, if Task 1 landed first, the `chroma_key` import error).

- [ ] **Step 3: Implement in `render.py`**

1. Change the keying import line to:

```python
from matte_bench.keying import region_key, sample_key_color
```

2. Add next to `render_path`:

```python
def orig_path(root: Path, subject_id: str, t: Technique) -> Path:
    """The pre-key generation a backdrop render was keyed from — cached so
    the judging UI can show each Class B side's own original."""
    return root / "renders" / subject_id / f"{config_hash(t)}.orig.png"
```

3. Change `_produce_class_b` to take `root` and write the original before keying — replace the whole function with:

```python
async def _produce_class_b(s: Subject, t: Technique, root: Path,
                           comfy_url: str, on_progress) -> bytes | None:
    if t.node == "backdrop-key":
        prompt = backdrop_prompt(s.prompt, t.params["clause"])
        graph = build_graph(PLATE_WORKFLOW, prompt, s.width, s.height, s.seed)
        image = await _generate(graph, comfy_url, on_progress)
        if not image:
            return image
        atomic_write_bytes(orig_path(root, s.id, t), image)
        rendered = Image.open(BytesIO(image)).convert("RGB")
        key = (sample_key_color(rendered)
               if t.params.get("key_source") == "border-median"
               else tuple(t.params["key_color"]))
        keyed = region_key(rendered, key,
                           seed_tolerance=t.params["seed_tolerance"],
                           step_tolerance=t.params["step_tolerance"],
                           hole_tolerance=t.params["hole_tolerance"],
                           softness=t.params["softness"],
                           despill=bool(t.params.get("despill", 1)))
        buf = BytesIO()
        keyed.save(buf, "PNG")
        return buf.getvalue()
    if t.node == "qwen-layered":
        graph = qwen_graph(t, s.prompt, s.width, s.height, s.seed)
        return await _generate(graph, comfy_url, on_progress)
    raise RenderError(t.id, f"unknown class B node: {t.node}")
```

4. Update the call in `ensure_render`:

```python
        if t.cls == "B":
            image = await _produce_class_b(s, t, root, comfy_url, on_progress)
```

- [ ] **Step 4: Run the FULL suite, verify green**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: all PASS (this closes Task 1's temporary red if the tasks were done together).

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/render.py tools/matte-bench/tests/test_render.py
git commit -m "feat(matte-bench): cache pre-key original beside each backdrop render"
```

---

### Task 4: Web — serve the original

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (new route, next to `api_render`)
- Modify: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: the `<hash>.orig.png` naming from Task 3.
- Produces: `GET /original/{subject}/{technique}.png` → the pre-key image, 404 when absent. Task 5's UI fetches exactly this URL.

- [ ] **Step 1: Write the failing route tests**

Append to `tests/test_web.py` (the file's `_client(tmp_path)` helper builds a TestClient around `state`; `state.root` is `tmp_path`):

```python
def test_original_route_serves_pre_key_image(tmp_path):
    client = _client(tmp_path)
    d = tmp_path / "renders" / "s1"
    d.mkdir(parents=True)
    (d / "abc123.orig.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    resp = client.get("/original/s1/abc123.png")
    assert resp.status_code == 200
    assert resp.content.startswith(b"\x89PNG")


def test_original_route_404_when_absent(tmp_path):
    client = _client(tmp_path)
    (tmp_path / "renders" / "s1").mkdir(parents=True)
    assert client.get("/original/s1/abc123.png").status_code == 404


def test_original_route_rejects_traversal(tmp_path):
    client = _client(tmp_path)
    (tmp_path / "renders").mkdir(parents=True)
    secret = tmp_path / "secret.orig.png"
    secret.write_bytes(b"\x89PNG top secret")
    resp = client.get("/original/%2e%2e/secret.png")
    assert resp.status_code == 404
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q -k original`
Expected: `test_original_route_serves_pre_key_image` FAILS (route missing, FastAPI answers 404 where 200 is expected). The other two pass vacuously — that's fine; the first test is the red gate.

- [ ] **Step 3: Implement the route in `web.py`**

Add directly below `api_render`:

```python
@app.get("/original/{subject}/{technique}.png")
def api_original(subject: str, technique: str) -> FileResponse:
    """The pre-key generation a Class B backdrop render was keyed from.

    Same traversal rule as /render: both path parameters are
    attacker-controlled and the service binds to 0.0.0.0, so the resolved
    path must stay inside the renders directory."""
    root = (state.root / "renders").resolve()
    path = (root / subject / f"{technique}.orig.png").resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(status_code=404, detail="original not found")
    return FileResponse(path, media_type="image/png")
```

- [ ] **Step 4: Run web tests, verify pass**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): serve pre-key originals for Class B sides"
```

---

### Task 5: UI — truthful per-class original toggle

**Files:**

- Modify: `tools/matte-bench/matte_bench/static/index.html`

No automated tests (repo ruling: no browser harness for the bench). Verified manually in Task 6's live walkthrough. Keep the changes minimal and surgical.

- [ ] **Step 1: Load the technique→class map once at startup**

Near the other top-level `let` declarations (around `originalMode`), add:

```js
let techniqueCls = {};
```

In the startup sequence (the code that runs `load()` on page open — find `load();` near the bottom), fetch the map first:

```js
fetch('/api/techniques')
  .then((r) => r.json())
  .then((m) => {
    for (const [h, v] of Object.entries(m)) techniqueCls[h] = v.cls;
  })
  .catch(() => {});
```

- [ ] **Step 2: Add per-side original painting**

Below `paintPlate`, add:

```js
// Class B sides were not cut from the plate — each shows its OWN pre-key
// generation. Falls back to the keyed render if no original exists
// (legacy cache, native-RGBA techniques).
function paintSideOriginal(el, subject, technique) {
  if (techniqueCls[technique] !== 'B') return paintPlate(el, subject);
  return new Promise((resolve) => {
    el.onload = () => resolve();
    el.onerror = () => {
      paint(el, subject, technique).then(resolve);
    };
    el.src = `/original/${subject}/${technique}.png`;
  });
}

function originalNotice() {
  if (!current) return '';
  if (current.cls === 'B') return "showing each side's OWN generation (pre-key) — sides differ by design";
  if (current.cls === 'X') return "showing each side's own source";
  return 'showing ORIGINAL — same source for both sides';
}
```

- [ ] **Step 3: Use them in `repaint()`**

In `repaint()`, replace

```js
    document.getElementById('originalNotice').textContent = originalMode ? 'showing ORIGINAL — same source for both sides' : '';
    if (originalMode) {
      await Promise.all([paintPlate(imgL, current.subject), paintPlate(imgR, current.subject)]);
```

with

```js
    document.getElementById('originalNotice').textContent = originalMode ? originalNotice() : '';
    if (originalMode) {
      await Promise.all([paintSideOriginal(imgL, current.subject, current.left), paintSideOriginal(imgR, current.subject, current.right)]);
```

- [ ] **Step 4: Sanity-check the page loads**

Run (from the worktree root; the worktree's port offset is 2, so the bench binds 8402 only if offset is applied — `run.py` binds 8400 regardless, so use a spare port check first: `Get-NetTCPConnection -LocalPort 8400 -State Listen` in PowerShell; if the primary bench is running on 8400, do NOT start a second one — static review of the diff plus Task 6's live verification on the primary covers this).
If 8400 is free: `cd studio/backend && uv run python ../../tools/matte-bench/run.py`, open `http://localhost:8400`, confirm the page loads and the console shows no JS errors, then stop it.

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/static/index.html
git commit -m "feat(matte-bench): per-class original toggle - Class B shows each side's own generation"
```

---

### Task 6: Full suite, push, PR

- [ ] **Step 1: Full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: all PASS.

- [ ] **Step 2: Studio backend suite (the bench imports its provider code — prove no regression)**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: all PASS.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/matte-keying-v2
gh pr create --title "feat(matte-bench): region-grow keying v2 + truthful Class B originals" --body "<summary of the three pieces, spec link, test counts>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Post-merge (operator's-seat rule, NOT part of this branch): restart the :8400 bench from `C:\code\bloom`, confirm `/api/techniques` lists two NEW Class B hashes (not `552a60c75a287bb0`/`4bc8eba4d3cfc3d5`), judge at least one Class B comparison per bucket checking halo, erosion, and the `o` toggle per class.

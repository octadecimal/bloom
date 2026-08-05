# Matte Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone human-in-the-loop bench that ranks transparency-masking techniques by blind pairwise comparison, per bucket of image characteristic.

**Architecture:** A Python service in `tools/matte-bench/` running under the studio backend's venv, importing the real `LiveComfyProvider` and `build_graph` so it measures the actual pipeline. Plates (raw pre-matting images) are generated once via the `dev-opaque` workflow and cached; techniques then re-mat that same plate, so every Class A comparison is byte-identical art. Pure units (`pairing`, `ranking`, `postops`) carry the logic and are tested without a GPU.

**Tech Stack:** Python 3.12, FastAPI + uvicorn, Pillow, httpx, vanilla JS/HTML (no build step), pytest.

## Global Constraints

- Python `>=3.12`; runs under `studio/backend`'s uv venv. Never create a second venv.
- The bench imports from `app.*`; **nothing in `studio/` may import the bench**.
- Bind to `8400 + BLOOM_PORT_OFFSET` (offset defaults to `0`).
- Total footprint outside `tools/matte-bench/`: one `justfile` recipe, one `.gitignore` entry.
- Committed: `subjects.json`, `techniques.json`, `verdicts.jsonl`, `faults.jsonl`. Gitignored: `var/matte-bench/`.
- All cache writes are atomic (temp file then `os.replace`).
- Class A and Class B verdicts are **never pooled** in a ranking.
- Markdown must pass `npx prettier --check .` before commit.
- Semantic commits (`feat:`, `fix:`, `test:`, `chore:`).

---

### Task 1: Scaffold, launcher, and technique availability probe

**Files:**

- Create: `tools/matte-bench/run.py`
- Create: `tools/matte-bench/matte_bench/__init__.py`
- Create: `tools/matte-bench/matte_bench/probe.py`
- Create: `tools/matte-bench/matte_bench/cli.py`
- Create: `tools/matte-bench/matte_bench/web.py` (stub; replaced in Task 9)
- Create: `tools/matte-bench/tests/conftest.py`
- Create: `tools/matte-bench/tests/test_probe.py`
- Modify: `justfile` (append recipe)
- Modify: `.gitignore` (append `var/matte-bench/`)

**Interfaces:**

- Consumes: `app.config.get_settings` (for `comfyui_url`).
- Produces: `probe.available_models(object_info: dict) -> dict[str, list[str]]` mapping node class name to its installed model list; `probe.fetch_object_info(base_url: str) -> dict`.

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/conftest.py`:

```python
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
sys.path.insert(0, str(ROOT / "tools" / "matte-bench"))
```

`tools/matte-bench/tests/test_probe.py`:

```python
from matte_bench.probe import available_models

OBJECT_INFO = {
    "BiRefNetRMBG": {"input": {"required": {
        "image": ["IMAGE", {}],
        "model": [["BiRefNet-HR", "BiRefNet_lite"], {}],
    }}},
    "RMBG": {"input": {"required": {
        "image": ["IMAGE", {}],
        "model": [["RMBG-2.0", "BEN2"], {}],
    }}},
    "KSampler": {"input": {"required": {"seed": ["INT", {}]}}},
}


def test_available_models_lists_only_matting_nodes():
    assert available_models(OBJECT_INFO) == {
        "BiRefNetRMBG": ["BiRefNet-HR", "BiRefNet_lite"],
        "RMBG": ["RMBG-2.0", "BEN2"],
    }


def test_available_models_omits_absent_nodes():
    assert available_models({"KSampler": {"input": {"required": {}}}}) == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_probe.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/__init__.py`: empty file.

`tools/matte-bench/matte_bench/probe.py`:

```python
"""Ask ComfyUI which matting models are actually installed.

The node classes existing does not mean the weights are downloaded. Ranking
eight models while the operator believes they are seeing fifteen is a silent
lie, so availability is probed and reported, never assumed.
"""
import httpx

MATTING_NODES = ("BiRefNetRMBG", "RMBG")


def fetch_object_info(base_url: str) -> dict:
    resp = httpx.get(f"{base_url.rstrip('/')}/object_info", timeout=120.0)
    resp.raise_for_status()
    return resp.json()


def available_models(object_info: dict) -> dict[str, list[str]]:
    """Node class -> installed model names, for matting nodes only."""
    out: dict[str, list[str]] = {}
    for node in MATTING_NODES:
        spec = object_info.get(node)
        if not spec:
            continue
        choices = (spec.get("input", {}).get("required", {}).get("model") or [None])[0]
        if isinstance(choices, list) and choices:
            out[node] = list(choices)
    return out
```

`tools/matte-bench/run.py`:

```python
"""Launcher: puts studio/backend and the bench on sys.path, then runs the app."""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "studio" / "backend"))
sys.path.insert(0, str(pathlib.Path(__file__).parent))

if __name__ == "__main__":
    from matte_bench.cli import main
    raise SystemExit(main(sys.argv[1:]))
```

`tools/matte-bench/matte_bench/cli.py`:

```python
import os

from app.config import get_settings

from matte_bench.probe import available_models, fetch_object_info


def main(argv: list[str]) -> int:
    settings = get_settings()
    if argv and argv[0] == "probe":
        info = fetch_object_info(settings.comfyui_url)
        found = available_models(info)
        if not found:
            print(f"No matting nodes on {settings.comfyui_url}")
            return 1
        for node, models in found.items():
            print(f"{node}: {len(models)} models")
            for m in models:
                print(f"  {m}")
        return 0
    import uvicorn
    from matte_bench.web import app
    port = 8400 + int(os.environ.get("BLOOM_PORT_OFFSET") or 0)
    uvicorn.run(app, host="0.0.0.0", port=port)
    return 0
```

`tools/matte-bench/matte_bench/web.py` (stub for now, fleshed out in Task 8):

```python
from fastapi import FastAPI

app = FastAPI(title="matte-bench")


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
```

Append to `justfile`:

```
# Matte bench: A/B harness for transparency masking (docs/superpowers/specs/2026-08-04-matte-bench-design.md).
# `just matte-bench probe` lists which matting models are installed on the GPU box.
matte-bench *args:
    cd studio/backend && uv run python ../../tools/matte-bench/run.py {{args}}
```

Append to `.gitignore`:

```
var/matte-bench/
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_probe.py -v`
Expected: PASS (2 tests)

Then against the real box: `just matte-bench probe`
Expected: prints `BiRefNetRMBG: N models` and `RMBG: N models`. **Record the actual list in the PR description** — it defines the real technique space.

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench justfile .gitignore
git commit -m "feat(matte-bench): scaffold service and technique availability probe"
```

---

### Task 2: Store — manifest, append-only logs, staleness

**Files:**

- Create: `tools/matte-bench/matte_bench/store.py`
- Create: `tools/matte-bench/tests/test_store.py`

**Interfaces:**

- Produces:
  - `Verdict` dataclass: `subject: str, bucket: str, left: str, right: str, winner: str, plate_hash: str, ts: str, repeat_of: str | None = None` (`winner` is one of `"left" | "right" | "tie"`).
  - `Fault` dataclass: `subject: str, technique: str, tags: tuple[str, ...], ts: str`.
  - `append_verdict(path: Path, v: Verdict) -> None`, `read_verdicts(path: Path) -> list[Verdict]`
  - `append_fault(path: Path, f: Fault) -> None`, `read_faults(path: Path) -> list[Fault]`
  - `fresh_verdicts(verdicts: list[Verdict], plate_hashes: dict[str, str]) -> list[Verdict]`
  - `atomic_write_bytes(path: Path, data: bytes) -> None`

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_store.py`:

```python
from pathlib import Path

from matte_bench.store import (
    Verdict, append_verdict, read_verdicts, fresh_verdicts, atomic_write_bytes,
)


def _v(subject="s1", left="a", right="b", winner="left", plate_hash="h1"):
    return Verdict(subject=subject, bucket="wispy", left=left, right=right,
                   winner=winner, plate_hash=plate_hash, ts="2026-08-04T00:00:00Z")


def test_verdicts_round_trip(tmp_path: Path):
    log = tmp_path / "verdicts.jsonl"
    append_verdict(log, _v())
    append_verdict(log, _v(winner="right"))
    got = read_verdicts(log)
    assert [v.winner for v in got] == ["left", "right"]
    assert got[0].subject == "s1" and got[0].bucket == "wispy"


def test_read_verdicts_missing_file_is_empty(tmp_path: Path):
    assert read_verdicts(tmp_path / "nope.jsonl") == []


def test_fresh_verdicts_drops_stale_plate_hashes(tmp_path: Path):
    """A regenerated plate invalidates verdicts cast on the old pixels."""
    kept = _v(plate_hash="current")
    stale = _v(plate_hash="old")
    assert fresh_verdicts([kept, stale], {"s1": "current"}) == [kept]


def test_fresh_verdicts_drops_unknown_subjects():
    assert fresh_verdicts([_v(subject="gone")], {"s1": "current"}) == []


def test_atomic_write_leaves_no_partial_file(tmp_path: Path):
    target = tmp_path / "out.bin"
    atomic_write_bytes(target, b"abc")
    assert target.read_bytes() == b"abc"
    assert list(tmp_path.iterdir()) == [target]  # no temp left behind
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_store.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.store'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/store.py`:

```python
"""Append-only verdict/fault logs plus atomic cache writes.

The leaderboard is never stored; it is recomputed from the verdict log, so
there is one source of truth and no cache to fall out of sync.
"""
import json
import os
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Verdict:
    subject: str
    bucket: str
    left: str
    right: str
    winner: str          # "left" | "right" | "tie"
    plate_hash: str
    ts: str
    repeat_of: str | None = None


@dataclass(frozen=True)
class Fault:
    subject: str
    technique: str
    tags: tuple[str, ...]
    ts: str


def _append(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, sort_keys=True) + "\n")


def append_verdict(path: Path, v: Verdict) -> None:
    _append(path, asdict(v))


def read_verdicts(path: Path) -> list[Verdict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            out.append(Verdict(**json.loads(line)))
    return out


def append_fault(path: Path, f: Fault) -> None:
    _append(path, {**asdict(f), "tags": list(f.tags)})


def read_faults(path: Path) -> list[Fault]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip():
            d = json.loads(line)
            out.append(Fault(subject=d["subject"], technique=d["technique"],
                             tags=tuple(d["tags"]), ts=d["ts"]))
    return out


def fresh_verdicts(verdicts: list[Verdict], plate_hashes: dict[str, str]) -> list[Verdict]:
    """Verdicts still cast on the CURRENT pixels of a known subject."""
    return [v for v in verdicts if plate_hashes.get(v.subject) == v.plate_hash]


def atomic_write_bytes(path: Path, data: bytes) -> None:
    """Write via temp + replace, so a crash cannot leave a truncated file that
    later reads as a legitimate render."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_store.py -v`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/store.py tools/matte-bench/tests/test_store.py
git commit -m "feat(matte-bench): verdict/fault logs with staleness and atomic writes"
```

---

### Task 3: Alpha post-ops in Python

**Files:**

- Create: `tools/matte-bench/matte_bench/postops.py`
- Create: `tools/matte-bench/tests/test_postops.py`

**Interfaces:**

- Produces, each `(img: Image.Image, ...) -> Image.Image` on RGBA:
  - `threshold_alpha(img, cutoff: int)` — alpha below `cutoff` to 0, at/above to 255.
  - `despeckle(img, min_area_frac: float)` — clear connected alpha islands smaller than `min_area_frac * w * h`.
  - `hole_fill(img, max_area_frac: float)` — make opaque any transparent region fully enclosed by opaque pixels and smaller than `max_area_frac * w * h`.
  - `grow_alpha(img, px: int)` — dilate (`px > 0`) or erode (`px < 0`) the visible region.
  - `feather_alpha(img, radius: int)` — Gaussian-blur the alpha channel.
  - `apply_postops(img, ops: tuple[tuple[str, float], ...]) -> Image.Image` — dispatch by name in order.

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_postops.py`:

```python
from PIL import Image

from matte_bench.postops import (
    apply_postops, despeckle, grow_alpha, hole_fill, threshold_alpha,
)


def _blank(w=40, h=40):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def _fill(img, box, rgba):
    x0, y0, x1, y1 = box
    for x in range(x0, x1):
        for y in range(y0, y1):
            img.putpixel((x, y), rgba)


def test_threshold_alpha_is_binary():
    img = _blank(4, 1)
    for x, a in enumerate((0, 100, 200, 255)):
        img.putpixel((x, 0), (9, 9, 9, a))
    out = threshold_alpha(img, 128)
    assert [out.getpixel((x, 0))[3] for x in range(4)] == [0, 0, 255, 255]


def test_despeckle_removes_small_island_keeps_body():
    """The stray matting fleck that misaligned a real reel cut."""
    img = _blank()
    _fill(img, (5, 5, 35, 35), (200, 160, 40, 255))   # body: 900 px
    _fill(img, (0, 0, 2, 2), (200, 160, 40, 255))     # fleck: 4 px
    out = despeckle(img, min_area_frac=0.01)          # 16 px threshold
    assert out.getpixel((20, 20))[3] == 255
    assert out.getpixel((0, 0))[3] == 0


def test_despeckle_keeps_everything_when_threshold_is_tiny():
    img = _blank()
    _fill(img, (0, 0, 2, 2), (200, 160, 40, 255))
    out = despeckle(img, min_area_frac=0.0)
    assert out.getpixel((0, 0))[3] == 255


def test_hole_fill_closes_enclosed_gap_only():
    img = _blank()
    _fill(img, (5, 5, 35, 35), (200, 160, 40, 255))
    _fill(img, (18, 18, 22, 22), (0, 0, 0, 0))        # enclosed hole, 16 px
    out = hole_fill(img, max_area_frac=0.05)          # 80 px threshold
    assert out.getpixel((20, 20))[3] == 255           # hole closed
    assert out.getpixel((1, 1))[3] == 0               # outside untouched


def test_grow_alpha_erodes_with_negative_px():
    img = _blank()
    _fill(img, (10, 10, 30, 30), (200, 160, 40, 255))
    out = grow_alpha(img, -1)
    assert out.getpixel((10, 20))[3] == 0             # edge eaten
    assert out.getpixel((20, 20))[3] == 255           # centre intact


def test_apply_postops_runs_in_order():
    img = _blank()
    _fill(img, (0, 0, 2, 2), (200, 160, 40, 255))
    _fill(img, (5, 5, 35, 35), (200, 160, 40, 255))
    out = apply_postops(img, (("despeckle", 0.01),))
    assert out.getpixel((0, 0))[3] == 0
    assert out.getpixel((20, 20))[3] == 255


def test_apply_postops_empty_is_identity():
    img = _blank()
    _fill(img, (5, 5, 10, 10), (1, 2, 3, 255))
    assert apply_postops(img, ()).getpixel((6, 6)) == (1, 2, 3, 255)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_postops.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.postops'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/postops.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_postops.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/postops.py tools/matte-bench/tests/test_postops.py
git commit -m "feat(matte-bench): python alpha post-ops (threshold, despeckle, hole-fill, grow, feather)"
```

---

### Task 4: Technique registry

**Files:**

- Create: `tools/matte-bench/matte_bench/techniques.py`
- Create: `tools/matte-bench/techniques.json`
- Create: `tools/matte-bench/tests/test_techniques.py`

**Interfaces:**

- Produces:
  - `Technique` frozen dataclass: `id: str, cls: str, node: str, model: str, params: dict, post: tuple[tuple[str, float], ...]`. `cls` is `"A"` or `"B"`.
  - `config_hash(t: Technique) -> str` — stable sha256 prefix over the technique's config.
  - `load_techniques(path: Path) -> list[Technique]`
  - `stage1_models(available: dict[str, list[str]]) -> list[Technique]` — one default-param technique per installed model.
  - `matting_graph(t: Technique, image_name: str) -> dict` — a ComfyUI graph that loads an uploaded image and runs the technique's matting node over it.

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_techniques.py`:

```python
import json

from matte_bench.techniques import (
    Technique, config_hash, load_techniques, matting_graph, stage1_models,
)


def _t(**over):
    base = dict(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                model="BiRefNet-HR", params={"mask_blur": 0}, post=())
    return Technique(**{**base, **over})


def test_config_hash_is_stable_and_ignores_id():
    assert config_hash(_t()) == config_hash(_t(id="renamed"))


def test_config_hash_changes_with_params():
    assert config_hash(_t()) != config_hash(_t(params={"mask_blur": 4}))


def test_config_hash_changes_with_postops():
    assert config_hash(_t()) != config_hash(_t(post=(("despeckle", 0.001),)))


def test_stage1_builds_one_technique_per_installed_model():
    ts = stage1_models({"BiRefNetRMBG": ["BiRefNet-HR"], "RMBG": ["BEN2"]})
    assert [t.model for t in ts] == ["BiRefNet-HR", "BEN2"]
    assert {t.cls for t in ts} == {"A"}
    assert len({t.id for t in ts}) == 2  # ids unique


def test_matting_graph_loads_uploaded_image_and_saves_result():
    g = matting_graph(_t(), "plate_s1.png")
    kinds = {n["class_type"] for n in g.values()}
    assert kinds == {"LoadImage", "BiRefNetRMBG", "SaveImage"}
    load_id = next(k for k, n in g.items() if n["class_type"] == "LoadImage")
    assert g[load_id]["inputs"]["image"] == "plate_s1.png"
    matte_id = next(k for k, n in g.items() if n["class_type"] == "BiRefNetRMBG")
    assert g[matte_id]["inputs"]["image"] == [load_id, 0]
    assert g[matte_id]["inputs"]["model"] == "BiRefNet-HR"
    assert g[matte_id]["inputs"]["background"] == "Alpha"


def test_load_techniques_round_trip(tmp_path):
    path = tmp_path / "techniques.json"
    path.write_text(json.dumps([{
        "id": "x", "cls": "A", "node": "RMBG", "model": "BEN2",
        "params": {}, "post": [["despeckle", 0.0005]],
    }]), encoding="utf-8")
    ts = load_techniques(path)
    assert ts[0].post == (("despeckle", 0.0005),)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_techniques.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.techniques'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/techniques.py`:

```python
"""What a technique is, and how it becomes a ComfyUI graph.

Class A techniques re-mat a CACHED plate: the graph loads an already-uploaded
image and runs only the matting node, so every Class A comparison is judged on
byte-identical art.
"""
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

_DEFAULTS = {"background": "Alpha", "refine_foreground": True,
             "mask_blur": 0, "mask_offset": 0, "invert_output": False}

# RMBG exposes only a model choice; BiRefNetRMBG takes the full param set.
_NODE_PARAMS = {
    "BiRefNetRMBG": ("background", "refine_foreground", "mask_blur",
                     "mask_offset", "invert_output"),
    "RMBG": (),
}


@dataclass(frozen=True)
class Technique:
    id: str
    cls: str                 # "A" (same pixels) | "B" (different pixels)
    node: str
    model: str
    params: dict = field(default_factory=dict)
    post: tuple[tuple[str, float], ...] = ()


def config_hash(t: Technique) -> str:
    """Stable over everything that changes the OUTPUT — deliberately not the id,
    so renaming a technique does not invalidate its verdicts."""
    payload = json.dumps(
        {"cls": t.cls, "node": t.node, "model": t.model,
         "params": t.params, "post": [list(p) for p in t.post]},
        sort_keys=True,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def load_techniques(path: Path) -> list[Technique]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return [
        Technique(id=d["id"], cls=d["cls"], node=d["node"], model=d["model"],
                  params=d.get("params") or {},
                  post=tuple(tuple(p) for p in (d.get("post") or [])))
        for d in raw
    ]


def _slug(model: str) -> str:
    return model.lower().replace("_", "-").replace(".", "-")


def stage1_models(available: dict[str, list[str]]) -> list[Technique]:
    """One default-param technique per installed model — stage 1 of the sweep."""
    out = []
    for node, models in available.items():
        for model in models:
            out.append(Technique(id=_slug(model), cls="A", node=node,
                                 model=model, params={}, post=()))
    return out


def matting_graph(t: Technique, image_name: str) -> dict:
    inputs = {"image": ["load", 0], "model": t.model}
    for key in _NODE_PARAMS.get(t.node, ()):
        inputs[key] = t.params.get(key, _DEFAULTS[key])
    return {
        "load": {"class_type": "LoadImage", "inputs": {"image": image_name}},
        "matte": {"class_type": t.node, "inputs": inputs},
        "save": {"class_type": "SaveImage",
                 "inputs": {"images": ["matte", 0], "filename_prefix": "mattebench"}},
    }
```

`tools/matte-bench/techniques.json` — **deliberately an empty array**, not an unfinished step. Stage-1 techniques are derived from the live probe, because hand-listing 15 models would go stale the moment weights change on the box. This file is the home for hand-authored techniques (stage 2 param variants, stage 3 post-op combinations, Class B entries), which land in a follow-up plan. `load_techniques` is written and tested now so that later work has a defined entry point rather than inventing one.

```json
[]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_techniques.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/techniques.py tools/matte-bench/techniques.json tools/matte-bench/tests/test_techniques.py
git commit -m "feat(matte-bench): technique registry and matting graph builder"
```

---

### Task 5: Corpus and plate rendering

**Files:**

- Create: `tools/matte-bench/subjects.json`
- Create: `tools/matte-bench/matte_bench/corpus.py`
- Create: `tools/matte-bench/tests/test_corpus.py`

**Interfaces:**

- Consumes: `app.assets.graph.build_graph`, `app.assets.comfy.LiveComfyProvider`, `app.config.get_settings`, `store.atomic_write_bytes`.
- Produces:
  - `Subject` frozen dataclass: `id: str, bucket: str, prompt: str, seed: int, width: int, height: int`.
  - `BUCKETS: tuple[str, ...]`
  - `load_subjects(path: Path) -> list[Subject]`
  - `plate_path(root: Path, subject_id: str) -> Path`
  - `plate_hash(data: bytes) -> str`
  - `async ensure_plate(s: Subject, root: Path, comfy_url: str) -> Path` — render once via `dev-opaque`, cache, return path.
  - `plate_hashes(subjects, root) -> dict[str, str]`

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_corpus.py`:

```python
import json
from pathlib import Path

import pytest

from matte_bench.corpus import (
    BUCKETS, Subject, load_subjects, plate_hash, plate_hashes, plate_path,
)

REPO = Path(__file__).resolve().parents[3]


def test_shipped_subjects_cover_every_bucket_twice():
    subjects = load_subjects(REPO / "tools" / "matte-bench" / "subjects.json")
    counts: dict[str, int] = {}
    for s in subjects:
        counts[s.bucket] = counts.get(s.bucket, 0) + 1
    assert set(counts) == set(BUCKETS)
    assert all(n >= 2 for n in counts.values()), counts


def test_shipped_subject_ids_are_unique():
    subjects = load_subjects(REPO / "tools" / "matte-bench" / "subjects.json")
    ids = [s.id for s in subjects]
    assert len(ids) == len(set(ids))


def test_shipped_subjects_pin_a_seed():
    """Plates must regenerate deterministically; a missing seed breaks that."""
    for s in load_subjects(REPO / "tools" / "matte-bench" / "subjects.json"):
        assert isinstance(s.seed, int) and s.seed > 0


def test_plate_hash_is_content_addressed():
    assert plate_hash(b"abc") == plate_hash(b"abc")
    assert plate_hash(b"abc") != plate_hash(b"abd")


def test_plate_hashes_skips_missing_plates(tmp_path: Path):
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    assert plate_hashes([s], tmp_path) == {}
    plate_path(tmp_path, "s1").parent.mkdir(parents=True, exist_ok=True)
    plate_path(tmp_path, "s1").write_bytes(b"xyz")
    assert plate_hashes([s], tmp_path) == {"s1": plate_hash(b"xyz")}


def test_load_subjects_rejects_unknown_bucket(tmp_path: Path):
    path = tmp_path / "subjects.json"
    path.write_text(json.dumps([{"id": "a", "bucket": "nope", "prompt": "p",
                                 "seed": 1, "width": 8, "height": 8}]),
                    encoding="utf-8")
    with pytest.raises(ValueError, match="nope"):
        load_subjects(path)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_corpus.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.corpus'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/corpus.py`:

```python
"""Test subjects, organised by image CHARACTERISTIC rather than product role.

Foliage and lettering fail differently whatever the asset is called, so roles
do not predict matting difficulty. Plates are rendered with `dev-opaque` —
which is `dev-transparent` minus the matting node — giving the exact
pre-matting pixels every technique then competes on.
"""
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from app.assets.comfy import ImageEvent, LiveComfyProvider
from app.assets.graph import build_graph

from matte_bench.store import atomic_write_bytes

BUCKETS = (
    "wispy", "filigree", "enclosed-holes", "glow-soft",
    "crisp-text", "low-contrast", "busy-background",
)

PLATE_WORKFLOW = "dev-opaque"


@dataclass(frozen=True)
class Subject:
    id: str
    bucket: str
    prompt: str
    seed: int
    width: int
    height: int


def load_subjects(path: Path) -> list[Subject]:
    out = []
    for d in json.loads(path.read_text(encoding="utf-8")):
        if d["bucket"] not in BUCKETS:
            raise ValueError(f"unknown bucket: {d['bucket']}")
        out.append(Subject(id=d["id"], bucket=d["bucket"], prompt=d["prompt"],
                           seed=int(d["seed"]), width=int(d["width"]),
                           height=int(d["height"])))
    return out


def plate_path(root: Path, subject_id: str) -> Path:
    return root / "plates" / f"{subject_id}.png"


def plate_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def plate_hashes(subjects: list[Subject], root: Path) -> dict[str, str]:
    out = {}
    for s in subjects:
        p = plate_path(root, s.id)
        if p.exists():
            out[s.id] = plate_hash(p.read_bytes())
    return out


async def ensure_plate(s: Subject, root: Path, comfy_url: str) -> Path:
    """Render the raw pre-matting plate once; reuse it forever after."""
    dest = plate_path(root, s.id)
    if dest.exists():
        return dest
    graph = build_graph(PLATE_WORKFLOW, s.prompt, s.width, s.height, s.seed)
    image = None
    async for ev in LiveComfyProvider(base_url=comfy_url).generate(graph):
        if isinstance(ev, ImageEvent):
            image = ev.data
    if not image:
        raise RuntimeError(f"no plate produced for subject {s.id}")
    atomic_write_bytes(dest, image)
    return dest
```

`tools/matte-bench/subjects.json` — 14 subjects, two per bucket. Seeds are arbitrary but pinned:

```json
[
  {
    "id": "wispy-fern",
    "bucket": "wispy",
    "prompt": "a single lush fern frond with fine feathery leaflets, photographed against a cluttered green garden background, natural light",
    "seed": 101,
    "width": 768,
    "height": 768
  },
  {
    "id": "wispy-dandelion",
    "bucket": "wispy",
    "prompt": "a dandelion seed head with fine translucent filaments, backlit, soft outdoor background",
    "seed": 102,
    "width": 768,
    "height": 768
  },
  {
    "id": "filigree-scrollwork",
    "bucket": "filigree",
    "prompt": "an ornate brass scrollwork panel with very thin curling metal tendrils, on a busy workshop background",
    "seed": 103,
    "width": 900,
    "height": 520
  },
  {
    "id": "filigree-lattice",
    "bucket": "filigree",
    "prompt": "a delicate wrought iron lattice screen with thin crossing bars, against a garden scene",
    "seed": 104,
    "width": 900,
    "height": 520
  },
  {
    "id": "holes-arcade",
    "bucket": "enclosed-holes",
    "prompt": "an ornate five bay arcade frame of aged gold, each bay an empty opening, against a glasshouse interior",
    "seed": 105,
    "width": 900,
    "height": 520
  },
  {
    "id": "holes-ring",
    "bucket": "enclosed-holes",
    "prompt": "a thick decorative metal ring with a large empty centre and pierced holes, on a stone background",
    "seed": 106,
    "width": 768,
    "height": 768
  },
  {
    "id": "glow-lantern",
    "bucket": "glow-soft",
    "prompt": "a glowing glass lantern with soft light bloom and translucent panes, dim background",
    "seed": 107,
    "width": 768,
    "height": 768
  },
  {
    "id": "glow-smoke",
    "bucket": "glow-soft",
    "prompt": "a wisp of pale smoke curling upward, semi transparent, against a dark cluttered background",
    "seed": 108,
    "width": 768,
    "height": 768
  },
  {
    "id": "text-wordmark",
    "bucket": "crisp-text",
    "prompt": "a premium metallic game logo wordmark reading GARDEN, bold clean lettering, sharp edges, studio background",
    "seed": 109,
    "width": 900,
    "height": 520
  },
  {
    "id": "text-serif",
    "bucket": "crisp-text",
    "prompt": "an ornate gold serif wordmark reading BLOOM with fine spurs and thin strokes, on a marble background",
    "seed": 110,
    "width": 900,
    "height": 520
  },
  {
    "id": "lowcon-green",
    "bucket": "low-contrast",
    "prompt": "a jade green leaf ornament resting on a jade green painted wall, minimal tonal separation",
    "seed": 111,
    "width": 768,
    "height": 768
  },
  {
    "id": "lowcon-gold",
    "bucket": "low-contrast",
    "prompt": "a pale gold filigree brooch on a pale cream silk background, very close in tone",
    "seed": 112,
    "width": 768,
    "height": 768
  },
  {
    "id": "busy-glasshouse",
    "bucket": "busy-background",
    "prompt": "an ornate gold reel frame standing inside an overgrown Victorian glasshouse dense with foliage and vines",
    "seed": 113,
    "width": 900,
    "height": 520
  },
  {
    "id": "busy-market",
    "bucket": "busy-background",
    "prompt": "a decorative carved emblem in front of a crowded cluttered market stall full of detail",
    "seed": 114,
    "width": 900,
    "height": 520
  }
]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_corpus.py -v`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/corpus.py tools/matte-bench/subjects.json tools/matte-bench/tests/test_corpus.py
git commit -m "feat(matte-bench): 14-subject corpus across 7 characteristic buckets"
```

---

### Task 6: Render — upload plate, run technique, cache

**Files:**

- Create: `tools/matte-bench/matte_bench/render.py`
- Create: `tools/matte-bench/tests/test_render.py`

**Interfaces:**

- Consumes: `techniques.matting_graph`, `techniques.config_hash`, `postops.apply_postops`, `store.atomic_write_bytes`, `app.assets.comfy.LiveComfyProvider`.
- Produces:
  - `render_path(root: Path, subject_id: str, t: Technique) -> Path`
  - `upload_plate(base_url: str, plate: Path) -> str` — returns the server-side image name.
  - `async ensure_render(s: Subject, t: Technique, root: Path, comfy_url: str) -> Path`
  - `RenderError(Exception)` with `.technique_id` and `.reason`.

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_render.py`:

```python
from pathlib import Path

from matte_bench.render import render_path
from matte_bench.techniques import Technique, config_hash


def _t(**over):
    base = dict(id="birefnet-hr", cls="A", node="BiRefNetRMBG",
                model="BiRefNet-HR", params={}, post=())
    return Technique(**{**base, **over})


def test_render_path_includes_config_hash(tmp_path: Path):
    p = render_path(tmp_path, "s1", _t())
    assert p.parent == tmp_path / "renders" / "s1"
    assert config_hash(_t()) in p.name
    assert p.suffix == ".png"


def test_render_path_differs_when_params_differ(tmp_path: Path):
    """Changing params must not reuse a stale cached render."""
    a = render_path(tmp_path, "s1", _t())
    b = render_path(tmp_path, "s1", _t(params={"mask_blur": 4}))
    assert a != b


def test_render_path_differs_when_postops_differ(tmp_path: Path):
    a = render_path(tmp_path, "s1", _t())
    b = render_path(tmp_path, "s1", _t(post=(("despeckle", 0.001),)))
    assert a != b


def test_render_path_same_for_renamed_technique(tmp_path: Path):
    """The cache is keyed by configuration, not by label."""
    assert render_path(tmp_path, "s1", _t()) == render_path(tmp_path, "s1", _t(id="other"))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_render.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.render'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/render.py`:

```python
"""Apply one technique to one cached plate, and cache the result.

Class A never regenerates: the plate is uploaded to ComfyUI once and each
technique runs only its matting node over it, so the comparison isolates the
mask instead of confounding it with a different image.
"""
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

from app.assets.comfy import ImageEvent, LiveComfyProvider

from matte_bench.corpus import Subject
from matte_bench.postops import apply_postops
from matte_bench.store import atomic_write_bytes
from matte_bench.techniques import Technique, config_hash, matting_graph


class RenderError(Exception):
    def __init__(self, technique_id: str, reason: str):
        super().__init__(f"{technique_id}: {reason}")
        self.technique_id = technique_id
        self.reason = reason


def render_path(root: Path, subject_id: str, t: Technique) -> Path:
    return root / "renders" / subject_id / f"{config_hash(t)}.png"


def upload_plate(base_url: str, plate: Path) -> str:
    """Put the plate on the ComfyUI server; returns the name LoadImage wants."""
    files = {"image": (plate.name, plate.read_bytes(), "image/png")}
    resp = httpx.post(f"{base_url.rstrip('/')}/upload/image", files=files,
                      data={"overwrite": "true"}, timeout=120.0)
    resp.raise_for_status()
    body = resp.json()
    sub = body.get("subfolder") or ""
    return f"{sub}/{body['name']}" if sub else body["name"]


async def ensure_render(s: Subject, t: Technique, root: Path, comfy_url: str) -> Path:
    dest = render_path(root, s.id, t)
    if dest.exists():
        return dest
    from matte_bench.corpus import plate_path
    plate = plate_path(root, s.id)
    if not plate.exists():
        raise RenderError(t.id, f"no plate for subject {s.id}")
    name = upload_plate(comfy_url, plate)
    image = None
    try:
        async for ev in LiveComfyProvider(base_url=comfy_url).generate(
                matting_graph(t, name)):
            if isinstance(ev, ImageEvent):
                image = ev.data
    except Exception as exc:                      # noqa: BLE001 - reported, not swallowed
        raise RenderError(t.id, str(exc)) from exc
    if not image:
        raise RenderError(t.id, "matting produced no image")
    if t.post:
        img = apply_postops(Image.open(BytesIO(image)).convert("RGBA"), t.post)
        buf = BytesIO()
        img.save(buf, "PNG")
        image = buf.getvalue()
    atomic_write_bytes(dest, image)
    return dest
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_render.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/render.py tools/matte-bench/tests/test_render.py
git commit -m "feat(matte-bench): render cache keyed by technique config hash"
```

---

### Task 7: Ranking — Bradley-Terry per bucket with bootstrap intervals

**Files:**

- Create: `tools/matte-bench/matte_bench/ranking.py`
- Create: `tools/matte-bench/tests/test_ranking.py`

**Interfaces:**

- Consumes: `store.Verdict`.
- Produces:
  - `Standing` frozen dataclass: `technique: str, score: float, low: float, high: float, comparisons: int`.
  - `fit(verdicts: list[Verdict]) -> dict[str, float]` — Bradley-Terry strengths, normalised to sum 1.
  - `standings(verdicts: list[Verdict], bucket: str, rounds: int = 200, rng_seed: int = 7) -> list[Standing]` — sorted best first.
  - `separated(rows: list[Standing]) -> bool` — True when the top two intervals do not overlap.

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_ranking.py`:

```python
from matte_bench.ranking import fit, separated, standings
from matte_bench.store import Verdict


def _v(left, right, winner, bucket="wispy", subject="s1"):
    return Verdict(subject=subject, bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="2026-08-04T00:00:00Z")


def test_fit_ranks_a_dominant_winner_highest():
    v = [_v("a", "b", "left") for _ in range(10)]
    strengths = fit(v)
    assert strengths["a"] > strengths["b"]


def test_fit_is_order_independent():
    """Bradley-Terry fits all verdicts at once; Elo would not give this."""
    forward = [_v("a", "b", "left"), _v("a", "b", "left"), _v("a", "b", "right")]
    shuffled = [forward[2], forward[0], forward[1]]
    assert fit(forward) == fit(shuffled)


def test_fit_treats_side_as_irrelevant():
    """Winning as 'right' must count exactly as much as winning as 'left'."""
    as_left = [_v("a", "b", "left") for _ in range(6)]
    as_right = [_v("b", "a", "right") for _ in range(6)]
    assert fit(as_left)["a"] == fit(as_right)["a"]


def test_ties_do_not_crown_a_winner():
    v = [_v("a", "b", "tie") for _ in range(8)]
    s = fit(v)
    assert abs(s["a"] - s["b"]) < 1e-6


def test_standings_filter_by_bucket():
    v = [_v("a", "b", "left", bucket="wispy"),
         _v("c", "d", "left", bucket="crisp-text")]
    names = {row.technique for row in standings(v, "wispy")}
    assert names == {"a", "b"}


def test_standings_sorted_best_first_with_counts():
    v = [_v("a", "b", "left") for _ in range(9)] + [_v("a", "b", "right")]
    rows = standings(v, "wispy")
    assert rows[0].technique == "a"
    assert rows[0].comparisons == 10
    assert rows[0].low <= rows[0].score <= rows[0].high


def test_separated_is_false_when_evidence_is_thin():
    """One vote must not be reported as a real lead."""
    rows = standings([_v("a", "b", "left")], "wispy")
    assert separated(rows) is False


def test_separated_is_true_with_overwhelming_evidence():
    rows = standings([_v("a", "b", "left") for _ in range(40)], "wispy")
    assert separated(rows) is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_ranking.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.ranking'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/ranking.py`:

```python
"""Bradley-Terry strengths per bucket, with bootstrap intervals.

Bradley-Terry rather than sequential Elo: Elo depends on the order votes
arrive, so re-running the same data could reorder the table. This fits all
verdicts at once, which makes standings reproducible and lets late votes
overturn early noise.
"""
import random
from dataclasses import dataclass

from matte_bench.store import Verdict

_ITERATIONS = 200
_TIE_WEIGHT = 0.5


@dataclass(frozen=True)
class Standing:
    technique: str
    score: float
    low: float
    high: float
    comparisons: int


def _tallies(verdicts: list[Verdict]):
    wins: dict[str, float] = {}
    pairs: dict[tuple[str, str], float] = {}
    for v in verdicts:
        for name in (v.left, v.right):
            wins.setdefault(name, 0.0)
        if v.winner == "left":
            wins[v.left] += 1.0
        elif v.winner == "right":
            wins[v.right] += 1.0
        else:
            wins[v.left] += _TIE_WEIGHT
            wins[v.right] += _TIE_WEIGHT
        key = (v.left, v.right) if v.left < v.right else (v.right, v.left)
        pairs[key] = pairs.get(key, 0.0) + 1.0
    return wins, pairs


def fit(verdicts: list[Verdict]) -> dict[str, float]:
    """Minorisation-maximisation fit; strengths normalised to sum 1."""
    wins, pairs = _tallies(verdicts)
    if not wins:
        return {}
    strength = {k: 1.0 for k in wins}
    for _ in range(_ITERATIONS):
        updated = {}
        for name in strength:
            denom = 0.0
            for (a, b), n in pairs.items():
                if name not in (a, b):
                    continue
                other = b if name == a else a
                denom += n / (strength[name] + strength[other])
            updated[name] = (wins[name] / denom) if denom > 0 else strength[name]
        total = sum(updated.values()) or 1.0
        strength = {k: v / total for k, v in updated.items()}
    return {k: round(v, 12) for k, v in strength.items()}


def standings(verdicts: list[Verdict], bucket: str, rounds: int = 200,
              rng_seed: int = 7) -> list[Standing]:
    scoped = [v for v in verdicts if v.bucket == bucket]
    base = fit(scoped)
    if not base:
        return []
    counts: dict[str, int] = {}
    for v in scoped:
        counts[v.left] = counts.get(v.left, 0) + 1
        counts[v.right] = counts.get(v.right, 0) + 1

    rng = random.Random(rng_seed)
    samples: dict[str, list[float]] = {k: [] for k in base}
    for _ in range(rounds):
        resampled = [scoped[rng.randrange(len(scoped))] for _ in scoped]
        got = fit(resampled)
        for name in base:
            samples[name].append(got.get(name, 0.0))
    rows = []
    for name, score in base.items():
        ordered = sorted(samples[name])
        lo = ordered[int(0.025 * (len(ordered) - 1))]
        hi = ordered[int(0.975 * (len(ordered) - 1))]
        rows.append(Standing(technique=name, score=score, low=lo, high=hi,
                             comparisons=counts.get(name, 0)))
    return sorted(rows, key=lambda r: r.score, reverse=True)


def separated(rows: list[Standing]) -> bool:
    """True only when the leader's interval clears the runner-up's."""
    return len(rows) >= 2 and rows[0].low > rows[1].high
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_ranking.py -v`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/ranking.py tools/matte-bench/tests/test_ranking.py
git commit -m "feat(matte-bench): Bradley-Terry ranking with bootstrap intervals"
```

---

### Task 8: Pairing — adaptive selection with blinding and repeat injection

**Files:**

- Create: `tools/matte-bench/matte_bench/pairing.py`
- Create: `tools/matte-bench/tests/test_pairing.py`

**Interfaces:**

- Consumes: `store.Verdict`, `ranking.fit`.
- Produces:
  - `Comparison` frozen dataclass: `subject: str, bucket: str, left: str, right: str, repeat_of: str | None`.
  - `judged_pairs(verdicts: list[Verdict]) -> dict[tuple[str, str, str], int]` keyed `(subject, lo, hi)` to count.
  - `next_comparison(subjects, techniques, verdicts, rng, repeat_every: int = 20) -> Comparison | None`

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_pairing.py`:

```python
import random

from matte_bench.corpus import Subject
from matte_bench.pairing import judged_pairs, next_comparison
from matte_bench.store import Verdict


def _s(sid="s1", bucket="wispy"):
    return Subject(id=sid, bucket=bucket, prompt="p", seed=1, width=8, height=8)


def _v(subject, left, right, winner="left", bucket="wispy"):
    return Verdict(subject=subject, bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t")


def test_judged_pairs_is_order_insensitive():
    got = judged_pairs([_v("s1", "b", "a")])
    assert got == {("s1", "a", "b"): 1}


def test_next_comparison_returns_none_when_all_pairs_judged():
    rng = random.Random(1)
    verdicts = [_v("s1", "a", "b")]
    assert next_comparison([_s()], ["a", "b"], verdicts, rng, repeat_every=0) is None


def test_next_comparison_prefers_an_unjudged_pair():
    rng = random.Random(1)
    verdicts = [_v("s1", "a", "b")]
    c = next_comparison([_s()], ["a", "b", "c"], verdicts, rng, repeat_every=0)
    assert {c.left, c.right} != {"a", "b"}


def test_next_comparison_only_pairs_within_one_subject():
    rng = random.Random(1)
    subjects = [_s("s1"), _s("s2")]
    c = next_comparison(subjects, ["a", "b"], [], rng, repeat_every=0)
    assert c.subject in {"s1", "s2"}
    assert c.bucket == "wispy"


def test_next_comparison_needs_two_techniques():
    rng = random.Random(1)
    assert next_comparison([_s()], ["a"], [], rng, repeat_every=0) is None


def test_repeat_injection_reserves_a_judged_pair():
    """Self-consistency check: occasionally re-serve something already judged."""
    rng = random.Random(1)
    verdicts = [_v("s1", "a", "b")]
    c = next_comparison([_s()], ["a", "b", "c"], verdicts, rng, repeat_every=1)
    assert c.repeat_of is not None
    assert {c.left, c.right} == {"a", "b"}


def test_sides_are_randomised_across_draws():
    """Blinding: a technique must not always appear on the same side."""
    seen = set()
    for seed in range(30):
        c = next_comparison([_s()], ["a", "b"], [], random.Random(seed),
                            repeat_every=0)
        seen.add((c.left, c.right))
    assert seen == {("a", "b"), ("b", "a")}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_pairing.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.pairing'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/pairing.py`:

```python
"""Which comparison to serve next.

Adaptive, not exhaustive: draws where the current strengths are closest, so 15
techniques are separable without judging all 105 pairs per subject. Sides are
randomised so a technique cannot win by always sitting on the left.
"""
import random
from dataclasses import dataclass

from matte_bench.corpus import Subject
from matte_bench.ranking import fit
from matte_bench.store import Verdict


@dataclass(frozen=True)
class Comparison:
    subject: str
    bucket: str
    left: str
    right: str
    repeat_of: str | None = None


def _key(subject: str, a: str, b: str) -> tuple[str, str, str]:
    lo, hi = (a, b) if a < b else (b, a)
    return (subject, lo, hi)


def judged_pairs(verdicts: list[Verdict]) -> dict[tuple[str, str, str], int]:
    out: dict[tuple[str, str, str], int] = {}
    for v in verdicts:
        k = _key(v.subject, v.left, v.right)
        out[k] = out.get(k, 0) + 1
    return out


def next_comparison(subjects: list[Subject], techniques: list[str],
                    verdicts: list[Verdict], rng: random.Random,
                    repeat_every: int = 20) -> Comparison | None:
    if len(techniques) < 2 or not subjects:
        return None
    seen = judged_pairs(verdicts)

    # Self-consistency probe: re-serve something already judged, unannounced.
    if repeat_every and seen and rng.randrange(repeat_every) == 0:
        subject, a, b = rng.choice(sorted(seen))
        bucket = next(s.bucket for s in subjects if s.id == subject)
        left, right = (a, b) if rng.random() < 0.5 else (b, a)
        return Comparison(subject=subject, bucket=bucket, left=left,
                          right=right, repeat_of=f"{subject}:{a}:{b}")

    strengths = fit(verdicts)
    candidates = []
    for s in subjects:
        for i, a in enumerate(techniques):
            for b in techniques[i + 1:]:
                k = _key(s.id, a, b)
                if k in seen:
                    continue
                gap = abs(strengths.get(a, 0.0) - strengths.get(b, 0.0))
                candidates.append((gap, s.id, s.bucket, a, b))
    if not candidates:
        return None
    best_gap = min(c[0] for c in candidates)
    tied = [c for c in candidates if c[0] == best_gap]
    _, subject, bucket, a, b = rng.choice(tied)
    left, right = (a, b) if rng.random() < 0.5 else (b, a)
    return Comparison(subject=subject, bucket=bucket, left=left, right=right)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_pairing.py -v`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/pairing.py tools/matte-bench/tests/test_pairing.py
git commit -m "feat(matte-bench): adaptive blind pairing with repeat-consistency probes"
```

---

### Task 9: Web service and judging UI

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (replace the Task 1 stub)
- Create: `tools/matte-bench/matte_bench/static/index.html`
- Create: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: everything above.
- Produces HTTP: `GET /health`, `GET /api/next`, `POST /api/verdict`, `GET /api/standings/{bucket}`, `POST /api/fault`, `GET /render/{subject}/{technique}.png`, `GET /` (the page).

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_web.py`:

```python
from fastapi.testclient import TestClient

from matte_bench.web import app, state
from matte_bench.corpus import Subject
from matte_bench.store import Verdict


def _client(tmp_path):
    state.root = tmp_path
    state.subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                              width=8, height=8)]
    state.techniques = ["a", "b"]
    state.verdict_log = tmp_path / "verdicts.jsonl"
    state.fault_log = tmp_path / "faults.jsonl"
    state.plate_hashes = {"s1": "h"}
    return TestClient(app)


def test_health(tmp_path):
    assert _client(tmp_path).get("/health").json()["status"] == "ok"


def test_next_returns_a_blind_comparison(tmp_path):
    body = _client(tmp_path).get("/api/next").json()
    assert body["subject"] == "s1"
    assert {body["left"], body["right"]} == {"a", "b"}


def test_posting_a_verdict_appends_and_advances(tmp_path):
    client = _client(tmp_path)
    first = client.get("/api/next").json()
    resp = client.post("/api/verdict", json={
        "subject": first["subject"], "bucket": first["bucket"],
        "left": first["left"], "right": first["right"], "winner": "left",
    })
    assert resp.status_code == 200
    assert state.verdict_log.exists()
    assert client.get("/api/next").json() is None


def test_verdict_rejects_unknown_winner(tmp_path):
    client = _client(tmp_path)
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
        "winner": "sideways",
    })
    assert resp.status_code == 422


def test_standings_endpoint_reports_the_leader(tmp_path):
    client = _client(tmp_path)
    for _ in range(6):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    rows = client.get("/api/standings/wispy").json()
    assert rows[0]["technique"] == "a"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -v`
Expected: FAIL with `ImportError: cannot import name 'state' from 'matte_bench.web'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/web.py`:

```python
"""Routes and the judging page.

Thin by design: the logic lives in pairing/ranking/postops, which are pure and
unit-tested. This module wires them to HTTP and serves one static page.
"""
import random
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, field_validator

from matte_bench.corpus import Subject
from matte_bench.pairing import next_comparison
from matte_bench.ranking import standings
from matte_bench.store import (
    Fault, Verdict, append_fault, append_verdict, fresh_verdicts, read_verdicts,
)

STATIC = Path(__file__).parent / "static"


@dataclass
class State:
    root: Path = Path("var/matte-bench")
    subjects: list[Subject] = field(default_factory=list)
    techniques: list[str] = field(default_factory=list)
    verdict_log: Path = Path("tools/matte-bench/verdicts.jsonl")
    fault_log: Path = Path("tools/matte-bench/faults.jsonl")
    plate_hashes: dict[str, str] = field(default_factory=dict)
    rng: random.Random = field(default_factory=lambda: random.Random())


state = State()
app = FastAPI(title="matte-bench")


class VerdictIn(BaseModel):
    subject: str
    bucket: str
    left: str
    right: str
    winner: str
    repeat_of: str | None = None

    @field_validator("winner")
    @classmethod
    def _known(cls, v: str) -> str:
        if v not in ("left", "right", "tie"):
            raise ValueError("winner must be left, right or tie")
        return v


class FaultIn(BaseModel):
    subject: str
    technique: str
    tags: list[str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _live_verdicts() -> list[Verdict]:
    return fresh_verdicts(read_verdicts(state.verdict_log), state.plate_hashes)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/api/next")
def api_next():
    c = next_comparison(state.subjects, state.techniques, _live_verdicts(), state.rng)
    if c is None:
        return None
    return {"subject": c.subject, "bucket": c.bucket, "left": c.left,
            "right": c.right, "repeat_of": c.repeat_of}


@app.post("/api/verdict")
def api_verdict(body: VerdictIn) -> dict:
    plate_hash = state.plate_hashes.get(body.subject)
    if plate_hash is None:
        raise HTTPException(status_code=404, detail="unknown subject")
    append_verdict(state.verdict_log, Verdict(
        subject=body.subject, bucket=body.bucket, left=body.left,
        right=body.right, winner=body.winner, plate_hash=plate_hash,
        ts=_now(), repeat_of=body.repeat_of))
    return {"ok": True}


@app.post("/api/fault")
def api_fault(body: FaultIn) -> dict:
    append_fault(state.fault_log, Fault(subject=body.subject,
                                        technique=body.technique,
                                        tags=tuple(body.tags), ts=_now()))
    return {"ok": True}


@app.get("/api/standings/{bucket}")
def api_standings(bucket: str) -> list[dict]:
    rows = standings(_live_verdicts(), bucket)
    return [{"technique": r.technique, "score": r.score, "low": r.low,
             "high": r.high, "comparisons": r.comparisons} for r in rows]


@app.get("/render/{subject}/{technique}.png")
def api_render(subject: str, technique: str) -> FileResponse:
    path = state.root / "renders" / subject / f"{technique}.png"
    if not path.exists():
        raise HTTPException(status_code=404, detail="render not found")
    return FileResponse(path, media_type="image/png")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC / "index.html", media_type="text/html")
```

`tools/matte-bench/matte_bench/static/index.html`:

```html
<meta charset="utf-8" />
<title>Matte Bench</title>
<style>
  body {
    margin: 0;
    background: #111;
    color: #eee;
    font: 14px system-ui;
  }
  #pair {
    display: flex;
    gap: 8px;
    padding: 8px;
  }
  .side {
    flex: 1;
    text-align: center;
  }
  .stage {
    display: inline-block;
    position: relative;
  }
  .stage img {
    max-width: 100%;
    display: block;
  }
  .light {
    background: #fff;
  }
  .dark {
    background: #000;
  }
  .checker {
    background-image:
      linear-gradient(45deg, #888 25%, transparent 25%), linear-gradient(-45deg, #888 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #888 75%),
      linear-gradient(-45deg, transparent 75%, #888 75%);
    background-size: 16px 16px;
    background-position:
      0 0,
      0 8px,
      8px -8px,
      -8px 0;
    background-color: #ccc;
  }
  /* Busy backdrop: halo and partial-alpha haze hide on flat colours and only
     show against detail. Stands in for a real game background. */
  .busy {
    background-image:
      repeating-linear-gradient(30deg, #2c5c3a 0 12px, #4a8a5c 12px 24px),
      repeating-linear-gradient(-20deg, rgba(255, 220, 120, 0.35) 0 9px, transparent 9px 21px);
  }
  .stage img.zoom {
    transform: scale(4);
    image-rendering: pixelated;
  }
  #bar {
    padding: 8px;
    border-top: 1px solid #333;
  }
  kbd {
    background: #333;
    padding: 1px 5px;
    border-radius: 3px;
  }
</style>
<div id="pair">
  <div class="side">
    <div class="stage checker" id="stageL"><img id="imgL" /></div>
  </div>
  <div class="side">
    <div class="stage checker" id="stageR"><img id="imgR" /></div>
  </div>
</div>
<div id="bar">
  <span id="meta"></span> &nbsp; <kbd>&larr;</kbd>/<kbd>&rarr;</kbd> pick &nbsp; <kbd>&darr;</kbd> no difference &nbsp; <kbd>space</kbd> backdrop &nbsp;
  <kbd>a</kbd> alpha only &nbsp; <kbd>z</kbd> zoom
</div>
<script>
  const BACKDROPS = ['checker', 'light', 'dark', 'busy'];
  let backdrop = 0,
    alphaOnly = false,
    current = null;

  // Alpha rendered as greyscale. Halo and haze are far easier to see as
  // luminance than as a fringe against art.
  function toAlpha(img, el) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < d.data.length; i += 4) {
      const a = d.data[i + 3];
      d.data[i] = d.data[i + 1] = d.data[i + 2] = a;
      d.data[i + 3] = 255;
    }
    g.putImageData(d, 0, 0);
    el.src = c.toDataURL();
  }

  function paint(el, subject, technique) {
    const src = `/render/${subject}/${technique}.png`;
    if (!alphaOnly) {
      el.src = src;
      return;
    }
    const probe = new Image();
    probe.onload = () => toAlpha(probe, el);
    probe.src = src;
  }

  async function load() {
    current = await (await fetch('/api/next')).json();
    if (!current) {
      document.getElementById('meta').textContent = 'No comparisons left.';
      document.getElementById('imgL').src = document.getElementById('imgR').src = '';
      return;
    }
    paint(document.getElementById('imgL'), current.subject, current.left);
    paint(document.getElementById('imgR'), current.subject, current.right);
    document.getElementById('meta').textContent = `${current.subject} · ${current.bucket}`;
  }

  async function vote(winner) {
    if (!current) return;
    await fetch('/api/verdict', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...current, winner }),
    });
    load();
  }

  function cycle() {
    backdrop = (backdrop + 1) % BACKDROPS.length;
    for (const id of ['stageL', 'stageR']) document.getElementById(id).className = 'stage ' + BACKDROPS[backdrop];
  }

  // Magnifier: fringe quality is a pixel-level judgment, so the origin tracks
  // the cursor and both sides zoom together for a like-for-like look.
  for (const id of ['stageL', 'stageR']) {
    document.getElementById(id).addEventListener('mousemove', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const ox = ((e.clientX - r.left) / r.width) * 100;
      const oy = ((e.clientY - r.top) / r.height) * 100;
      for (const im of ['imgL', 'imgR']) document.getElementById(im).style.transformOrigin = `${ox}% ${oy}%`;
    });
  }

  addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') vote('left');
    else if (e.key === 'ArrowRight') vote('right');
    else if (e.key === 'ArrowDown') vote('tie');
    else if (e.key === ' ') {
      e.preventDefault();
      cycle();
    } else if (e.key === 'a') {
      alphaOnly = !alphaOnly;
      if (current) load();
    } else if (e.key === 'z') {
      for (const im of ['imgL', 'imgR']) document.getElementById(im).classList.toggle('zoom');
    }
  });
  load();
</script>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -v`
Expected: PASS (5 tests)

Then the whole bench suite: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -v`
Expected: PASS (50 tests — probe 2, store 5, postops 7, techniques 6, corpus 6, render 4, ranking 8, pairing 7, web 5)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/matte_bench/static tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): judging UI and HTTP API"
```

---

### Task 10: Wire the session together — bootstrap, batch render, standings view

**Files:**

- Modify: `tools/matte-bench/matte_bench/cli.py`
- Create: `tools/matte-bench/matte_bench/session.py`
- Create: `tools/matte-bench/tests/test_session.py`

**Interfaces:**

- Produces:
  - `async bootstrap(root, subjects_path, comfy_url) -> tuple[list[Subject], list[Technique], list[str]]` — probes availability, renders any missing plates and renders, returns subjects, techniques, and a list of human-readable warnings for techniques that failed.
  - `install_state(state, subjects, techniques, root) -> None`

- [ ] **Step 1: Write the failing test**

`tools/matte-bench/tests/test_session.py`:

```python
from pathlib import Path

from matte_bench.corpus import Subject
from matte_bench.session import install_state
from matte_bench.techniques import Technique, config_hash
from matte_bench.web import State


def _t(tid="birefnet-hr", model="BiRefNet-HR"):
    return Technique(id=tid, cls="A", node="BiRefNetRMBG", model=model,
                     params={}, post=())


def test_install_state_exposes_config_hashes_not_ids(tmp_path: Path):
    """The UI fetches /render/<subject>/<hash>.png, so state carries hashes."""
    st = State()
    subjects = [Subject(id="s1", bucket="wispy", prompt="p", seed=1,
                        width=8, height=8)]
    install_state(st, subjects, [_t()], tmp_path)
    assert st.techniques == [config_hash(_t())]


def test_install_state_records_plate_hashes(tmp_path: Path):
    st = State()
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=8, height=8)
    plate = tmp_path / "plates" / "s1.png"
    plate.parent.mkdir(parents=True)
    plate.write_bytes(b"pixels")
    install_state(st, [s], [_t()], tmp_path)
    assert set(st.plate_hashes) == {"s1"}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_session.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'matte_bench.session'`

- [ ] **Step 3: Write minimal implementation**

`tools/matte-bench/matte_bench/session.py`:

```python
"""Bring a judging session up: probe, render what is missing, install state.

Techniques that cannot render are REPORTED, never silently dropped — ranking
eight models while the operator believes they are seeing fifteen would be a
silent lie.
"""
from pathlib import Path

from matte_bench.corpus import Subject, ensure_plate, load_subjects, plate_hashes
from matte_bench.probe import available_models, fetch_object_info
from matte_bench.render import RenderError, ensure_render
from matte_bench.techniques import Technique, config_hash, stage1_models


def install_state(state, subjects: list[Subject], techniques: list[Technique],
                  root: Path) -> None:
    state.root = root
    state.subjects = subjects
    state.techniques = [config_hash(t) for t in techniques]
    state.plate_hashes = plate_hashes(subjects, root)


async def bootstrap(root: Path, subjects_path: Path, comfy_url: str):
    subjects = load_subjects(subjects_path)
    techniques = stage1_models(available_models(fetch_object_info(comfy_url)))
    warnings: list[str] = []

    for s in subjects:
        await ensure_plate(s, root, comfy_url)

    usable: list[Technique] = []
    for t in techniques:
        ok = True
        for s in subjects:
            try:
                await ensure_render(s, t, root, comfy_url)
            except RenderError as exc:
                warnings.append(f"{t.id} unavailable: {exc.reason}")
                ok = False
                break
        if ok:
            usable.append(t)
    return subjects, usable, warnings
```

Modify `tools/matte-bench/matte_bench/cli.py` — replace the `main` body's serve branch:

```python
def main(argv: list[str]) -> int:
    import asyncio
    import os
    from pathlib import Path

    from app.config import get_settings

    from matte_bench.probe import available_models, fetch_object_info

    settings = get_settings()
    repo = Path(__file__).resolve().parents[3]
    root = repo / "var" / "matte-bench"
    subjects_path = repo / "tools" / "matte-bench" / "subjects.json"

    if argv and argv[0] == "probe":
        found = available_models(fetch_object_info(settings.comfyui_url))
        if not found:
            print(f"No matting nodes on {settings.comfyui_url}")
            return 1
        for node, models in found.items():
            print(f"{node}: {len(models)} models")
            for m in models:
                print(f"  {m}")
        return 0

    import uvicorn

    from matte_bench.session import bootstrap, install_state
    from matte_bench.web import app, state

    subjects, techniques, warnings = asyncio.run(
        bootstrap(root, subjects_path, settings.comfyui_url))
    install_state(state, subjects, techniques, root)
    print(f"{len(subjects)} subjects, {len(techniques)} techniques usable")
    for w in warnings:
        print(f"  WARNING {w}")
    port = 8400 + int(os.environ.get("BLOOM_PORT_OFFSET") or 0)
    uvicorn.run(app, host="0.0.0.0", port=port)
    return 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -v`
Expected: PASS (52 tests — the 50 above plus session 2)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/session.py tools/matte-bench/matte_bench/cli.py tools/matte-bench/tests/test_session.py
git commit -m "feat(matte-bench): session bootstrap with availability reporting"
```

---

## Manual verification (after Task 10)

Not automated — this is the first real run, and it is where the plan meets the GPU.

1. `just matte-bench probe` — record the installed model list.
2. `just matte-bench` — expect plate generation (14 renders) then per-technique renders. This is the long batch; 14 subjects x N models.
3. Open `http://localhost:8400`, judge 20 comparisons, cycle backdrops on each.
4. `curl http://localhost:8400/api/standings/wispy` — expect a table with intervals, most likely all overlapping this early. That is the correct answer for 20 votes, not a bug.
5. Confirm `tools/matte-bench/verdicts.jsonl` has one line per vote and is committed.

## Deferred to a follow-up plan

- **Stage 2 (param sweeps)** and **Stage 3 (post-op techniques)**: the registry, render cache and ranking already support them; they need a technique-generation step and a UI affordance for picking which stage to judge.
- **Fault-tagging grid** for finalists: `POST /api/fault` and the store exist; the grid UI does not.
- **Class B techniques**: schema carries `cls`, and `standings` filters by bucket only, so Class B must be filtered out of Class A tables when it lands.

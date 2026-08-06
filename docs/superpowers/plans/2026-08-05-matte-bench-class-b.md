# Matte Bench Class B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-class verdict pooling structurally impossible, ship working backdrop-key Class B techniques, weight-gated Qwen native-RGBA techniques, a best-A-vs-best-B champion playoff, and background prefetch of the next comparison.

**Architecture:** `Verdict` gains a `cls` field ("A"/"B"/"X") derived server-side; every ranking/pairing/progress computation filters on `(bucket, cls)`. Class B renders generate their own image per technique (flux + PIL chroma key now; Qwen layered-latent when weights land, auto-detected by the probe). The playoff is a two-technique class reusing the Bradley-Terry machinery verbatim. Prefetch is a server-side speculation layer with zero schema or ranking impact.

**Tech Stack:** Python 3.12 (FastAPI, PIL, httpx), pytest, vanilla JS in one static page. Spec: `docs/superpowers/specs/2026-08-05-matte-bench-class-b-design.md`.

## Global Constraints

- All code lives in `tools/matte-bench/`; nothing in `studio/` changes.
- The verdict log is append-only and never rewritten; old lines must parse as `cls="A"`.
- Blindness: mid-comparison text never names a technique; winner names appear only for separated buckets (per class).
- TDD is mandatory: failing test first, minimal code, then refactor.
- Semantic commits (`feat:`/`test:`/`docs:` etc.), imperative mood.
- Test command (from repo root): `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`. All 64 existing tests must stay green after every task.
- Prettier gate: run `npx --yes prettier@3.6.2 --write <file>` on any touched `.html`/`.json`/`.md` before committing.
- No Playwright; no new Python dependencies (PIL and httpx are already available via studio/backend).

---

### Task 1: `Verdict.cls` schema field

**Files:**

- Modify: `tools/matte-bench/matte_bench/store.py:12-21`
- Test: `tools/matte-bench/tests/test_store.py`

**Interfaces:**

- Produces: `Verdict` dataclass with new final field `cls: str = "A"`. All later tasks construct `Verdict(..., cls="A"|"B"|"X")` and read `v.cls`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_store.py`)

```python
def test_old_verdict_lines_parse_as_class_a(tmp_path):
    """Lines written before the cls field must read back as Class A."""
    log = tmp_path / "verdicts.jsonl"
    log.write_text(json.dumps({
        "subject": "s1", "bucket": "wispy", "left": "aaa", "right": "bbb",
        "winner": "left", "plate_hash": "h1", "ts": "t", "repeat_of": None,
    }) + "\n", encoding="utf-8")
    [v] = read_verdicts(log)
    assert v.cls == "A"


def test_append_verdict_writes_cls(tmp_path):
    log = tmp_path / "verdicts.jsonl"
    append_verdict(log, Verdict(subject="s1", bucket="wispy", left="aaa",
                                right="bbb", winner="tie", plate_hash="h1",
                                ts="t", cls="X"))
    line = json.loads(log.read_text(encoding="utf-8").strip())
    assert line["cls"] == "X"
    [v] = read_verdicts(log)
    assert v.cls == "X"
```

Ensure `import json` is present at the top of the test file (it likely already is; add if missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_store.py -q`
Expected: FAIL — `TypeError: Verdict.__init__() got an unexpected keyword argument 'cls'`

- [ ] **Step 3: Add the field** (`matte_bench/store.py`)

```python
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
    cls: str = "A"       # "A" (same pixels) | "B" (different pixels) | "X" (playoff)
```

No other changes: `append_verdict` uses `asdict`, which now includes `cls`; `read_verdicts` uses `Verdict(**d)`, and the default covers old lines.

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS (all existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/store.py tools/matte-bench/tests/test_store.py
git commit -m "feat(matte-bench): verdicts carry their comparison class"
```

---

### Task 2: Class-scoped ranking

**Files:**

- Modify: `tools/matte-bench/matte_bench/ranking.py:66-68`
- Test: `tools/matte-bench/tests/test_ranking.py`

**Interfaces:**

- Produces: `standings(verdicts, bucket, rounds=200, rng_seed=7, cls="A")` — new keyword-only-by-position-safe param appended last. Filters `v.bucket == bucket and v.cls == cls`. `fit()` and `separated()` unchanged.

- [ ] **Step 1: Write the failing test** (append to `tests/test_ranking.py`; follow the file's existing verdict-fixture helper — if it builds `Verdict(...)` directly, mirror that style)

```python
def _v(left, right, winner, bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t", cls=cls)


def test_standings_never_mix_classes():
    """A and B verdicts in the same bucket must fit separately."""
    verdicts = [_v("a1", "a2", "left") for _ in range(10)]
    verdicts += [_v("b1", "b2", "left", cls="B") for _ in range(10)]
    a_rows = standings(verdicts, "wispy")            # default cls="A"
    b_rows = standings(verdicts, "wispy", cls="B")
    assert {r.technique for r in a_rows} == {"a1", "a2"}
    assert {r.technique for r in b_rows} == {"b1", "b2"}


def test_standings_empty_for_class_with_no_verdicts():
    verdicts = [_v("a1", "a2", "left")]
    assert standings(verdicts, "wispy", cls="X") == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_ranking.py -q`
Expected: FAIL — `TypeError: standings() got an unexpected keyword argument 'cls'`

- [ ] **Step 3: Implement** (`matte_bench/ranking.py`)

```python
def standings(verdicts: list[Verdict], bucket: str, rounds: int = 200,
              rng_seed: int = 7, cls: str = "A") -> list[Standing]:
    scoped = [v for v in verdicts if v.bucket == bucket and v.cls == cls]
```

(only the signature and the `scoped` line change; the rest of the body is untouched)

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS — existing standings tests still pass because their verdicts default to `cls="A"` and the default param is `"A"`.

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/ranking.py tools/matte-bench/tests/test_ranking.py
git commit -m "feat(matte-bench): scope standings to one comparison class"
```

---

### Task 3: Probe detects the plate checkpoint and Qwen weights

**Files:**

- Modify: `tools/matte-bench/matte_bench/probe.py`
- Test: `tools/matte-bench/tests/test_probe.py`

**Interfaces:**

- Produces:
  - `_loader_choices(object_info: dict, node: str, key: str) -> list[str]` (module-private helper)
  - `checkpoint_installed(object_info: dict, ckpt_name: str) -> bool`
  - `plate_checkpoint(graph: dict) -> str | None` — first `CheckpointLoaderSimple`/`UNETLoader` node's model name in a built graph
  - `qwen_weights(object_info: dict) -> dict | None` — `{"unet": ..., "clip": ..., "vae": ...}` when the full trio plus the layered node are present, else `None`

- [ ] **Step 1: Write the failing tests** (append to `tests/test_probe.py`)

```python
from matte_bench.probe import checkpoint_installed, plate_checkpoint, qwen_weights


def _info(**nodes):
    return dict(nodes)


def _loader(key, choices):
    return {"input": {"required": {key: [choices]}}}


def test_checkpoint_installed_checks_both_loaders():
    info = _info(CheckpointLoaderSimple=_loader("ckpt_name", ["flux1-dev-fp8.safetensors"]))
    assert checkpoint_installed(info, "flux1-dev-fp8.safetensors")
    assert not checkpoint_installed(info, "missing.safetensors")
    info2 = _info(UNETLoader=_loader("unet_name", ["qwen_image_fp8_e4m3fn.safetensors"]))
    assert checkpoint_installed(info2, "qwen_image_fp8_e4m3fn.safetensors")


def test_plate_checkpoint_reads_built_graph():
    graph = {"1": {"class_type": "CheckpointLoaderSimple",
                   "inputs": {"ckpt_name": "flux1-dev-fp8.safetensors"}},
             "2": {"class_type": "KSampler", "inputs": {}}}
    assert plate_checkpoint(graph) == "flux1-dev-fp8.safetensors"
    assert plate_checkpoint({"2": {"class_type": "KSampler", "inputs": {}}}) is None


def test_qwen_weights_requires_full_trio_and_node():
    full = _info(
        UNETLoader=_loader("unet_name", ["qwen_image_fp8_e4m3fn.safetensors"]),
        CLIPLoader=_loader("clip_name", ["qwen_2.5_vl_7b_fp8_scaled.safetensors"]),
        VAELoader=_loader("vae_name", ["qwen_image_vae.safetensors"]),
        EmptyQwenImageLayeredLatentImage={"input": {"required": {}}},
    )
    got = qwen_weights(full)
    assert got == {"unet": "qwen_image_fp8_e4m3fn.safetensors",
                   "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
                   "vae": "qwen_image_vae.safetensors"}
    no_vae = dict(full)
    no_vae["VAELoader"] = _loader("vae_name", ["taesd"])
    assert qwen_weights(no_vae) is None
    no_node = {k: v for k, v in full.items()
               if k != "EmptyQwenImageLayeredLatentImage"}
    assert qwen_weights(no_node) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_probe.py -q`
Expected: FAIL — `ImportError: cannot import name 'checkpoint_installed'`

- [ ] **Step 3: Implement** (append to `matte_bench/probe.py`)

```python
def _loader_choices(object_info: dict, node: str, key: str) -> list[str]:
    spec = object_info.get(node) or {}
    choices = (spec.get("input", {}).get("required", {}).get(key) or [None])[0]
    return list(choices) if isinstance(choices, list) else []


def checkpoint_installed(object_info: dict, ckpt_name: str) -> bool:
    """True when either loader can load this model by name."""
    return (ckpt_name in _loader_choices(object_info, "CheckpointLoaderSimple", "ckpt_name")
            or ckpt_name in _loader_choices(object_info, "UNETLoader", "unet_name"))


def plate_checkpoint(graph: dict) -> str | None:
    """The generator model a built graph loads — probed from the graph itself
    so a workflow swap cannot silently desync the availability check."""
    for node in graph.values():
        if node.get("class_type") in ("CheckpointLoaderSimple", "UNETLoader"):
            inputs = node.get("inputs") or {}
            return inputs.get("ckpt_name") or inputs.get("unet_name")
    return None


def qwen_weights(object_info: dict) -> dict | None:
    """The Qwen-Image weight trio, or None. All three files plus the layered
    latent node must be present — a partial install reads as not installed,
    never as a false positive."""
    unet = [n for n in _loader_choices(object_info, "UNETLoader", "unet_name")
            if "qwen_image" in n.lower() and "vae" not in n.lower()]
    clip = [n for n in _loader_choices(object_info, "CLIPLoader", "clip_name")
            if "qwen" in n.lower()]
    vae = [n for n in _loader_choices(object_info, "VAELoader", "vae_name")
           if "qwen_image_vae" in n.lower()]
    if unet and clip and vae and "EmptyQwenImageLayeredLatentImage" in object_info:
        return {"unet": unet[0], "clip": clip[0], "vae": vae[0]}
    return None
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/probe.py tools/matte-bench/tests/test_probe.py
git commit -m "feat(matte-bench): probe plate checkpoint and qwen weight availability"
```

---

### Task 4: Class B technique builders + Qwen install note

**Files:**

- Modify: `tools/matte-bench/matte_bench/techniques.py`
- Create: `tools/matte-bench/README-qwen.md`
- Test: `tools/matte-bench/tests/test_techniques.py`

**Interfaces:**

- Produces:
  - `BACKDROP_VARIANTS` — tuple of `(name, key_color_rgb_tuple, prompt_clause)`
  - `backdrop_techniques() -> list[Technique]` — two techniques, `cls="B"`, `node="backdrop-key"`, `model=<variant name>`, params `{"clause", "key_color", "tolerance", "softness", "despill"}`
  - `qwen_techniques(weights: dict | None) -> list[Technique]` — one technique when weights given (`cls="B"`, `node="qwen-layered"`, `model=weights["unet"]`, params `{"clip", "vae"}`), else `[]`

- [ ] **Step 1: Write the failing tests** (append to `tests/test_techniques.py`)

```python
from matte_bench.techniques import backdrop_techniques, qwen_techniques


def test_backdrop_techniques_are_class_b_with_key_params():
    got = backdrop_techniques()
    assert len(got) == 2
    assert all(t.cls == "B" and t.node == "backdrop-key" for t in got)
    for t in got:
        assert {"clause", "key_color", "tolerance", "softness", "despill"} <= set(t.params)
    assert len({config_hash(t) for t in got}) == 2   # variants hash apart


def test_qwen_techniques_gated_on_weights():
    assert qwen_techniques(None) == []
    weights = {"unet": "qwen_image_fp8_e4m3fn.safetensors",
               "clip": "qwen_2.5_vl_7b_fp8_scaled.safetensors",
               "vae": "qwen_image_vae.safetensors"}
    [t] = qwen_techniques(weights)
    assert t.cls == "B" and t.node == "qwen-layered"
    assert t.model == weights["unet"]
    assert t.params == {"clip": weights["clip"], "vae": weights["vae"]}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_techniques.py -q`
Expected: FAIL — `ImportError: cannot import name 'backdrop_techniques'`

- [ ] **Step 3: Implement** (append to `matte_bench/techniques.py`)

```python
# Class B, family 1: generate the subject on a flat key-colored backdrop and
# key the color out afterwards (see matte_bench.keying). The clause is part of
# the technique config, so editing it re-renders (config_hash covers params).
BACKDROP_VARIANTS = (
    ("chroma-green", (0, 177, 64),
     "isolated on a solid flat chroma green (#00B140) studio backdrop, "
     "even lighting, no shadows on the backdrop"),
    ("chroma-magenta", (255, 0, 144),
     "isolated on a solid flat chroma magenta (#FF0090) studio backdrop, "
     "even lighting, no shadows on the backdrop"),
)


def backdrop_techniques() -> list[Technique]:
    out = []
    for name, key_color, clause in BACKDROP_VARIANTS:
        out.append(Technique(
            id=f"backdrop-{name}", cls="B", node="backdrop-key", model=name,
            params={"clause": clause, "key_color": list(key_color),
                    "tolerance": 60, "softness": 60, "despill": 1},
            post=()))
    return out


def qwen_techniques(weights: dict | None) -> list[Technique]:
    """Class B, family 2: native-RGBA generation. Materializes only when the
    probe found the full weight trio (see README-qwen.md for the install)."""
    if not weights:
        return []
    return [Technique(id="qwen-layered", cls="B", node="qwen-layered",
                      model=weights["unet"],
                      params={"clip": weights["clip"], "vae": weights["vae"]},
                      post=())]
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Write the install note** (`tools/matte-bench/README-qwen.md`)

```markdown
# Enabling the Qwen native-RGBA techniques

The `qwen-layered` Class B technique generates transparent art directly
(no matting pass). It appears in the bench automatically once the weights
below are installed on the ComfyUI box — no code change, no restart flag;
the availability probe detects them at bench startup.

Download from the Comfy-Org `Qwen-Image_ComfyUI` release on Hugging Face
and place on the GPU box:

| File                                            | Destination                        |
| ----------------------------------------------- | ---------------------------------- |
| `qwen_image_fp8_e4m3fn.safetensors` (~20 GB)    | `ComfyUI/models/diffusion_models/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` (~9 GB) | `ComfyUI/models/text_encoders/`    |
| `qwen_image_vae.safetensors` (~250 MB)          | `ComfyUI/models/vae/`              |

Then restart ComfyUI (it scans model folders at startup) and start the
bench. `just matte-bench probe` should list the Qwen files; if the bench
prints `qwen-layered disabled: Qwen weights not installed`, one of the
three files is missing or misnamed — the probe requires the full trio and
matches on `qwen_image` / `qwen` / `qwen_image_vae` in the loader lists.
```

- [ ] **Step 6: Format and commit**

```bash
npx --yes prettier@3.6.2 --write tools/matte-bench/README-qwen.md
git add tools/matte-bench/matte_bench/techniques.py tools/matte-bench/tests/test_techniques.py tools/matte-bench/README-qwen.md
git commit -m "feat(matte-bench): class B technique builders and qwen install note"
```

---

### Task 5: Chroma keying

**Files:**

- Create: `tools/matte-bench/matte_bench/keying.py`
- Test: `tools/matte-bench/tests/test_keying.py`

**Interfaces:**

- Produces: `chroma_key(img: Image.Image, key_color: tuple[int, int, int], tolerance: float, softness: float, despill: bool = True) -> Image.Image` — returns a new RGBA image; never mutates the input.

- [ ] **Step 1: Write the failing tests** (`tests/test_keying.py`)

```python
from PIL import Image

from matte_bench.keying import chroma_key

GREEN = (0, 177, 64)


def _flat(color, size=(8, 8)):
    return Image.new("RGB", size, color)


def test_key_color_becomes_fully_transparent():
    out = chroma_key(_flat(GREEN), GREEN, tolerance=60, softness=60)
    assert out.mode == "RGBA"
    assert all(a == 0 for a in out.getchannel("A").getdata())


def test_distant_color_stays_opaque():
    out = chroma_key(_flat((200, 40, 180)), GREEN, tolerance=60, softness=60)
    assert all(a == 255 for a in out.getchannel("A").getdata())


def test_ramp_between_tolerance_and_softness():
    # distance from GREEN is 90: past tolerance 60, half-way through softness 60
    near = (0, 177, 64 + 90)
    out = chroma_key(_flat(near), GREEN, tolerance=60, softness=60)
    a = out.getchannel("A").getdata()[0]
    assert 100 <= a <= 155      # ~50% with rounding slack


def test_despill_clamps_key_dominant_channel():
    # a green-spilled edge pixel: green well above red/blue
    out = chroma_key(_flat((80, 200, 90)), GREEN, tolerance=10, softness=10,
                     despill=True)
    r, g, b, a = out.getpixel((0, 0))
    assert g <= max(r, b)


def test_despill_off_preserves_color():
    out = chroma_key(_flat((80, 200, 90)), GREEN, tolerance=10, softness=10,
                     despill=False)
    assert out.getpixel((0, 0))[:3] == (80, 200, 90)


def test_input_not_mutated():
    src = _flat(GREEN)
    chroma_key(src, GREEN, tolerance=60, softness=60)
    assert src.getpixel((0, 0)) == GREEN
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_keying.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'matte_bench.keying'`

- [ ] **Step 3: Implement** (`matte_bench/keying.py`)

```python
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
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/keying.py tools/matte-bench/tests/test_keying.py
git commit -m "feat(matte-bench): PIL chroma keying for backdrop techniques"
```

---

### Task 6: Class B render path

**Files:**

- Modify: `tools/matte-bench/matte_bench/techniques.py` (add `qwen_graph`)
- Modify: `tools/matte-bench/matte_bench/render.py:43-71` (`ensure_render` branches on class)
- Test: `tools/matte-bench/tests/test_render.py`, `tools/matte-bench/tests/test_techniques.py`

**Interfaces:**

- Consumes: `chroma_key` (Task 5), `backdrop_techniques`/`qwen_techniques` param shapes (Task 4), `build_graph`/`PLATE_WORKFLOW` from `matte_bench.corpus` imports (`from app.assets.graph import build_graph` — already imported by `corpus.py`; import it in `render.py` from `app.assets.graph` directly).
- Produces:
  - `qwen_graph(t: Technique, prompt: str, width: int, height: int, seed: int) -> dict` in `techniques.py`
  - `ensure_render` unchanged signature, now handling `t.cls == "B"`; `backdrop_prompt(subject_prompt: str, clause: str) -> str` helper in `render.py` returning `f"{subject_prompt}, {clause}"`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_techniques.py`:

```python
from matte_bench.techniques import qwen_graph


def test_qwen_graph_wires_layered_latent():
    [t] = qwen_techniques({"unet": "u.safetensors", "clip": "c.safetensors",
                           "vae": "v.safetensors"})
    g = qwen_graph(t, "a glowing lantern", 768, 512, seed=7)
    classes = {n["class_type"] for n in g.values()}
    assert "EmptyQwenImageLayeredLatentImage" in classes
    assert "UNETLoader" in classes and "CLIPLoader" in classes and "VAELoader" in classes
    latent = next(n for n in g.values()
                  if n["class_type"] == "EmptyQwenImageLayeredLatentImage")
    assert latent["inputs"]["width"] == 768 and latent["inputs"]["height"] == 512
    sampler = next(n for n in g.values() if n["class_type"] == "KSampler")
    assert sampler["inputs"]["seed"] == 7
    text = next(n for n in g.values()
                if n["class_type"] == "CLIPTextEncode"
                and n["inputs"]["text"])["inputs"]["text"]
    assert text == "a glowing lantern"
```

Append to `tests/test_render.py` (the file currently only tests `render_path`; add an async render test with a fake provider, mirroring how `test_render_errors.py` fakes `LiveComfyProvider` — read that file first and reuse its fake/monkeypatch pattern rather than inventing a new one):

```python
import asyncio

from PIL import Image
from io import BytesIO

from matte_bench.render import ensure_render
from matte_bench.corpus import Subject, plate_path


def _b(**over):
    base = dict(id="backdrop-chroma-green", cls="B", node="backdrop-key",
                model="chroma-green",
                params={"clause": "isolated on a solid flat chroma green backdrop",
                        "key_color": [0, 177, 64], "tolerance": 60,
                        "softness": 60, "despill": 1},
                post=())
    return Technique(**{**base, **over})


def _flat_png(color, size=(16, 16)):
    buf = BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def test_backdrop_render_generates_and_keys(tmp_path, monkeypatch):
    """A backdrop technique renders its own image (no plate needed) and the
    key color comes out transparent."""
    captured = {}

    class FakeProvider:
        def __init__(self, base_url):
            pass

        async def generate(self, graph):
            captured["graph"] = graph
            from matte_bench.render import ImageEvent
            yield ImageEvent(data=_flat_png((0, 177, 64)))

    monkeypatch.setattr("matte_bench.render.LiveComfyProvider", FakeProvider)
    s = Subject(id="s1", bucket="wispy", prompt="a fern", seed=3,
                width=16, height=16)
    dest = asyncio.run(ensure_render(s, _b(), tmp_path, "http://gpu:8188"))
    out = Image.open(dest).convert("RGBA")
    assert all(a == 0 for a in out.getchannel("A").getdata())
    # the generation prompt is the subject prompt plus the backdrop clause
    prompts = [n["inputs"].get("text") for n in captured["graph"].values()
               if isinstance(n.get("inputs"), dict) and "text" in n.get("inputs", {})]
    assert any(p and "a fern" in p and "chroma green" in p for p in prompts)
```

Note for the implementer: `ImageEvent` construction must match its real dataclass signature in `app.assets.comfy` — check it and adjust the fake if it takes more fields. If `test_render_errors.py` already has a fake-provider helper, import/reuse it instead of `FakeProvider` above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_render.py ../../tools/matte-bench/tests/test_techniques.py -q`
Expected: FAIL — `ImportError: cannot import name 'qwen_graph'` and the render test failing because `ensure_render` demands a plate for a Class B technique.

- [ ] **Step 3: Implement `qwen_graph`** (append to `matte_bench/techniques.py`)

```python
def qwen_graph(t: Technique, prompt: str, width: int, height: int,
               seed: int) -> dict:
    """Native-RGBA generation graph. Input names validated against the box's
    live object_info before first use (see Task 15 verification step) — a
    mismatch fails loudly at render time and the technique is dropped, so a
    wrong guess cannot corrupt verdicts."""
    return {
        "unet": {"class_type": "UNETLoader",
                 "inputs": {"unet_name": t.model, "weight_dtype": "default"}},
        "clip": {"class_type": "CLIPLoader",
                 "inputs": {"clip_name": t.params["clip"], "type": "qwen_image"}},
        "vae": {"class_type": "VAELoader", "inputs": {"vae_name": t.params["vae"]}},
        "pos": {"class_type": "CLIPTextEncode",
                "inputs": {"clip": ["clip", 0], "text": prompt}},
        "neg": {"class_type": "CLIPTextEncode",
                "inputs": {"clip": ["clip", 0], "text": ""}},
        "latent": {"class_type": "EmptyQwenImageLayeredLatentImage",
                   "inputs": {"width": width, "height": height,
                              "layers": 1, "batch_size": 1}},
        "sample": {"class_type": "KSampler",
                   "inputs": {"model": ["unet", 0], "positive": ["pos", 0],
                              "negative": ["neg", 0],
                              "latent_image": ["latent", 0], "seed": seed,
                              "steps": 20, "cfg": 2.5, "sampler_name": "euler",
                              "scheduler": "simple", "denoise": 1.0}},
        "decode": {"class_type": "VAEDecode",
                   "inputs": {"samples": ["sample", 0], "vae": ["vae", 0]}},
        "save": {"class_type": "SaveImage",
                 "inputs": {"images": ["decode", 0],
                            "filename_prefix": "mattebench-qwen"}},
    }
```

- [ ] **Step 4: Implement the render branch** (`matte_bench/render.py` — restructure `ensure_render` so image _production_ branches by class and the post-op/write tail is shared)

```python
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

from app.assets.comfy import ImageEvent, LiveComfyProvider, ProgressEvent
from app.assets.graph import build_graph

from matte_bench.corpus import PLATE_WORKFLOW, Subject, plate_path
from matte_bench.keying import chroma_key
from matte_bench.postops import apply_postops
from matte_bench.store import atomic_write_bytes
from matte_bench.techniques import Technique, config_hash, matting_graph, qwen_graph


def backdrop_prompt(subject_prompt: str, clause: str) -> str:
    return f"{subject_prompt}, {clause}"


async def _generate(graph: dict, comfy_url: str, on_progress) -> bytes | None:
    image = None
    async for ev in LiveComfyProvider(base_url=comfy_url).generate(graph):
        if isinstance(ev, ProgressEvent) and on_progress is not None and ev.max > 0:
            on_progress(ev.value / ev.max)
        if isinstance(ev, ImageEvent):
            image = ev.data
    return image


async def _produce_class_a(s: Subject, t: Technique, root: Path,
                           comfy_url: str, on_progress) -> bytes | None:
    plate = plate_path(root, s.id)
    if not plate.exists():
        raise RenderError(t.id, f"no plate for subject {s.id}")
    name = upload_plate(comfy_url, plate)
    return await _generate(matting_graph(t, name), comfy_url, on_progress)


async def _produce_class_b(s: Subject, t: Technique, comfy_url: str,
                           on_progress) -> bytes | None:
    if t.node == "backdrop-key":
        prompt = backdrop_prompt(s.prompt, t.params["clause"])
        graph = build_graph(PLATE_WORKFLOW, prompt, s.width, s.height, s.seed)
        image = await _generate(graph, comfy_url, on_progress)
        if not image:
            return image
        keyed = chroma_key(Image.open(BytesIO(image)).convert("RGB"),
                           tuple(t.params["key_color"]),
                           t.params["tolerance"], t.params["softness"],
                           bool(t.params.get("despill", 1)))
        buf = BytesIO()
        keyed.save(buf, "PNG")
        return buf.getvalue()
    if t.node == "qwen-layered":
        graph = qwen_graph(t, s.prompt, s.width, s.height, s.seed)
        return await _generate(graph, comfy_url, on_progress)
    raise RenderError(t.id, f"unknown class B node: {t.node}")


async def ensure_render(s: Subject, t: Technique, root: Path, comfy_url: str,
                        on_progress=None) -> Path:
    """`on_progress` receives ComfyUI's progress as a 0..1 fraction."""
    dest = render_path(root, s.id, t)
    if dest.exists():
        return dest
    try:
        if t.cls == "B":
            image = await _produce_class_b(s, t, comfy_url, on_progress)
        else:
            image = await _produce_class_a(s, t, root, comfy_url, on_progress)
    except RenderError:
        raise
    except Exception as exc:                          # noqa: BLE001 - reported, not swallowed
        raise RenderError(t.id, str(exc)) from exc
    if not image:
        raise RenderError(t.id, "rendering produced no image")
    if t.post:
        img = apply_postops(Image.open(BytesIO(image)).convert("RGBA"), t.post)
        buf = BytesIO()
        img.save(buf, "PNG")
        image = buf.getvalue()
    atomic_write_bytes(dest, image)
    return dest
```

Keep `RenderError`, `render_path`, `upload_plate` exactly as they are. Note the existing error-message string changes from "matting produced no image" to "rendering produced no image" — check `test_render_errors.py` for an assertion on that string and update it if present.

- [ ] **Step 5: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add tools/matte-bench/matte_bench/render.py tools/matte-bench/matte_bench/techniques.py tools/matte-bench/tests/test_render.py tools/matte-bench/tests/test_techniques.py
git commit -m "feat(matte-bench): class B render paths (backdrop-key, qwen-layered)"
```

---

### Task 7: Playoff module

**Files:**

- Create: `tools/matte-bench/matte_bench/playoff.py`
- Test: `tools/matte-bench/tests/test_playoff.py`

**Interfaces:**

- Consumes: `standings(verdicts, bucket, cls=...)`, `separated(rows)` from Task 2.
- Produces:
  - `class_champion(verdicts, bucket, cls) -> str | None`
  - `playoff_pair(verdicts, bucket) -> tuple[str, str] | None` — `(a_champion, b_champion)` when both classes are separated
  - `derive_cls(left, right, technique_cls: dict[str, str], verdicts, bucket) -> str | None` — server-side class of a judged pair; `None` = illegal pair

- [ ] **Step 1: Write the failing tests** (`tests/test_playoff.py`)

```python
from matte_bench.playoff import class_champion, derive_cls, playoff_pair
from matte_bench.store import Verdict


def _v(left, right, winner="left", bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t", cls=cls)


def _decisive(a, b, cls, n=12):
    """Enough one-sided verdicts to clear the evidence floor and separate."""
    return [_v(a, b, "left", cls=cls) for _ in range(n)]


def test_no_champion_below_evidence_floor():
    assert class_champion([_v("a1", "a2")], "wispy", "A") is None


def test_champion_when_separated():
    assert class_champion(_decisive("a1", "a2", "A"), "wispy", "A") == "a1"


def test_playoff_pair_needs_both_classes():
    verdicts = _decisive("a1", "a2", "A")
    assert playoff_pair(verdicts, "wispy") is None
    verdicts += _decisive("b1", "b2", "B")
    assert playoff_pair(verdicts, "wispy") == ("a1", "b1")


def test_derive_cls_same_class_pairs():
    cls_map = {"a1": "A", "a2": "A", "b1": "B", "b2": "B"}
    assert derive_cls("a1", "a2", cls_map, [], "wispy") == "A"
    assert derive_cls("b1", "b2", cls_map, [], "wispy") == "B"


def test_derive_cls_champions_make_playoff():
    cls_map = {"a1": "A", "a2": "A", "b1": "B", "b2": "B"}
    verdicts = _decisive("a1", "a2", "A") + _decisive("b1", "b2", "B")
    assert derive_cls("a1", "b1", cls_map, verdicts, "wispy") == "X"
    assert derive_cls("b1", "a1", cls_map, verdicts, "wispy") == "X"


def test_derive_cls_rejects_illegal_pairs():
    cls_map = {"a1": "A", "a2": "A", "b1": "B", "b2": "B"}
    # cross-class but not champions (no separation at all)
    assert derive_cls("a1", "b1", cls_map, [], "wispy") is None
    # unknown technique
    assert derive_cls("a1", "zz", cls_map, [], "wispy") is None
    # cross-class, champions exist but this pair isn't them
    verdicts = _decisive("a1", "a2", "A") + _decisive("b1", "b2", "B")
    assert derive_cls("a2", "b1", cls_map, verdicts, "wispy") is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_playoff.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'matte_bench.playoff'`

- [ ] **Step 3: Implement** (`matte_bench/playoff.py`)

```python
"""Cross-class end-game: best-A vs best-B, logged as cls "X".

A playoff is just a two-technique class: standings/separated work on X
verdicts unchanged, and the evidence floor applies. The pair always follows
the CURRENT champions — if a class's leader changes, X verdicts for the
dethroned pairing stay in the log and simply stop accumulating.
"""
from matte_bench.ranking import separated, standings
from matte_bench.store import Verdict


def class_champion(verdicts: list[Verdict], bucket: str, cls: str) -> str | None:
    rows = standings(verdicts, bucket, cls=cls)
    return rows[0].technique if separated(rows) else None


def playoff_pair(verdicts: list[Verdict], bucket: str) -> tuple[str, str] | None:
    a = class_champion(verdicts, bucket, "A")
    b = class_champion(verdicts, bucket, "B")
    return (a, b) if a is not None and b is not None else None


def derive_cls(left: str, right: str, technique_cls: dict[str, str],
               verdicts: list[Verdict], bucket: str) -> str | None:
    """The server-derived class of a judged pair; None when the pair is not
    a comparison the bench could legally have served."""
    lc, rc = technique_cls.get(left), technique_cls.get(right)
    if lc is None or rc is None:
        return None
    if lc == rc:
        return lc
    pair = playoff_pair(verdicts, bucket)
    if pair is not None and {left, right} == set(pair):
        return "X"
    return None
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/playoff.py tools/matte-bench/tests/test_playoff.py
git commit -m "feat(matte-bench): champion playoff logic and server-side class derivation"
```

---

### Task 8: Class-aware pairing

**Files:**

- Modify: `tools/matte-bench/matte_bench/pairing.py`
- Test: `tools/matte-bench/tests/test_pairing.py`

**Interfaces:**

- Produces:
  - `next_sampled_comparison(subject, techniques, verdicts, rng, repeat_every=20, known=None, cls="A")` — new `cls` param; the function first scopes `verdicts` to that class, so pair counts, strengths, and repeat-probe candidates are all intra-class.
  - `pick_class(bucket: str, verdicts, pools: dict[str, list[str]], playoff_open: bool) -> str | None` — which class to serve next in this bucket; `None` when no class is serveable.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_pairing.py`)

```python
from matte_bench.pairing import pick_class


def _v(left, right, bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner="left", plate_hash="h", ts="t", cls=cls)


def test_next_comparison_scopes_verdicts_to_class():
    """B verdicts must not influence A pair counts. With one A pair already
    judged and an unrelated B verdict logged, the A picker must still prefer
    the unjudged A pair."""
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = [_v("a1", "a2"), _v("b1", "b2", cls="B"),
                _v("b1", "b2", cls="B"), _v("b1", "b2", cls="B")]
    rng = random.Random(7)
    c = next_sampled_comparison(s, ["a1", "a2", "a3"], verdicts, rng,
                                repeat_every=0, cls="A")
    assert {c.left, c.right} != {"a1", "a2"}   # least-judged: an a3 pair


def test_repeat_probe_stays_intra_class():
    """With repeat certain to fire, candidates only come from same-class
    verdicts of registered subjects."""
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = [_v("b1", "b2", cls="B")]
    rng = random.Random(7)
    c = next_sampled_comparison(s, ["a1", "a2"], verdicts, rng,
                                repeat_every=1, known=[s], cls="A")
    assert c.repeat_of is None    # the only logged pair is class B


def test_pick_class_fewest_verdicts_first():
    pools = {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    verdicts = [_v("a1", "a2")] * 3 + [_v("b1", "b2", cls="B")]
    assert pick_class("wispy", verdicts, pools, playoff_open=False) == "B"


def test_pick_class_tie_prefers_a():
    pools = {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    assert pick_class("wispy", [], pools, playoff_open=False) == "A"


def test_pick_class_skips_single_technique_pools():
    pools = {"A": ["a1", "a2"], "B": ["b1"]}
    verdicts = [_v("a1", "a2")] * 5
    assert pick_class("wispy", verdicts, pools, playoff_open=False) == "A"


def test_pick_class_includes_open_playoff():
    pools = {"A": ["a1", "a2"], "B": ["b1", "b2"]}
    verdicts = [_v("a1", "a2")] * 3 + [_v("b1", "b2", cls="B")] * 3
    assert pick_class("wispy", verdicts, pools, playoff_open=True) == "X"


def test_pick_class_none_when_nothing_serveable():
    assert pick_class("wispy", [], {"A": ["a1"], "B": []}, playoff_open=False) is None
```

Adjust imports at the top of the test file as needed (`random`, `Subject`, `Verdict`, `next_sampled_comparison`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_pairing.py -q`
Expected: FAIL — `ImportError: cannot import name 'pick_class'` (and `cls=` TypeError once that resolves)

- [ ] **Step 3: Implement** (`matte_bench/pairing.py`)

In `next_sampled_comparison`, add the parameter and scope verdicts first:

```python
def next_sampled_comparison(subject: Subject, techniques: list[str],
                            verdicts: list[Verdict], rng: random.Random,
                            repeat_every: int = 20,
                            known: list[Subject] | None = None,
                            cls: str = "A",
                            ) -> Comparison | None:
    if len(techniques) < 2:
        return None
    verdicts = [v for v in verdicts if v.cls == cls]
    seen = judged_pairs(verdicts)
    ...
```

(everything after the `verdicts = [...]` line is byte-for-byte today's body — the bucket-scoping for strengths further down stays as-is, it now operates on class-scoped verdicts)

Add `pick_class`:

```python
def pick_class(bucket: str, verdicts: list[Verdict],
               pools: dict[str, list[str]], playoff_open: bool) -> str | None:
    """Which class to serve next in this bucket: fewest verdicts first, ties
    alphabetical (A before B before X). A class needs two techniques to
    compare; the playoff competes only once it is open."""
    counts = {cls: 0 for cls, pool in pools.items() if len(pool) >= 2}
    if playoff_open:
        counts["X"] = 0
    if not counts:
        return None
    for v in verdicts:
        if v.bucket == bucket and v.cls in counts:
            counts[v.cls] += 1
    thinnest = min(counts.values())
    return sorted(c for c, n in counts.items() if n == thinnest)[0]
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/pairing.py tools/matte-bench/tests/test_pairing.py
git commit -m "feat(matte-bench): class-aware pairing and class selection"
```

---

### Task 9: Per-class progress

**Files:**

- Modify: `tools/matte-bench/matte_bench/progress.py`
- Test: `tools/matte-bench/tests/test_progress.py`

**Interfaces:**

- Produces:
  - `BucketProgress` unchanged.
  - New `ClassProgress(cls: str, total: int, buckets: tuple[BucketProgress, ...])`
  - `ProgressReport(total: int, classes: tuple[ClassProgress, ...])` — **breaking shape change**; `progress()` signature unchanged. Classes sorted "A" < "B" < "X"; only classes present in the verdict set appear.

- [ ] **Step 1: Rewrite the failing tests** (`tests/test_progress.py` — port the existing assertions to the new shape and add class cases; keep every behavior the old tests covered: empty log, unseparated winner None, separated winner label, sort by count desc)

```python
from matte_bench.progress import progress
from matte_bench.store import Verdict


def _v(left, right, winner="left", bucket="wispy", cls="A"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="t", cls=cls)


def test_empty_log():
    report = progress([], {})
    assert report.total == 0 and report.classes == ()


def test_single_class_counts_and_blindness():
    verdicts = [_v("t1", "t2"), _v("t1", "t2", bucket="filigree"),
                _v("t1", "t2", bucket="filigree")]
    report = progress(verdicts, {})
    assert report.total == 3
    [a] = report.classes
    assert a.cls == "A" and a.total == 3
    assert [b.bucket for b in a.buckets] == ["filigree", "wispy"]  # count desc
    assert all(b.winner is None for b in a.buckets)  # unseparated: blind


def test_separated_bucket_names_winner():
    verdicts = [_v("t1", "t2") for _ in range(12)]
    report = progress(verdicts, {"t1": "RMBG/BiRefNet-HR"})
    [a] = report.classes
    assert a.buckets[0].separated and a.buckets[0].winner == "RMBG/BiRefNet-HR"


def test_classes_partition_and_sort():
    verdicts = [_v("a1", "a2")] * 2 + [_v("b1", "b2", cls="B")] * 3
    report = progress(verdicts, {})
    assert report.total == 5
    assert [c.cls for c in report.classes] == ["A", "B"]
    assert report.classes[0].total == 2 and report.classes[1].total == 3


def test_class_b_winner_from_b_standings_only():
    verdicts = [_v("a1", "a2")] * 12 + [_v("b1", "b2", cls="B")] * 12
    report = progress(verdicts, {"a1": "A-champ", "b1": "B-champ"})
    a, b = report.classes
    assert a.buckets[0].winner == "A-champ"
    assert b.buckets[0].winner == "B-champ"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_progress.py -q`
Expected: FAIL — `AttributeError: 'ProgressReport' object has no attribute 'classes'`

- [ ] **Step 3: Implement** (`matte_bench/progress.py`)

```python
@dataclass(frozen=True)
class ClassProgress:
    cls: str
    total: int
    buckets: tuple[BucketProgress, ...]


@dataclass(frozen=True)
class ProgressReport:
    total: int
    classes: tuple[ClassProgress, ...]


def progress(verdicts: list[Verdict],
             technique_names: dict[str, str]) -> ProgressReport:
    classes = []
    for cls in sorted({v.cls for v in verdicts}):
        scoped = [v for v in verdicts if v.cls == cls]
        counts: dict[str, int] = {}
        for v in scoped:
            counts[v.bucket] = counts.get(v.bucket, 0) + 1
        buckets = []
        for bucket in sorted(counts, key=lambda b: (-counts[b], b)):
            rows = standings(verdicts, bucket, cls=cls)
            done = separated(rows)
            # Winner names only for finished buckets: the operator judging an
            # active bucket stays blind to its standings.
            winner = (technique_names.get(rows[0].technique, rows[0].technique)
                      if done else None)
            buckets.append(BucketProgress(bucket=bucket, count=counts[bucket],
                                          separated=done, winner=winner))
        classes.append(ClassProgress(cls=cls, total=len(scoped),
                                     buckets=tuple(buckets)))
    return ProgressReport(total=len(verdicts), classes=tuple(classes))
```

- [ ] **Step 4: Run the full bench suite** — `tests/test_web.py` has a `/api/progress` shape test that now fails; update it in this task to the new route shape only if the route is also updated here. It is not — the route changes in Task 11. To keep the suite green at every commit, update the route's serialization **in this task**:

In `web.py`, replace the body of `api_progress` with:

```python
@app.get("/api/progress")
def api_progress() -> dict:
    """Session progress per comparison class: how much has been judged and
    which buckets are settled. Winner names only for separated buckets — the
    judge stays blind to the standings of buckets still in play."""
    report = progress(_live_verdicts(), state.technique_names)
    return {
        "total": report.total,
        "classes": [
            {"cls": c.cls, "total": c.total,
             "buckets": [
                 {"bucket": b.bucket, "count": b.count,
                  "separated": b.separated, "winner": b.winner}
                 for b in c.buckets
             ]}
            for c in report.classes
        ],
    }
```

and port the `/api/progress` assertions in `tests/test_web.py` to expect `{"total": ..., "classes": [...]}`.

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/progress.py tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_progress.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): per-class progress report and route"
```

---

### Task 10: Bootstrap wires Class B into the registry

**Files:**

- Modify: `tools/matte-bench/matte_bench/session.py`
- Modify: `tools/matte-bench/matte_bench/web.py:40-62` (State gains `technique_cls`)
- Test: `tools/matte-bench/tests/test_session.py`

**Interfaces:**

- Consumes: `checkpoint_installed`, `plate_checkpoint`, `qwen_weights` (Task 3); `backdrop_techniques`, `qwen_techniques` (Task 4); `build_graph`, `PLATE_WORKFLOW`.
- Produces:
  - `bootstrap(...)` returns registry including Class B techniques, with warnings `"backdrop-key disabled: plate checkpoint not installed"` / `"qwen-layered disabled: Qwen weights not installed"` when gated off.
  - `install_state` sets `state.technique_cls: dict[str, str]` (`config_hash -> cls`).
  - `State.technique_cls: dict[str, str] = field(default_factory=dict)`

- [ ] **Step 1: Write the failing tests** (append to `tests/test_session.py`; follow its existing monkeypatch style for `fetch_object_info`)

```python
def _info_with_flux_and_matting():
    return {
        "CheckpointLoaderSimple": {"input": {"required": {
            "ckpt_name": [["flux1-dev-fp8.safetensors"]]}}},
        "BiRefNetRMBG": {"input": {"required": {
            "model": [["BiRefNet-HR", "BiRefNet-general"]]}}},
    }


def test_bootstrap_adds_backdrop_when_checkpoint_present(tmp_path, monkeypatch):
    monkeypatch.setattr("matte_bench.session.fetch_object_info",
                        lambda url: _info_with_flux_and_matting())
    (tmp_path / "templates.json").write_text("{}", encoding="utf-8")
    subjects, templates, techniques, warnings = asyncio.run(bootstrap(
        tmp_path, tmp_path / "templates.json", tmp_path / "subjects.jsonl",
        "http://gpu:8188"))
    assert any(t.cls == "B" and t.node == "backdrop-key" for t in techniques)
    assert any(t.cls == "A" for t in techniques)
    assert any("qwen-layered disabled" in w for w in warnings)


def test_bootstrap_gates_backdrop_without_checkpoint(tmp_path, monkeypatch):
    info = _info_with_flux_and_matting()
    info["CheckpointLoaderSimple"]["input"]["required"]["ckpt_name"] = [[]]
    monkeypatch.setattr("matte_bench.session.fetch_object_info", lambda url: info)
    (tmp_path / "templates.json").write_text("{}", encoding="utf-8")
    _, _, techniques, warnings = asyncio.run(bootstrap(
        tmp_path, tmp_path / "templates.json", tmp_path / "subjects.jsonl",
        "http://gpu:8188"))
    assert not any(t.node == "backdrop-key" for t in techniques)
    assert any("backdrop-key disabled" in w for w in warnings)


def test_install_state_maps_hash_to_cls(tmp_path):
    from matte_bench.web import State
    s = State()
    techniques = stage1_models({"RMBG": ["m1", "m2"]}) + backdrop_techniques()
    install_state(s, [], techniques, tmp_path, "http://gpu:8188")
    assert set(s.technique_cls.values()) == {"A", "B"}
    assert len(s.technique_cls) == len(techniques)
```

Add needed imports (`asyncio`, `bootstrap`, `install_state`, `stage1_models`, `backdrop_techniques`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_session.py -q`
Expected: FAIL — backdrop technique absent from bootstrap result / `AttributeError: technique_cls`

- [ ] **Step 3: Implement**

`web.py` State — add the field:

```python
    technique_cls: dict[str, str] = field(default_factory=dict)
```

`session.py`:

```python
from app.assets.graph import build_graph

from matte_bench.corpus import PLATE_WORKFLOW, Subject, load_subject_log, plate_hashes
from matte_bench.probe import (
    available_models, checkpoint_installed, fetch_object_info, plate_checkpoint,
    qwen_weights,
)
from matte_bench.techniques import (
    Technique, backdrop_techniques, config_hash, qwen_techniques, stage1_models,
)
```

In `install_state`, after the `technique_objs` line:

```python
    state.technique_cls = {config_hash(t): t.cls for t in techniques}
```

In `bootstrap`, replace the probe block:

```python
    try:
        info = fetch_object_info(comfy_url)
    except Exception as exc:                          # noqa: BLE001 - reported, not swallowed
        warnings.append(f"probe failed: {exc}")
        return subjects, templates, [], warnings
    techniques = stage1_models(available_models(info))
    ckpt = plate_checkpoint(build_graph(PLATE_WORKFLOW, "probe", 64, 64, 0))
    if ckpt is not None and checkpoint_installed(info, ckpt):
        techniques += backdrop_techniques()
    else:
        warnings.append("backdrop-key disabled: plate checkpoint not installed")
    weights = qwen_weights(info)
    if weights is not None:
        techniques += qwen_techniques(weights)
    else:
        warnings.append("qwen-layered disabled: Qwen weights not installed")
    return subjects, templates, techniques, warnings
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/session.py tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_session.py
git commit -m "feat(matte-bench): bootstrap registers class B techniques when available"
```

---

### Task 11: Server-side verdict class + class-aware standings/techniques routes

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (`api_verdict`, `api_standings`, `api_techniques`)
- Test: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: `derive_cls` (Task 7), `standings(..., cls=...)` (Task 2), `state.technique_cls` (Task 10).
- Produces:
  - `POST /api/verdict` writes `cls`; 422 `"pair is not a legal comparison"` for illegal pairs.
  - `GET /api/standings/{bucket}?cls=A|B|X` (default `"A"`; 422 on other values).
  - `GET /api/techniques` → `{hash: {"label": str, "cls": str}}`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_web.py`, using its existing TestClient/state-setup fixtures — read the file's fixture pattern first and mirror it; the snippets below assume a helper that installs techniques `{"a1": "A", "a2": "A", "b1": "B"}` with plate hash `"h"` for subject `"s1"`)

```python
def test_verdict_records_derived_class(client_with_state):
    client, state = client_with_state
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "b1x", "right": "b2x",
        "winner": "left"})
    assert resp.status_code == 200
    from matte_bench.store import read_verdicts
    [v] = read_verdicts(state.verdict_log)
    assert v.cls == "B"


def test_verdict_rejects_cross_class_non_champions(client_with_state):
    client, state = client_with_state
    resp = client.post("/api/verdict", json={
        "subject": "s1", "bucket": "wispy", "left": "a1x", "right": "b1x",
        "winner": "left"})
    assert resp.status_code == 422
    assert read_verdicts(state.verdict_log) == []


def test_standings_route_takes_cls(client_with_state):
    client, _ = client_with_state
    assert client.get("/api/standings/wispy?cls=B").status_code == 200
    assert client.get("/api/standings/wispy?cls=Z").status_code == 422


def test_techniques_route_includes_cls(client_with_state):
    client, _ = client_with_state
    body = client.get("/api/techniques").json()
    assert all(set(v) == {"label", "cls"} for v in body.values())
```

Exact fixture wiring is the implementer's job: `test_web.py` already builds a TestClient with a populated `state` — extend that setup so `state.technique_cls` holds a mix of A and B hashes and the verdict log points into `tmp_path`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: FAIL — verdict line has `cls == "A"` for a B pair (derivation missing), 200 for the illegal pair, no `cls` query param, flat techniques map.

- [ ] **Step 3: Implement** (`web.py`)

Add import: `from matte_bench.playoff import derive_cls, playoff_pair` (playoff_pair used in Task 12).

`api_verdict` — after the `plate_hash is None` check:

```python
    verdicts = _live_verdicts()
    cls = derive_cls(body.left, body.right, state.technique_cls, verdicts,
                     body.bucket)
    if cls is None:
        raise HTTPException(status_code=422,
                            detail="pair is not a legal comparison")
    append_verdict(state.verdict_log, Verdict(
        subject=body.subject, bucket=body.bucket, left=body.left,
        right=body.right, winner=body.winner, plate_hash=plate_hash,
        ts=_now(), repeat_of=body.repeat_of, cls=cls))
```

`api_standings`:

```python
@app.get("/api/standings/{bucket}")
def api_standings(bucket: str, cls: str = "A") -> dict:
    if cls not in ("A", "B", "X"):
        raise HTTPException(status_code=422, detail="cls must be A, B or X")
    rows = standings(_live_verdicts(), bucket, cls=cls)
    return {
        "separated": separated(rows),
        "rows": [
            {"technique": r.technique,
             "label": state.technique_names.get(r.technique, r.technique),
             "score": r.score, "low": r.low, "high": r.high,
             "comparisons": r.comparisons}
            for r in rows
        ],
    }
```

`api_techniques` — value becomes a dict:

```python
    return {h: {"label": state.technique_names.get(h, h),
                "cls": state.technique_cls.get(h, "A")}
            for h in state.techniques}
```

(keep the route's existing docstring; adjust it to mention `cls`)

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): server-derived verdict class and class-aware routes"
```

---

### Task 12: Class-aware serving in `/api/next`

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py:191-220` (`_compute_next`; new helpers `_pools`, `_choose_comparison`)
- Test: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: `pick_class` (Task 8), `playoff_pair` (Task 7), `state.technique_cls` (Task 10).
- Produces:
  - `_pools() -> dict[str, list[str]]` — technique hashes by class from live state.
  - `_choose_comparison(subject, verdicts, rng) -> tuple[Comparison | None, str | None]`
  - `/api/next` ready payload gains `"cls"`.

- [ ] **Step 1: Write the failing test** (append to `tests/test_web.py`; unit-level on the helpers, not the polling route — the job thread makes route-level tests slow and flaky)

```python
def test_choose_comparison_serves_thinner_class(bench_state):
    """With A well-fed and B starved, the next comparison is class B."""
    from matte_bench.web import _choose_comparison, state
    # bench_state installs pools A: [a1x, a2x], B: [b1x, b2x]
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = [Verdict(subject="s1", bucket="wispy", left="a1x", right="a2x",
                        winner="left", plate_hash="h", ts="t")] * 4
    c, cls = _choose_comparison(s, verdicts, random.Random(7))
    assert cls == "B" and {c.left, c.right} == {"b1x", "b2x"}


def test_choose_comparison_serves_playoff_when_open(bench_state):
    from matte_bench.web import _choose_comparison
    s = Subject(id="s1", bucket="wispy", prompt="p", seed=1, width=64, height=64)
    verdicts = ([Verdict(subject="s1", bucket="wispy", left="a1x", right="a2x",
                         winner="left", plate_hash="h", ts="t")] * 12
                + [Verdict(subject="s1", bucket="wispy", left="b1x", right="b2x",
                           winner="left", plate_hash="h", ts="t", cls="B")] * 12)
    c, cls = _choose_comparison(s, verdicts, random.Random(7))
    assert cls == "X" and {c.left, c.right} == {"a1x", "b1x"}
```

(`bench_state` = whatever fixture Task 11 established; extend it so `state.techniques` holds the four hashes and `state.technique_cls` maps them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: FAIL — `ImportError: cannot import name '_choose_comparison'`

- [ ] **Step 3: Implement** (`web.py`; add `from matte_bench.pairing import ..., pick_class` and `from matte_bench.pairing import Comparison`)

```python
def _pools() -> dict[str, list[str]]:
    pools: dict[str, list[str]] = {"A": [], "B": []}
    for h in state.techniques:
        pools.setdefault(state.technique_cls.get(h, "A"), []).append(h)
    return pools


def _choose_comparison(subject, verdicts, rng):
    """The comparison to serve on this subject, and its class. The playoff
    pair bypasses the sampled picker: its two contenders are fixed."""
    pools = _pools()
    pair = playoff_pair(verdicts, subject.bucket)
    cls = pick_class(subject.bucket, verdicts, pools, pair is not None)
    if cls is None:
        return None, None
    if cls == "X":
        a, b = pair
        left, right = (a, b) if rng.random() < 0.5 else (b, a)
        return Comparison(subject=subject.id, bucket=subject.bucket,
                          left=left, right=right), "X"
    c = next_sampled_comparison(subject, pools[cls], verdicts, rng,
                                cls=cls, known=state.subjects)
    return c, cls
```

Rewrite `_compute_next`'s pick block (the `len(state.techniques) < 2` guard moves into `pick_class`'s pool-size rule):

```python
async def _compute_next(progress):
    for _ in range(8):
        progress("choosing comparison…")
        verdicts = _live_verdicts()
        subject = await _pick_subject(verdicts, progress)
        c, cls = _choose_comparison(subject, verdicts, state.rng)
        if c is None:
            return None
        try:
            await _prepare(c, progress)
        except RenderError as exc:
            # Discovered lazily rather than by a pre-flight sweep: drop it and
            # move on, but never silently — the operator must be able to see
            # that they are judging fewer techniques than they think.
            state.unavailable[exc.technique_id] = exc.reason
            state.techniques = [t for t in state.techniques
                                if state.technique_objs.get(t) is None
                                or state.technique_objs[t].id != exc.technique_id]
            continue
        except Exception as exc:                  # noqa: BLE001 - reported, not swallowed
            state.unavailable[c.left] = str(exc)
            return None
        if c.repeat_of is None and c.subject == state.active_subject_id:
            state.active_served += 1
        return {"subject": c.subject, "bucket": c.bucket, "left": c.left,
                "right": c.right, "repeat_of": c.repeat_of, "cls": cls}
    return None
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): serve comparisons per class with playoff"
```

---

### Task 13: Prefetch

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (State fields, `_pick_subject` split, prefetch functions, `api_next` hook)
- Test: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: everything above; `PAIRS_PER_SUBJECT`.
- Produces:
  - `State.staged_subject: Subject | None`, `State.prefetch: threading.Thread | None`, `State.prefetch_lock: threading.Lock`
  - `_predicted_verdicts(verdicts, served: dict) -> list[Verdict]` — pure
  - `_sample_fresh(verdicts, progress) -> Subject` — extracted from `_pick_subject`, used by both the demand path and the prefetcher
  - `_start_prefetch(served: dict) -> None` — single-flight thread launch, called from `api_next` when returning a ready comparison

**Design recap (from the spec):** prediction is winner-agnostic (a synthetic tie on the served pair moves the counts the same as any real winner); the rng is cloned via `getstate()/setstate()` so the predicted draw consumes the same stream the real pick will; a miss costs nothing (renders cache per subject+technique); the prefetcher never touches `state.rng`, never increments `active_served`, and swallows all errors — the demand path re-discovers them properly.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_web.py`)

```python
def test_predicted_verdicts_adds_winner_agnostic_tie():
    from matte_bench.web import _predicted_verdicts
    served = {"subject": "s1", "bucket": "wispy", "left": "a1x",
              "right": "a2x", "cls": "A", "repeat_of": None}
    got = _predicted_verdicts([], served)
    [v] = got
    assert v.winner == "tie" and v.cls == "A"
    assert (v.left, v.right) == ("a1x", "a2x")
    assert v.plate_hash == "prediction"   # never collides with a real hash


def test_start_prefetch_is_single_flight(bench_state, monkeypatch):
    from matte_bench import web
    import threading

    started = []
    release = threading.Event()

    def slow_run(served):
        started.append(served)
        release.wait(timeout=5)

    monkeypatch.setattr(web, "_run_prefetch", slow_run)
    served = {"subject": "s1", "bucket": "wispy", "left": "a1x",
              "right": "a2x", "cls": "A", "repeat_of": None}
    web._start_prefetch(served)
    web._start_prefetch(served)     # second call must be a no-op
    release.set()
    web.state.prefetch.join(timeout=5)
    assert len(started) == 1


def test_prefetch_never_consumes_the_shared_rng(bench_state, monkeypatch):
    """The spec's on/off equivalence guarantee at its mechanism: prediction
    clones the rng stream, so real picks are identical with prefetch on."""
    from matte_bench import web

    async def no_prepare(c, progress):
        pass

    monkeypatch.setattr(web, "_prepare", no_prepare)
    web.state.active_subject_id = "s1"
    web.state.active_served = 0
    before = web.state.rng.getstate()
    asyncio.run(web._prefetch_async({"subject": "s1", "bucket": "wispy",
                                     "left": "a1x", "right": "a2x",
                                     "cls": "A", "repeat_of": None}))
    assert web.state.rng.getstate() == before


def test_pick_subject_consumes_staged_subject(bench_state):
    from matte_bench import web
    staged = Subject(id="staged-1", bucket="wispy", prompt="p", seed=9,
                     width=64, height=64)
    web.state.staged_subject = staged
    web.state.active_subject_id = None   # forces rotation
    got = asyncio.run(web._pick_subject([], lambda *a, **k: None))
    assert got.id == "staged-1"
    assert web.state.staged_subject is None
    assert web.state.active_subject_id == "staged-1"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: FAIL — missing `_predicted_verdicts` / `_start_prefetch` / staged-subject behavior

- [ ] **Step 3: Implement** (`web.py`)

State fields:

```python
    staged_subject: Subject | None = None
    prefetch: threading.Thread | None = None
    prefetch_lock: threading.Lock = field(default_factory=threading.Lock)
```

Split `_pick_subject` — extract the fresh-draw tail into a helper both paths share, and consume a staged subject first:

```python
async def _sample_fresh(verdicts, progress) -> Subject:
    """Draw and register a fresh subject from the thinnest bucket. LLM-imagined
    when a provider is configured, template-sampled otherwise."""
    buckets = [b for b in BUCKETS if b in state.templates]
    bucket = least_judged_bucket(buckets, verdicts, state.rng)
    subject = None
    if state.llm is not None and state.rng.random() >= TEMPLATE_MIX:
        progress("imagining a new subject…")
        recent = [s.prompt.split(",")[0] for s in state.subjects
                  if s.bucket == bucket][-6:]
        subject = await sample_subject_llm(bucket, state.rng, state.templates,
                                           state.llm, state.llm_model, recent)
    if subject is None:
        subject = sample_subject(bucket, state.rng, state.templates)
    append_subject(state.subject_log, subject)
    state.subjects.append(subject)
    return subject


async def _pick_subject(verdicts, progress) -> Subject:
    """Reuse the active sampled subject for a few comparisons (its plate is
    cached), then rotate: to the prefetcher's staged subject when one is
    ready, else to a fresh draw."""
    if state.active_subject_id is not None and state.active_served < PAIRS_PER_SUBJECT:
        active = next((s for s in state.subjects
                       if s.id == state.active_subject_id), None)
        if active is not None:
            return active
    if state.staged_subject is not None:
        subject = state.staged_subject
        state.staged_subject = None
    else:
        subject = await _sample_fresh(verdicts, progress)
    state.active_subject_id = subject.id
    state.active_served = 0
    return subject
```

**Careful:** `_sample_fresh` must NOT set `active_subject_id`/`active_served` (the prefetcher stages without activating); `_pick_subject` sets them for whichever subject it returns — note this also now (correctly) resets the counters when returning a re-found active subject… no: keep the early-return for the active subject exactly as today (no counter reset). Only the rotation path sets them.

Prefetch machinery (place after `_NextJob`):

```python
def _predicted_verdicts(verdicts: list[Verdict], served: dict) -> list[Verdict]:
    """The verdict set after the operator votes on `served`, winner-agnostic:
    a synthetic tie moves every pair count exactly like a real verdict, and
    the winner only nudges the strength tie-break."""
    return verdicts + [Verdict(
        subject=served["subject"], bucket=served["bucket"],
        left=served["left"], right=served["right"], winner="tie",
        plate_hash="prediction", ts="", cls=served.get("cls", "A"))]


async def _prefetch_async(served: dict) -> None:
    verdicts = _predicted_verdicts(_live_verdicts(), served)
    noop = lambda *a, **k: None                       # noqa: E731
    rotation_next = (served["repeat_of"] is not None
                     or state.active_served + 1 >= PAIRS_PER_SUBJECT)
    if state.active_subject_id is None or (
            rotation_next and served["repeat_of"] is None):
        if state.staged_subject is None:
            state.staged_subject = await _sample_fresh(verdicts, noop)
        subject = state.staged_subject
    else:
        subject = next((s for s in state.subjects
                        if s.id == state.active_subject_id), None)
        if subject is None:
            return
    pred_rng = random.Random()
    pred_rng.setstate(state.rng.getstate())
    c, _cls = _choose_comparison(subject, verdicts, pred_rng)
    if c is not None:
        await _prepare(c, noop)


def _run_prefetch(served: dict) -> None:
    try:
        asyncio.run(_prefetch_async(served))
    except Exception:                                 # noqa: BLE001
        # Prefetch is best-effort by contract: any failure here simply means
        # the demand path pays the render and reports errors properly.
        pass


def _start_prefetch(served: dict) -> None:
    with state.prefetch_lock:
        if state.prefetch is not None and state.prefetch.is_alive():
            return
        t = threading.Thread(target=_run_prefetch, args=(served,), daemon=True)
        state.prefetch = t
        t.start()
```

Note on `rotation_next`: `active_served` was already incremented for the served comparison by `_compute_next`, so "the NEXT pick rotates" is `active_served >= PAIRS_PER_SUBJECT`. Verify against the increment ordering in `_compute_next` when implementing — the test for staged-subject consumption pins the observable behavior; adjust the arithmetic, not the test.

Hook in `api_next` — in the ready branch, before returning:

```python
    if job.result is not None:
        _start_prefetch(job.result)
    return {"status": "ready", "comparison": job.result}
```

- [ ] **Step 4: Run the full bench suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): prefetch the predicted next comparison in the background"
```

---

### Task 14: UI — per-class progress line and comparison badge

**Files:**

- Modify: `tools/matte-bench/matte_bench/static/index.html` (`refreshProgress` at ~line 213, the meta line at ~line 439)

**Interfaces:**

- Consumes: `/api/progress` per-class shape (Task 9), `comparison.cls` (Task 12).

- [ ] **Step 1: Update `refreshProgress`** to the per-class shape (replace the existing function body's parts mapping):

```javascript
// Never blocks judging: on any failure the line simply goes empty.
const CLASS_LABELS = { A: 'A', B: 'B', X: 'playoff' };
async function refreshProgress() {
  const el = document.getElementById('progress');
  try {
    const resp = await fetch('/api/progress');
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const body = await resp.json();
    const sections = body.classes.map((c) => {
      const parts = c.buckets.map((b) => (b.separated && b.winner ? `${b.bucket} ${b.count} → ${shortLabel(b.winner)}` : `${b.bucket} ${b.count}`));
      return [`${CLASS_LABELS[c.cls] || c.cls} ${c.total}`, ...parts].join(' · ');
    });
    el.textContent = sections.length ? sections.join('  |  ') : '';
  } catch (err) {
    console.error('progress fetch failed:', err);
    el.textContent = '';
  }
}
```

- [ ] **Step 2: Badge the comparison class in the meta line** (~line 439). The comparison object now carries `cls`; a non-A class is shown because the two sides visibly differ in art — the label names no technique, so blindness holds:

```javascript
const clsTag = current.cls === 'B' ? ' · Class B' : current.cls === 'X' ? ' · playoff' : '';
document.getElementById('meta').textContent = `${current.subject} · ${current.bucket}${clsTag}`;
```

- [ ] **Step 3: Format**

Run: `npx --yes prettier@3.6.2 --write tools/matte-bench/matte_bench/static/index.html`

- [ ] **Step 4: Manual smoke check** (no Playwright by ruling): start `just backend-serve-replay` is NOT needed — the bench is standalone. From the worktree with its port offset: `just matte-bench`, open `http://localhost:840N` (8400 + offset), confirm:
- the progress line reads `A <total> · <bucket> <n> …` (single class today),
- judging still works end-to-end (serve → vote → line refreshes).

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/static/index.html
git commit -m "feat(matte-bench): per-class progress line and comparison class badge"
```

---

### Task 15: Live verification + Qwen graph validation hook

**Files:**

- No new code. Verification of the whole branch against the real GPU box.

- [ ] **Step 1: Run the complete bench suite one more time**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: PASS, count strictly greater than the 64 the branch started with.

- [ ] **Step 2: Run the studio backend suite** (proves nothing in `studio/` broke)

Run: `cd studio/backend && uv run pytest -q`
Expected: PASS (880 tests as of PR #227).

- [ ] **Step 3: Live smoke against the GPU box** (requires ComfyUI up; skip and report if it is not reachable)

From the worktree: `just matte-bench probe` — expect the matting model list plus no crash. Then `just matte-bench`, open the UI, and judge until a **Class B comparison** is served (backdrop-key pool vs the A pool — pick_class alternates, so it arrives within a few comparisons). Confirm:

- the B comparison's meta line shows `· Class B`,
- both sides render (backdrop generation + keying works against real flux output),
- voting on it succeeds and the progress line grows a `B` section,
- after voting, the next comparison appears near-instantly when the prefetcher predicted it (watch the server log for back-to-back renders while reviewing).

- [ ] **Step 4: Qwen wiring validation note** — the qwen techniques are gated off until weights land, but validate the graph builder's assumptions now: run

```
cd studio/backend && uv run python -c "import httpx, json; info = httpx.get('http://192.168.1.110:8188/object_info', timeout=60).json(); spec = info.get('EmptyQwenImageLayeredLatentImage'); print(json.dumps(spec['input'], indent=2)) if spec else print('node absent')"
```

and compare the required input names against `qwen_graph`'s `latent` node (`width`/`height`/`layers`/`batch_size`). If they differ, fix `qwen_graph` and its shape test in the same commit:

```bash
git add tools/matte-bench/matte_bench/techniques.py tools/matte-bench/tests/test_techniques.py
git commit -m "fix(matte-bench): align qwen layered latent inputs with live node spec"
```

- [ ] **Step 5: Verify prettier gate repo-wide** (CI runs it on everything)

Run: `cd <worktree-root> && npx --yes prettier@3.6.2 --check .`
Expected: "All matched files use Prettier code style!"

---

## Execution notes

- Tasks 1–10 are pure-Python and independent of any server; Tasks 11–13 build on the web fixtures; Task 14 is UI; Task 15 is verification.
- The plan deliberately updates `test_web.py`'s progress-shape assertions inside Task 9 so the suite is green at every commit boundary.
- Branch: `feat/matte-bench-class-b` (worktree `C:\code\bloom.wt\matte-bench-class-b`, `BLOOM_PORT_OFFSET=2`). Finish with push + PR per repo rules.

# Compose Quality Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the #120 compose loop with five element-quality / convergence guards: text-legibility, regenerate→re-judge, critic-oscillation control, keep-in-frame, and transparency-integrity.

**Architecture:** Every change extends an existing seam — no new architecture. The per-asset critic gains a text + ghosted-solid vision check and a conservative transparency heuristic; the asset cassette becomes a stateless attempt-indexed sequence so a regenerate can converge to keep; `run_compose` gains a bounded re-judge loop, per-element edit history + a hard edit cap, and an in-frame guard that clamps off-canvas sprites using box math shared with the compositor.

**Tech Stack:** Python 3.12, Pydantic, Pillow, pytest / pytest-asyncio, langchain-core/langchain-openai (vision calls), Socket.IO (e2e). Backend lives in `studio/backend`; run commands from there.

## Global Constraints

- **Run all backend commands from `studio/backend`** via uv: `uv run pytest …`.
- **TDD is mandatory** — write the failing test, watch it fail, implement minimal, watch it pass, commit.
- **Provider modes:** unit/e2e here run under `PROVIDER_MODE=replay`; the asset/scene critics and Comfy generator are all replay seams. No live API calls in tests.
- **`asset_critic` is a process singleton** (built once in `app/main.py`) — the replay asset critic MUST stay **stateless**: it keys its verdict on `request.attempt` (mirroring the scene critic's `pass_index`), never an internal call counter.
- **One shared regeneration budget** (`ComposeBounds.regen_budget`, default 5) covers per-asset re-judge regenerations AND composition-critic regenerations.
- **In-frame corrections are geometric truth:** they apply via `deps.adjust` but do NOT count toward the per-element edit cap and tally separately in `ComposeResult.corrections_applied`.
- **TypeScript I-prefix rule** does not apply here (backend Python only).
- Existing golden/behaviour tests must stay green except where a task explicitly updates them.

---

### Task 1: Vision prompt — text legibility + ghosted-solid (items 1 & 5-vision)

Extend `ASSET_SYSTEM_PROMPT` so the per-asset vision critic reads text and flags ghosted solids. Pure prompt change; behaviour is exercised via cassettes in later tasks. Both vision additions live in one prompt edit to avoid two tasks fighting over the same string.

**Files:**

- Modify: `studio/backend/app/scene/asset_critic.py:99-108` (`ASSET_SYSTEM_PROMPT`)
- Test: `studio/backend/tests/test_asset_critic.py`

**Interfaces:**

- Consumes: nothing new.
- Produces: `ASSET_SYSTEM_PROMPT` now contains text-legibility and ghosted-solid language (asserted by a guard test; relied on only as a behavioural contract).

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_asset_critic.py`:

```python
def test_asset_prompt_checks_text_and_ghosted_solids():
    from app.scene.asset_critic import ASSET_SYSTEM_PROMPT

    low = ASSET_SYSTEM_PROMPT.lower()
    # item 1: must read and judge text on logos/UI
    assert "text" in low
    assert "misspelled" in low or "illegible" in low
    # item 5 (vision): must flag semi-transparent / ghosted solids
    assert "transparent" in low or "see-through" in low or "ghost" in low
    assert "opaque" in low
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_asset_critic.py::test_asset_prompt_checks_text_and_ghosted_solids -v`
Expected: FAIL (current prompt has none of "misspelled/illegible", "ghost/see-through", "opaque").

- [ ] **Step 3: Extend the prompt**

Replace `ASSET_SYSTEM_PROMPT` in `studio/backend/app/scene/asset_critic.py` with:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_asset_critic.py::test_asset_prompt_checks_text_and_ghosted_solids -v`
Expected: PASS.

- [ ] **Step 5: Run the full asset-critic suite (no regressions)**

Run: `uv run pytest tests/test_asset_critic.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/asset_critic.py studio/backend/tests/test_asset_critic.py
git commit -m "feat(scene): asset critic reads text and flags ghosted solids"
```

---

### Task 2: Transparency-integrity heuristic (item 5, deterministic)

Add a conservative, near-zero-false-positive deterministic check to `asset_heuristic` for transparent assets: a uniformly semi-transparent subject ("ghosted") or large interior transparency holes. Legitimately translucent art (glow/smoke) must NOT trip it.

**Files:**

- Modify: `studio/backend/app/scene/asset_critic.py` (constants near line 27-30; `asset_heuristic` 48-77)
- Create: `studio/backend/tests/fixtures/ghosted_solid.png`, `studio/backend/tests/fixtures/holed_solid.png`, `studio/backend/tests/fixtures/translucent_glow.png` (generated by a one-off snippet in Step 1)
- Test: `studio/backend/tests/test_asset_critic.py`

**Interfaces:**

- Consumes: nothing new.
- Produces: `asset_heuristic(image_png, *, transparent)` now also returns a `regenerate` `AssetVerdict` for ghosted / hole-punched transparent assets; new module constants `SOLID_ALPHA`, `MAX_PARTIAL_ALPHA_FRACTION`, `MIN_OPAQUE_CORE`, `MAX_INTERIOR_HOLE_FRACTION`.

- [ ] **Step 1: Generate the fixtures**

Run this once from `studio/backend` to create deterministic fixtures:

```bash
uv run python - <<'PY'
from io import BytesIO
from PIL import Image

def save(img, name):
    img.save(f"tests/fixtures/{name}", format="PNG")

# ghosted_solid: a big centred square but every pixel alpha=120 (semi-transparent
# subject, no opaque core anywhere)
g = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
for x in range(24, 104):
    for y in range(24, 104):
        g.putpixel((x, y), (200, 40, 40, 120))
save(g, "ghosted_solid.png")

# holed_solid: a fully-opaque block with a fully-transparent rectangle punched in
# the middle (interior hole not connected to the border)
h = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
for x in range(16, 112):
    for y in range(16, 112):
        h.putpixel((x, y), (30, 120, 200, 255))
for x in range(48, 80):
    for y in range(48, 80):
        h.putpixel((x, y), (0, 0, 0, 0))
save(h, "holed_solid.png")

# translucent_glow: legit FX — soft semi-transparent halo BUT with an opaque core
# (must NOT be flagged)
t = Image.new("RGBA", (128, 128), (0, 0, 0, 0))
cx, cy = 64, 64
for x in range(128):
    for y in range(128):
        d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
        if d < 18:
            t.putpixel((x, y), (255, 240, 180, 255))   # opaque core
        elif d < 56:
            a = int(200 * (1 - (d - 18) / 38))
            t.putpixel((x, y), (255, 220, 120, max(0, a)))
save(t, "translucent_glow.png")
print("fixtures written")
PY
```

- [ ] **Step 2: Write the failing tests**

Add to `studio/backend/tests/test_asset_critic.py`:

```python
def test_heuristic_flags_ghosted_solid():
    img = Path("tests/fixtures/ghosted_solid.png").read_bytes()
    v = asset_heuristic(img, transparent=True)
    assert v is not None and v.action == "regenerate"
    assert "see-through" in v.reason.lower() or "transparent" in v.reason.lower()


def test_heuristic_flags_hole_punched_solid():
    img = Path("tests/fixtures/holed_solid.png").read_bytes()
    v = asset_heuristic(img, transparent=True)
    assert v is not None and v.action == "regenerate"
    assert "hole" in v.reason.lower()


def test_heuristic_passes_legit_translucent_glow():
    # has an opaque core => NOT a ghosted solid; must defer to vision (return None)
    img = Path("tests/fixtures/translucent_glow.png").read_bytes()
    assert asset_heuristic(img, transparent=True) is None
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_asset_critic.py -k "ghosted or hole or translucent" -v`
Expected: ghosted/hole tests FAIL (heuristic returns None today); translucent test already PASSes.

- [ ] **Step 4: Implement the heuristic**

In `studio/backend/app/scene/asset_critic.py`, add constants beside the existing thresholds:

```python
# Transparency-integrity thresholds (item 5) — conservative, near-zero false
# positives so legit translucent art (glow/smoke) is left to the vision stage.
SOLID_ALPHA = 240                  # alpha at/above this counts as "fully opaque"
MAX_PARTIAL_ALPHA_FRACTION = 0.85  # >this share of visible px partial AND no core
MIN_OPAQUE_CORE = 0.05             # a real solid has at least this opaque fraction
MAX_INTERIOR_HOLE_FRACTION = 0.04  # interior (non-edge-connected) transparency cap
```

Add a private helper and extend `asset_heuristic` (transparent branch only):

```python
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
```

Then, inside `asset_heuristic`, in the `if transparent:` branch, AFTER the existing
empty-coverage check (`if frac < MIN_ALPHA_COVERAGE: return …`), add:

```python
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
```

(Note: `visible` and `total` are already computed earlier in the branch; reuse them.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `uv run pytest tests/test_asset_critic.py -v`
Expected: all PASS, including the existing `test_heuristic_passes_a_rich_transparent_asset` (varied alpha but those pixels are opaque=255, so `partial_frac_of_visible` is ~0 → not flagged) and `test_heuristic_flags_fully_transparent_cutout`.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/app/scene/asset_critic.py studio/backend/tests/test_asset_critic.py studio/backend/tests/fixtures/ghosted_solid.png studio/backend/tests/fixtures/holed_solid.png studio/backend/tests/fixtures/translucent_glow.png
git commit -m "feat(scene): heuristic flags ghosted and hole-punched transparent assets"
```

---

### Task 3: ComposeBounds / ComposeResult new fields

Add the tunable caps and the corrections tally. Trivial, but several later tasks depend on these names.

**Files:**

- Modify: `studio/backend/app/scene/compose_loop.py:25-31` (`ComposeBounds`), `53-61` (`ComposeResult`)
- Test: `studio/backend/tests/test_compose_loop.py`

**Interfaces:**

- Produces: `ComposeBounds.asset_regen_retries: int = 2`, `ComposeBounds.max_edits_per_element: int = 4`, `ComposeResult.corrections_applied: int = 0`.

- [ ] **Step 1: Write the failing test**

Add to `studio/backend/tests/test_compose_loop.py`:

```python
def test_bounds_and_result_have_new_quality_fields():
    b = ComposeBounds()
    assert b.asset_regen_retries == 2
    assert b.max_edits_per_element == 4
    # still the established defaults
    assert (b.look_behind, b.max_passes, b.regen_budget) == (3, 3, 5)
    assert ComposeResult().corrections_applied == 0
```

- [ ] **Step 2: Run test to verify it fails**

Run: `uv run pytest tests/test_compose_loop.py::test_bounds_and_result_have_new_quality_fields -v`
Expected: FAIL (`AttributeError` on `asset_regen_retries`).

- [ ] **Step 3: Add the fields**

In `ComposeBounds`:

```python
@dataclass(frozen=True)
class ComposeBounds:
    """Liberal v1 defaults from the spec (§1 Bounds)."""

    look_behind: int = 3        # editable window = [K-look_behind .. K]
    max_passes: int = 3         # re-look passes per element
    regen_budget: int = 5       # hard ceiling on regenerations per build
    asset_regen_retries: int = 2    # max regenerate->re-judge cycles per asset
    max_edits_per_element: int = 4  # deterministic per-element critic-edit cap
```

In `ComposeResult`, add the field:

```python
    corrections_applied: int = 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `uv run pytest tests/test_compose_loop.py::test_bounds_and_result_have_new_quality_fields -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): add re-judge/edit-cap bounds and corrections tally"
```

---

### Task 4: Attempt-indexed asset cassettes (stateless re-judge support)

Make the replay asset critic return a verdict keyed on `request.attempt`, so a single role can return `regenerate` then `keep` across re-judge cycles — without any leak-prone internal state. A single-dict cassette still works (same verdict every attempt).

**Files:**

- Modify: `studio/backend/app/replay/cassette.py:88-107` (`load_asset_cassettes`)
- Modify: `studio/backend/app/scene/asset_critic.py` (`AssetCritiqueRequest` 39-45, `ReplayAssetCritic` 84-96)
- Test: `studio/backend/tests/test_asset_critic.py`

**Interfaces:**

- Consumes: nothing new.
- Produces: `AssetCritiqueRequest.attempt: int = 0`; `load_asset_cassettes(dir) -> dict[str, list[dict]]` (each value is now a list of verdict dicts); `ReplayAssetCritic.critique` indexes the list by `min(request.attempt, len-1)`.

- [ ] **Step 1: Write the failing tests**

Add to `studio/backend/tests/test_asset_critic.py`:

```python
async def test_replay_asset_critic_sequences_by_attempt():
    critic = ReplayAssetCritic({"logo": [
        {"ok": False, "action": "regenerate", "reason": "garbled text"},
        {"ok": True, "action": "keep", "reason": "fixed"},
    ]})
    img = _png((5, 6, 7, 255), (64, 64))  # passes heuristic => cassette decides
    first = await critic.critique(AssetCritiqueRequest(image_png=img, role="logo", attempt=0, transparent=True))
    second = await critic.critique(AssetCritiqueRequest(image_png=img, role="logo", attempt=1, transparent=True))
    assert first.action == "regenerate"
    assert second.action == "keep"


async def test_replay_asset_critic_clamps_attempt_to_last():
    critic = ReplayAssetCritic({"logo": [
        {"ok": False, "action": "regenerate", "reason": "still bad"},
    ]})
    img = _png((5, 6, 7, 255), (64, 64))
    v = await critic.critique(AssetCritiqueRequest(image_png=img, role="logo", attempt=9, transparent=True))
    assert v.action == "regenerate"  # index clamped to the single entry
```

Update the existing `test_replay_asset_critic_returns_keyed_verdict` to use a list:

```python
async def test_replay_asset_critic_returns_keyed_verdict():
    critic = ReplayAssetCritic({"reel_frame": [{"ok": False, "action": "regenerate", "reason": "empty frame"}]})
    req = AssetCritiqueRequest(image_png=_png((5, 6, 7, 255), (64, 64)), role="reel_frame", transparent=True)
    v = await critic.critique(req)
    assert v.action == "regenerate" and v.reason == "empty frame"
```

And `test_replay_asset_critic_heuristic_short_circuits_before_cassette` to a list cassette:

```python
async def test_replay_asset_critic_heuristic_short_circuits_before_cassette():
    empty = Path("tests/fixtures/empty_reel_frame.png").read_bytes()
    critic = ReplayAssetCritic({"reel_frame": [{"ok": True, "action": "keep", "reason": "fine"}]})
    req = AssetCritiqueRequest(image_png=empty, role="reel_frame", transparent=True)
    v = await critic.critique(req)
    assert v.action == "regenerate"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_asset_critic.py -k "replay_asset_critic" -v`
Expected: new attempt tests FAIL (`attempt` not a field / list not handled).

- [ ] **Step 3: Add `attempt` to the request**

In `AssetCritiqueRequest`:

```python
@dataclass(frozen=True)
class AssetCritiqueRequest:
    image_png: bytes
    role: str
    description: str = ""
    theme: str = ""
    transparent: bool = True
    attempt: int = 0
```

- [ ] **Step 4: Make `load_asset_cassettes` return lists**

Replace the body of `load_asset_cassettes` in `studio/backend/app/replay/cassette.py`:

```python
def load_asset_cassettes(fixtures_dir: Path) -> dict[str, list[dict]]:
    """Recorded per-role asset verdicts from ``tests/fixtures/replay/asset/``.

    Each file is EITHER a single verdict dict (returned for every attempt) OR a
    JSON list of verdict dicts (one per regenerate->re-judge attempt; the asset
    critic clamps the attempt index to the last entry). ``default.json`` becomes
    ``"__default__"``. Files with a ``role``/``target`` key are also keyed by
    ``normalize_prompt(role)``.
    """
    out: dict[str, list[dict]] = {}
    base = fixtures_dir / "asset"
    if not base.is_dir():
        return out
    for path in sorted(base.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            verdicts = [{k: v for k, v in d.items() if k not in ("role", "target")} for d in data]
            key = None
            for d in data:
                key = d.get("role") or d.get("target") or key
        else:
            verdicts = [{k: v for k, v in data.items() if k not in ("role", "target")}]
            key = data.get("role") or data.get("target")
        if path.name == "default.json":
            out["__default__"] = verdicts
        if key:
            out[normalize_prompt(key)] = verdicts
    return out
```

- [ ] **Step 5: Make `ReplayAssetCritic` index by attempt**

Replace `ReplayAssetCritic` in `studio/backend/app/scene/asset_critic.py`:

```python
class ReplayAssetCritic:
    """Offline asset critic: heuristic first, then a recorded verdict keyed by
    role and (statelessly) by re-judge attempt."""

    def __init__(self, cassettes: dict[str, list[dict]]):
        self._cassettes = cassettes

    async def critique(self, request: AssetCritiqueRequest) -> AssetVerdict:
        flagged = asset_heuristic(request.image_png, transparent=request.transparent)
        if flagged is not None:
            return flagged
        seq = (self._cassettes.get(normalize_prompt(request.role))
               or self._cassettes.get("__default__"))
        if not seq:
            return AssetVerdict()
        data = seq[min(request.attempt, len(seq) - 1)]
        return AssetVerdict(**data)
```

- [ ] **Step 6: Run the asset-critic + cassette suites**

Run: `uv run pytest tests/test_asset_critic.py tests/test_cassette.py -v`
(If `tests/test_cassette.py` does not exist, run just `tests/test_asset_critic.py`.)
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add studio/backend/app/replay/cassette.py studio/backend/app/scene/asset_critic.py studio/backend/tests/test_asset_critic.py
git commit -m "feat(scene): attempt-indexed asset cassettes for stateless re-judge"
```

---

### Task 5: Re-judge loop in run_compose (item 2)

Replace the one-shot asset-regenerate with a bounded `regenerate → re-judge` loop. Thread the re-judge `attempt` through `critique_asset`. Update the existing asset-gate unit tests and the existing backend e2e cassette to converge.

**Files:**

- Modify: `studio/backend/app/scene/compose_loop.py` (`ComposeDeps.critique_asset` 72; asset gate 99-115)
- Modify: `studio/backend/app/agent_tools.py:449` (`_SceneComposeDeps.critique_asset` signature)
- Modify: `studio/backend/tests/test_compose_loop.py` (`FakeDeps` + asset tests)
- Modify: `studio/backend/tests/fixtures/replay/asset/reel_frame.json` (→ list so it converges)

**Interfaces:**

- Consumes: `ComposeBounds.asset_regen_retries` (Task 3); `AssetCritiqueRequest.attempt` (Task 4).
- Produces: `ComposeDeps.critique_asset(self, target_handle: str, attempt: int = 0)`; `run_compose` runs a bounded re-judge loop drawing on the shared `regen_budget`.

- [ ] **Step 1: Update `FakeDeps` to sequence verdicts and accept `attempt`**

In `studio/backend/tests/test_compose_loop.py`, change `FakeDeps.__init__` to normalise verdicts to lists and `critique_asset` to index by attempt:

```python
    def __init__(self, script, *, capture_fail=frozenset(), asset_verdicts=None):
        self._script = script
        self._capture_fail = capture_fail
        self.placements: list[str] = []
        self.adjusts: list[tuple[str, EditParams]] = []
        self.regens: list[str] = []
        self.renders = 0
        raw = asset_verdicts or {}
        self.asset_verdicts = {
            h: (v if isinstance(v, list) else [v]) for h, v in raw.items()
        }
```

```python
    async def critique_asset(self, target_handle: str, attempt: int = 0):
        from app.scene.asset_critic import AssetVerdict
        seq = self.asset_verdicts.get(target_handle)
        if not seq:
            return AssetVerdict()
        return seq[min(attempt, len(seq) - 1)]
```

- [ ] **Step 2: Rewrite the existing asset-gate tests + add bounded tests (failing)**

Replace `test_bad_asset_is_regenerated_before_composition` and
`test_bad_asset_regenerate_respects_shared_budget` with converge/bounded versions, and add a retries-exhausted test:

```python
@pytest.mark.asyncio
async def test_bad_asset_regenerates_then_converges_on_rejudge():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"logo": [Critique(done=True)]},
        asset_verdicts={"logo": [
            AssetVerdict(ok=False, action="regenerate", reason="garbled text"),
            AssetVerdict(ok=True, action="keep", reason="fixed"),
        ]},
    )
    result = await run_compose([_el("logo")], "pirate", deps)
    assert deps.regens == ["logo"]              # regenerated exactly once
    assert result.assets_regenerated == 1
    assert any("asset ok" in n for n in result.notes)   # converged


@pytest.mark.asyncio
async def test_bad_asset_rejudge_is_bounded_by_retries():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"logo": [Critique(done=True)]},
        asset_verdicts={"logo": [AssetVerdict(ok=False, action="regenerate", reason="still bad")]},
    )  # single verdict => always regenerate
    result = await run_compose(
        [_el("logo")], "pirate", deps, ComposeBounds(asset_regen_retries=2, regen_budget=5))
    assert deps.regens == ["logo", "logo"]      # capped at asset_regen_retries
    assert result.assets_regenerated == 2
    assert any("retries exhausted" in n for n in result.notes)


@pytest.mark.asyncio
async def test_bad_asset_rejudge_respects_shared_budget():
    from app.scene.asset_critic import AssetVerdict
    deps = FakeDeps(
        {"a": [Critique(done=True)], "b": [Critique(done=True)]},
        asset_verdicts={
            "a": [AssetVerdict(ok=False, action="regenerate", reason="bad a")],
            "b": [AssetVerdict(ok=False, action="regenerate", reason="bad b")],
        },
    )
    result = await run_compose(
        [_el("a"), _el("b")], "pirate", deps, ComposeBounds(regen_budget=1))
    assert deps.regens == ["a"]                 # only the first regen is funded
    assert result.assets_regenerated == 1
    assert any("budget exhausted" in n for n in result.notes)
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `uv run pytest tests/test_compose_loop.py -k "asset" -v`
Expected: FAIL (current one-shot gate regenerates once and never re-judges; no "retries exhausted" note).

- [ ] **Step 4: Update the `ComposeDeps` protocol signature**

In `studio/backend/app/scene/compose_loop.py`:

```python
    async def critique_asset(self, target_handle: str, attempt: int = 0) -> AssetVerdict: ...
```

- [ ] **Step 5: Rewrite the asset gate in `run_compose`**

Replace the per-asset gate block (currently lines ~99-115, from the `verdict = await deps.critique_asset(target)` comment down to the end of that `else:` branch) with:

```python
        # Per-asset quality gate (before composition): regenerate degenerate art,
        # then RE-JUDGE so a regeneration converges instead of silently swapping
        # one bad asset for another. Bounded by asset_regen_retries and the shared
        # regen budget.
        verdict = await deps.critique_asset(target, attempt=0)
        attempt = 0
        while (verdict.action == "regenerate" and regen_left > 0
               and attempt < bounds.asset_regen_retries):
            regen_left -= 1
            result.regens_spent += 1
            result.assets_regenerated += 1
            await deps.regenerate(target)
            attempt += 1
            result.notes.append(
                f"{target}: {verdict.reason} -> regenerated (attempt {attempt})")
            verdict = await deps.critique_asset(target, attempt=attempt)

        if verdict.action == "regenerate":
            cause = "regen budget exhausted" if regen_left <= 0 else "retries exhausted"
            result.notes.append(
                f"{target}: {verdict.reason} (could not fix: {cause}, kept)")
        elif verdict.ok:
            result.notes.append(f"{target}: asset ok")
        else:
            result.notes.append(f"{target}: {verdict.reason}")
```

- [ ] **Step 6: Update `_SceneComposeDeps.critique_asset` to forward `attempt`**

In `studio/backend/app/agent_tools.py`, change the signature and the request build:

```python
    async def critique_asset(self, target_handle: str, attempt: int = 0):
```

and in the `AssetCritiqueRequest(...)` call at the end of that method, add `attempt=attempt`:

```python
        return await self._ctx.asset_critic.critique(AssetCritiqueRequest(
            image_png=image_png, role=role, description=description,
            theme="", transparent=transparent, attempt=attempt))
```

- [ ] **Step 7: Update the existing e2e cassette so it converges**

Replace `studio/backend/tests/fixtures/replay/asset/reel_frame.json` with a list:

```json
[
  { "role": "reel frame", "ok": false, "action": "regenerate", "reason": "reel frame reads empty for its role" },
  { "role": "reel frame", "ok": true, "action": "keep", "reason": "reel frame now reads correctly" }
]
```

- [ ] **Step 8: Run the unit suite**

Run: `uv run pytest tests/test_compose_loop.py -v`
Expected: all PASS (including the untouched render-fail, window, and place-order tests; `test_unloadable_asset_surfaces_visible_note_not_asset_ok` still green — its single `keep` verdict skips the loop).

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/scene/compose_loop.py studio/backend/app/agent_tools.py studio/backend/tests/test_compose_loop.py studio/backend/tests/fixtures/replay/asset/reel_frame.json
git commit -m "feat(scene): bounded regenerate->re-judge loop for the asset gate"
```

---

### Task 6: Critic edit history + hard convergence cap (item 3)

Give the composition critic its per-element edit history (soft pressure) and enforce a deterministic per-element edit cap in `run_compose` (hard guarantee).

**Files:**

- Modify: `studio/backend/app/scene/critic.py` (`CritiqueRequest` 53-71, `build_critic_messages` 136-166, `CRITIC_SYSTEM_PROMPT` 101-128)
- Modify: `studio/backend/app/scene/compose_loop.py` (`run_compose` composition pass loop)
- Test: `studio/backend/tests/test_scene_critic.py`, `studio/backend/tests/test_compose_loop.py`

**Interfaces:**

- Consumes: `ComposeBounds.max_edits_per_element` (Task 3).
- Produces: `CritiqueRequest.edit_history: dict[str, list[dict]]` (default `{}`); `build_critic_messages` embeds it; `run_compose` accumulates per-handle history, passes the window slice into each `CritiqueRequest`, and refuses an edit to a handle that has reached `max_edits_per_element`.

- [ ] **Step 1: Write the failing critic tests**

Add to `studio/backend/tests/test_scene_critic.py`:

```python
def test_critique_request_carries_edit_history_default_empty():
    req = CritiqueRequest(frame_png=b"", scene={}, target_handle="logo", window=["logo"])
    assert req.edit_history == {}


def test_message_builder_embeds_edit_history():
    req = CritiqueRequest(
        frame_png=b"x", scene={"nodes": []},
        target_handle="reel_frame", window=["reel_frame"],
        edit_history={"reel_frame": [{"action": "move", "params": {"y": 430}, "why": "down"}]},
    )
    text = next(
        p["text"] for p in build_critic_messages(req)[1].content if p["type"] == "text"
    )
    assert "edit_history" in text
    assert "430" in text


def test_critic_prompt_has_convergence_discipline():
    from app.scene.critic import CRITIC_SYSTEM_PROMPT
    low = CRITIC_SYSTEM_PROMPT.lower()
    assert "history" in low
    assert "undo" in low or "converge" in low
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_scene_critic.py -k "edit_history or convergence" -v`
Expected: FAIL (`edit_history` not a field; prompt lacks the words).

- [ ] **Step 3: Add the field, thread it, extend the prompt**

In `studio/backend/app/scene/critic.py`, add to `CritiqueRequest` (after `pass_index`):

```python
    edit_history: dict = field(default_factory=dict)
```

and add the import at the top of the file:

```python
from dataclasses import dataclass, field
```

In `build_critic_messages`, add `edit_history` to the `context` dict:

```python
    context = {
        "theme": request.theme,
        "just_added": request.target_handle,
        "editable_window": request.window,
        "regen_budget_left": request.regen_budget_left,
        "edit_history": request.edit_history,
        "scene": request.scene,
    }
```

Append a convergence paragraph to `CRITIC_SYSTEM_PROMPT` (inside the `"Discipline:\n"` block, before the closing `Return:` sentence):

```python
    "- CONVERGE. You are shown 'edit_history' — your prior edits to each element "
    "this build. Do NOT undo a move you already made, and do not oscillate an "
    "element back and forth. If an element has already been adjusted a few times, "
    "leave it unless it is clearly still wrong; prefer to return done=true.\n"
```

- [ ] **Step 4: Run the critic tests**

Run: `uv run pytest tests/test_scene_critic.py -v`
Expected: all PASS (existing `test_critique_request_defaults` still green — `edit_history` defaults to `{}`).

- [ ] **Step 5: Write the failing run_compose cap/history tests**

Add to `studio/backend/tests/test_compose_loop.py`:

```python
@pytest.mark.asyncio
async def test_edit_history_is_passed_to_the_critic():
    seen = {}

    class HistoryDeps(FakeDeps):
        async def critique(self, request):
            seen[request.pass_index] = dict(request.edit_history)
            return await super().critique(request)

    script = {"logo": [
        Critique(edits=[CritiqueEdit(target_handle="logo", action="move",
                                     params=EditParams(x=10, y=10), why="nudge")]),
        Critique(done=True),
    ]}
    deps = HistoryDeps(script)
    await run_compose([_el("logo")], "pirate", deps)
    assert seen[0] == {}                       # nothing applied yet on pass 0
    assert "logo" in seen[1]                    # pass 1 sees the pass-0 edit
    assert seen[1]["logo"][0]["action"] == "move"


@pytest.mark.asyncio
async def test_per_element_edit_cap_refuses_further_edits():
    forever = [Critique(edits=[CritiqueEdit(
        target_handle="logo", action="move",
        params=EditParams(x=1, y=1), why="churn")]) for _ in range(10)]
    deps = FakeDeps({"logo": forever})
    result = await run_compose(
        [_el("logo")], "pirate", deps,
        ComposeBounds(max_passes=5, max_edits_per_element=2))
    assert result.edits_applied == 2           # capped
    assert result.rejected >= 1
    assert any("edit cap" in n for n in result.notes)
```

- [ ] **Step 6: Run to verify failure**

Run: `uv run pytest tests/test_compose_loop.py -k "edit_history or edit_cap" -v`
Expected: FAIL (no history threaded; no cap).

- [ ] **Step 7: Implement history + cap in `run_compose`**

At the top of `run_compose` (after `regen_left = bounds.regen_budget`), add:

```python
    edit_history: dict[str, list[dict]] = {}
```

In the composition-pass loop, build the window-scoped history slice and pass it into the request:

```python
            window_history = {h: edit_history[h] for h in window if h in edit_history}
            critique = await deps.critique(CritiqueRequest(
                frame_png=frame, scene=scene, target_handle=target,
                window=window, theme=theme, regen_budget_left=regen_left,
                pass_index=pass_index, edit_history=window_history,
            ))
```

In the per-edit application loop, add the cap check at the very top of the `for edit in critique.edits:` body, before the window check is fine — but place it AFTER the window check so out-of-window edits are still reported as `rejected` for the window reason. Insert immediately after the existing `if edit.target_handle not in window:` block:

```python
                if len(edit_history.get(edit.target_handle, [])) >= bounds.max_edits_per_element:
                    result.rejected += 1
                    result.notes.append(
                        f"refused {edit.action} {edit.target_handle} (edit cap reached)")
                    continue
```

Then, when an edit is actually applied (in BOTH the `regenerate` branch and the `else`/transform branch, right after `result.edits_applied += 1`), record it:

```python
                edit_history.setdefault(edit.target_handle, []).append({
                    "action": edit.action,
                    "params": edit.params.model_dump(exclude_none=True),
                    "why": edit.why,
                })
```

(Place the single `edit_history.setdefault(...)` append once, immediately after `result.edits_applied += 1`, so it covers both branches.)

- [ ] **Step 8: Run the unit suite**

Run: `uv run pytest tests/test_compose_loop.py -v`
Expected: all PASS, including the pre-existing `test_respects_max_passes_when_critic_never_says_done` (its `max_edits_per_element` defaults to 4 while `max_passes=3`, so the cap never trips — 3 edits applied, unchanged).

- [ ] **Step 9: Commit**

```bash
git add studio/backend/app/scene/critic.py studio/backend/app/scene/compose_loop.py studio/backend/tests/test_scene_critic.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): critic edit history and per-element convergence cap"
```

---

### Task 7: sprite_box refactor + keep-in-frame guard (item 4)

Extract the box math so the compositor and the guard agree by construction, then add a deterministic guard that clamps off-canvas sprites at the top of each composition pass.

**Files:**

- Modify: `studio/backend/app/scene/compositor.py` (extract `sprite_box`; `composite_scene` reuses it)
- Modify: `studio/backend/app/scene/compose_loop.py` (`FrameCorrection`, `ComposeDeps.out_of_frame`, guard in the pass loop, `format_compose_summary` import note)
- Modify: `studio/backend/app/agent_tools.py` (`_SceneComposeDeps.out_of_frame`; `format_compose_summary`)
- Modify: `studio/backend/tests/test_compose_loop.py` (`FakeDeps.out_of_frame`)
- Test: `studio/backend/tests/test_compositor.py`, `studio/backend/tests/test_compose_loop.py`

**Interfaces:**

- Consumes: `ComposeResult.corrections_applied` (Task 3); `EditParams` (existing).
- Produces: `compositor.sprite_box(props: dict, sprite_size: tuple[int,int], canvas: tuple[int,int]) -> tuple[int,int,int,int]` returning `(left, top, width, height)`; `compose_loop.FrameCorrection(handle: str, x: float, y: float, reason: str)`; `ComposeDeps.out_of_frame(self) -> list[FrameCorrection]`; `format_compose_summary` reports the correction count.

- [ ] **Step 1: Write the failing compositor test**

Add to `studio/backend/tests/test_compositor.py`:

```python
from app.scene.compositor import sprite_box


def test_sprite_box_anchors_and_scales():
    # 40x40 sprite, anchor centre, scale 2 => 80x80, centred at (150,50)
    props = {"position": {"x": 150, "y": 50}, "anchor": {"x": 0.5, "y": 0.5},
             "scale": {"x": 2.0, "y": 2.0}}
    assert sprite_box(props, (40, 40), (200, 100)) == (110, 10, 80, 80)


def test_sprite_box_top_left_anchor():
    props = {"position": {"x": 10, "y": 20}, "anchor": {"x": 0.0, "y": 0.0},
             "scale": {"x": 1.0, "y": 1.0}}
    assert sprite_box(props, (30, 30), (200, 100)) == (10, 20, 30, 30)
```

- [ ] **Step 2: Run to verify failure**

Run: `uv run pytest tests/test_compositor.py::test_sprite_box_anchors_and_scales -v`
Expected: FAIL (`ImportError: cannot import name 'sprite_box'`).

- [ ] **Step 3: Extract `sprite_box`; reuse it in `composite_scene`**

In `studio/backend/app/scene/compositor.py`, add:

```python
def sprite_box(
    props: dict, sprite_size: tuple[int, int], canvas: tuple[int, int]
) -> tuple[int, int, int, int]:
    """(left, top, width, height) of a sprite in canvas pixels — the single source
    of box math for both the compositor and the keep-in-frame guard."""
    sw, sh = sprite_size
    cw, ch = canvas
    scale = props.get("scale") or {}
    sx = float(scale.get("x", 1.0))
    sy = float(scale.get("y", 1.0))
    rw = max(1, round(sw * sx))
    rh = max(1, round(sh * sy))
    anchor = props.get("anchor") or {}
    ax = float(anchor.get("x", 0.5))
    ay = float(anchor.get("y", 0.5))
    pos = props.get("position") or {}
    px = float(pos.get("x", cw / 2))
    py = float(pos.get("y", ch / 2))
    return (round(px - ax * rw), round(py - ay * rh), rw, rh)
```

In `composite_scene`, replace the inline box math (the `scale`/`rw`/`rh`/`anchor`/`pos`/`tlx`/`tly` block, lines ~93-108) with:

```python
        props = n.get("props") or {}
        tlx, tly, rw, rh = sprite_box(props, (sprite.width, sprite.height), (cw, ch))
        if (rw, rh) != (sprite.width, sprite.height):
            sprite = sprite.resize((rw, rh))
```

(Keep the existing `layer`/`paste`/`alpha_composite` lines that follow.)

- [ ] **Step 4: Run the compositor suite (goldens unchanged)**

Run: `uv run pytest tests/test_compositor.py -v`
Expected: all PASS — the new `sprite_box` tests and the existing golden tests (`test_composite_places_sprites_by_anchor_and_zorder`, `test_composite_applies_scale`, etc.).

- [ ] **Step 5: Add `FrameCorrection`, the protocol method, and the `FakeDeps` no-op**

In `studio/backend/app/scene/compose_loop.py`, add a model near `BuildElement`:

```python
class FrameCorrection(BaseModel):
    """A deterministic clamp that brings an off-canvas sprite back in frame."""

    handle: str
    x: float
    y: float
    reason: str
```

Add to the `ComposeDeps` Protocol:

```python
    async def out_of_frame(self) -> list[FrameCorrection]: ...
```

In `studio/backend/tests/test_compose_loop.py`, add a default no-op to `FakeDeps` (so existing tests are unaffected):

```python
    async def out_of_frame(self):
        return list(getattr(self, "corrections", []))
```

and initialise `self.corrections = []` in `FakeDeps.__init__` (callers can set a scripted list).

- [ ] **Step 6: Write the failing guard test**

Add to `studio/backend/tests/test_compose_loop.py`:

```python
@pytest.mark.asyncio
async def test_in_frame_guard_clamps_and_counts_separately():
    from app.scene.compose_loop import FrameCorrection
    deps = FakeDeps({"logo": [Critique(done=True)]})
    deps.corrections = [FrameCorrection(handle="logo", x=600, y=340,
                                        reason="logo spilled off the right edge")]
    result = await run_compose(
        [_el("logo")], "pirate", deps, ComposeBounds(max_edits_per_element=0))
    # applied via adjust, counted as a correction, NOT as a critic edit
    assert ("logo", EditParams(x=600, y=340)) in deps.adjusts
    assert result.corrections_applied == 1
    assert result.edits_applied == 0
    assert any("into frame" in n for n in result.notes)
```

(`max_edits_per_element=0` proves corrections bypass the edit cap entirely.)

- [ ] **Step 7: Run to verify failure**

Run: `uv run pytest tests/test_compose_loop.py::test_in_frame_guard_clamps_and_counts_separately -v`
Expected: FAIL (no guard call yet; `corrections_applied` stays 0).

- [ ] **Step 8: Apply the guard at the top of each composition pass**

In `run_compose`, inside `for pass_index in range(bounds.max_passes):`, BEFORE the `try: frame = await deps.render_scene()` block, add:

```python
            for corr in await deps.out_of_frame():
                if corr.handle in window:
                    await deps.adjust(corr.handle, EditParams(x=corr.x, y=corr.y))
                    result.corrections_applied += 1
                    result.notes.append(f"{corr.handle}: {corr.reason}, nudged into frame")
```

- [ ] **Step 9: Run the unit suite**

Run: `uv run pytest tests/test_compose_loop.py -v`
Expected: all PASS (existing tests have empty `corrections`, so no extra adjusts).

- [ ] **Step 10: Implement the real `out_of_frame` and surface corrections in the summary**

In `studio/backend/app/agent_tools.py`, import `FrameCorrection` and `sprite_box`:

```python
from app.scene.compose_loop import BuildElement, FrameCorrection, run_compose
from app.scene.compositor import collect_scene_images, composite_scene, sprite_box
```

(Adjust the existing import lines rather than duplicating — `BuildElement`/`run_compose` and `collect_scene_images`/`composite_scene` are already imported; add the new names.)

Add the method to `_SceneComposeDeps` (after `render_scene`):

```python
    async def out_of_frame(self) -> list[FrameCorrection]:
        document = await self._ctx.scene_store.get_document(self._ctx.game_id)
        if not document:
            return []
        media_dir = get_settings().media_dir
        images = collect_scene_images(document, media_dir)
        nodes = document.get("nodes") or {}
        root = next((n for n in nodes.values() if n.get("type") == "Root"), None)
        rp = (root or {}).get("props") or {}
        cw = int(rp.get("width", 1280) or 1280)
        ch = int(rp.get("height", 720) or 720)
        out: list[FrameCorrection] = []
        for nid, n in nodes.items():
            if n.get("type") != "Sprite":
                continue
            tex_id = _texture_of(document, nid)
            if tex_id is None or tex_id not in images:
                continue
            try:
                from io import BytesIO
                from PIL import Image
                im = Image.open(BytesIO(images[tex_id]))
                sw, sh = im.width, im.height
            except Exception:
                continue
            props = n.get("props") or {}
            tlx, tly, rw, rh = sprite_box(props, (sw, sh), (cw, ch))
            ntlx = min(max(tlx, 0), max(0, cw - rw))
            ntly = min(max(tly, 0), max(0, ch - rh))
            if (ntlx, ntly) == (tlx, tly):
                continue
            anchor = props.get("anchor") or {}
            ax = float(anchor.get("x", 0.5))
            ay = float(anchor.get("y", 0.5))
            handle = nid[len("spr."):] if nid.startswith("spr.") else nid
            out.append(FrameCorrection(
                handle=handle, x=ntlx + ax * rw, y=ntly + ay * rh,
                reason="spilled off the canvas edge"))
        return out
```

Update `format_compose_summary` head (in `agent_tools.py`) to include corrections:

```python
def format_compose_summary(result) -> str:
    head = (f"Composed {result.elements_placed} element(s) over "
            f"{result.passes} critique pass(es): {result.edits_applied} edit(s) "
            f"applied, {result.regens_spent} regeneration(s) "
            f"({result.assets_regenerated} asset regeneration(s)), "
            f"{result.corrections_applied} in-frame correction(s), "
            f"{result.rejected} edit(s) refused.")
    body = "\n".join(f"- {n}" for n in result.notes)
    return head + ("\n" + body if body else "")
```

- [ ] **Step 11: Run the compose-scene-tool + loop + compositor suites**

Run: `uv run pytest tests/test_compose_loop.py tests/test_compositor.py tests/test_compose_scene_tool.py -v`
Expected: all PASS. (If `test_compose_scene_tool.py` asserts on the old summary string, update that assertion to include the new "in-frame correction(s)" segment.)

- [ ] **Step 12: Commit**

```bash
git add studio/backend/app/scene/compositor.py studio/backend/app/scene/compose_loop.py studio/backend/app/agent_tools.py studio/backend/tests/test_compositor.py studio/backend/tests/test_compose_loop.py
git commit -m "feat(scene): keep-in-frame guard clamps off-canvas sprites"
```

---

### Task 8: Authoritative backend replay e2e — text-converge + in-frame correction

A real compose run (no fakes in the path) proving the new guards fire end-to-end: a garbled-text logo regenerates-and-converges, and an off-canvas element is pulled back in. This is the gate that catches a silently-broken guard.

**Files:**

- Create: `studio/backend/tests/fixtures/replay/run/compose-quality-guards.json`
- Create: `studio/backend/tests/fixtures/replay/asset/logo.json`
- Create: `studio/backend/tests/e2e/test_compose_quality_guards.py`
- (Reuse: `asset/default.json` keep, `critic/default.json` done.)

**Interfaces:**

- Consumes: the full stack from Tasks 1-7 (attempt-indexed cassettes, re-judge loop, in-frame guard, summary fields).
- Produces: an `@pytest.mark.e2e` test asserting the run completes and the summary/doc reflect convergence + correction.

- [ ] **Step 1: Add the asset cassette for the garbled logo**

Create `studio/backend/tests/fixtures/replay/asset/logo.json` (regenerate once, then converge — exercises items 1 + 2):

```json
[
  { "role": "logo", "ok": false, "action": "regenerate", "reason": "wordmark text is garbled" },
  { "role": "logo", "ok": true, "action": "keep", "reason": "wordmark now reads correctly" }
]
```

- [ ] **Step 2: Add the run cassette**

Create `studio/backend/tests/fixtures/replay/run/compose-quality-guards.json`. The `credits` element is placed in the bottom-right CORNER so its composited box (the shared replay PNG is large) spills past the right and bottom edges, forcing the in-frame guard:

```json
{
  "prompt": "build a pirate slot: a background, a logo at the top, and a credits bar, then tidy it",
  "tool_call_rounds": [
    [
      {
        "name": "compose_scene",
        "args": {
          "theme": "pirate slot",
          "elements": [
            {
              "description": "a pirate cove background, full scene, no text",
              "slot": "background",
              "size": "1280x720",
              "transparent": false,
              "role": "background",
              "fit": "cover",
              "z_index": 0
            },
            {
              "description": "an ornate PIRATE FORTUNE logo wordmark, transparent cutout",
              "slot": "logo",
              "size": "512x256",
              "transparent": true,
              "role": "logo",
              "x": 640,
              "y": 90,
              "z_index": 10
            },
            {
              "description": "a credits bar, transparent cutout",
              "slot": "credits",
              "size": "400x100",
              "transparent": true,
              "role": "credits",
              "x": 1280,
              "y": 720,
              "z_index": 8
            }
          ]
        }
      }
    ]
  ],
  "final": ["Built the scene, fixed the garbled logo, and pulled the credits bar back into frame."]
}
```

- [ ] **Step 3: Write the e2e test**

Create `studio/backend/tests/e2e/test_compose_quality_guards.py` (mirrors `test_compose_critique.py`):

```python
"""Authoritative backend replay e2e for the compose quality guards (#item1-4 slice).

Proves end-to-end, with the real backend compositor and critics (no fakes):
  - a garbled-text logo is regenerated and converges (items 1 + 2)
  - an off-canvas credits bar is clamped back into frame (item 4)
"""
import asyncio

import httpx
import pytest
import socketio

PROMPT = (
    "build a pirate slot: a background, a logo at the top, and a credits bar, "
    "then tidy it"
)


async def _make_room(base_url: str) -> tuple[str, str]:
    async with httpx.AsyncClient(base_url=base_url) as http:
        room = (await http.post("/rooms", json={"name": "Quality Guards E2E"})).json()
    return room["id"], room["gameId"]


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_quality_guards_converge_and_keep_in_frame(live_server):
    room_id, game_id = await _make_room(live_server)

    client = socketio.AsyncClient()
    run_completions: list[dict] = []
    scene_snapshots: list[dict] = []
    client.on("run_completed", lambda d: run_completions.append(d))
    client.on("scene_snapshot", lambda d: scene_snapshots.append(d))

    await client.connect(live_server, auth={"displayName": "Designer"})
    await client.emit("join_room", {"roomId": room_id})
    await client.emit("join_scene", {"gameId": game_id})
    await asyncio.sleep(0.3)
    await client.emit("send_prompt", {"roomId": room_id, "text": PROMPT})

    deadline = asyncio.get_running_loop().time() + 60
    while not run_completions and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert run_completions, "run_completed not received within 60 s"
    assert run_completions[0]["status"] == "completed", run_completions

    async with httpx.AsyncClient(base_url=live_server) as http:
        runs = (await http.get(f"/rooms/{room_id}/runs")).json()
    summary = ""
    for run in runs:
        for step in run.get("steps", []):
            if step.get("toolName") == "compose_scene" and step.get("type") == "tool_result":
                summary = step.get("content", "")
    assert summary, f"no compose_scene tool_result found: {runs}"

    # item 2: the garbled logo regenerated and converged (1 asset regeneration).
    assert "asset regeneration(s)" in summary
    assert "1 asset regeneration(s)" in summary, summary
    assert "regenerated (attempt 1)" in summary, summary
    # converged, not "could not fix"
    assert "could not fix" not in summary, summary

    # item 4: the off-canvas credits bar was pulled back in.
    assert "in-frame correction(s)" in summary
    assert "0 in-frame correction(s)" not in summary, summary
    assert "into frame" in summary, summary

    # The credits sprite's final anchored position sits inside the 1280x720 canvas.
    scene_snapshots.clear()
    await client.emit("join_scene", {"gameId": game_id})
    deadline = asyncio.get_running_loop().time() + 5
    while not scene_snapshots and asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0.05)
    assert scene_snapshots, "scene_snapshot not received after re-join"
    nodes = scene_snapshots[-1]["document"]["nodes"]
    assert "spr.credits" in nodes, list(nodes)
    pos = nodes["spr.credits"]["props"]["position"]
    assert pos["x"] < 1280 and pos["y"] < 720, pos  # moved off the corner, into frame

    await client.disconnect()
```

- [ ] **Step 4: Run the new e2e (replay backend must be up)**

In one shell, from `studio/backend`, start the replay backend on this worktree's offset:
Run: `just backend-serve-replay` (the justfile derives port 8002 from `BLOOM_PORT_OFFSET=2`).
In another shell, from `studio/backend`:
Run: `uv run pytest tests/e2e/test_compose_quality_guards.py -v`
Expected: PASS. If `live_server` fixture auto-starts the server, the manual start is unnecessary — follow the existing `tests/e2e/conftest.py` convention used by `test_compose_critique.py`.

- [ ] **Step 5: Re-run the existing compose-critique e2e (no regression)**

Run: `uv run pytest tests/e2e/test_compose_critique.py -v`
Expected: PASS — the reel_frame cassette now converges to keep after one regeneration, so "1 asset regeneration(s)" still holds and the scale=0.8 transform still lands.

- [ ] **Step 6: Commit**

```bash
git add studio/backend/tests/fixtures/replay/run/compose-quality-guards.json studio/backend/tests/fixtures/replay/asset/logo.json studio/backend/tests/e2e/test_compose_quality_guards.py
git commit -m "test(scene): e2e for text-converge and keep-in-frame guards"
```

---

## Final verification (run after all tasks)

- [ ] **Full backend unit suite**

Run (from `studio/backend`): `uv run pytest -m "not e2e" -q`
Expected: all PASS.

- [ ] **Backend e2e suite (replay backend up on :8002)**

Run: `uv run pytest -m e2e -q`
Expected: all PASS, including both compose e2e specs.

- [ ] **Prettier / format gate (if the spec/plan markdown is staged)**

Run (from repo root): `node_modules/.bin/prettier --check "studio/backend/**/*.json" "docs/**/*.md"`
Expected: no diff (pinned prettier — do NOT use `npx`).

---

## Self-Review

**1. Spec coverage**

- Item 1 (text legibility) → Task 1 (prompt) + Task 8 (e2e convergence). ✅
- Item 2 (re-judge) → Task 4 (cassette seam) + Task 5 (loop) + Task 8 (e2e). ✅
- Item 3 (oscillation) → Task 6 (history + cap). ✅
- Item 4 (keep-in-frame) → Task 7 (sprite_box + guard) + Task 8 (e2e). ✅
- Item 5 (transparency integrity) → Task 1 (vision) + Task 2 (heuristic). ✅
- `ComposeBounds` knobs (`asset_regen_retries`, `max_edits_per_element`), `corrections_applied` → Task 3. ✅
- Shared regen budget, stateless replay critic, corrections-not-counted-in-cap → enforced in Tasks 4-7 and Global Constraints. ✅
- Whole-scene polish pass → out of scope (spec non-goal); no task, intentional. ✅

**2. Placeholder scan** — every step has concrete code/commands; no TBD/TODO. ✅

**3. Type consistency** — `critique_asset(target_handle, attempt=0)` matches across Protocol (Task 5), `FakeDeps` (Task 5), and `_SceneComposeDeps` (Task 5). `AssetCritiqueRequest.attempt` (Task 4) consumed in Task 5. `load_asset_cassettes -> dict[str, list[dict]]` (Task 4) consumed by `ReplayAssetCritic` (Task 4). `sprite_box` signature (Task 7) consumed by `composite_scene` and `_SceneComposeDeps.out_of_frame` (Task 7). `FrameCorrection(handle, x, y, reason)` produced in Task 7, scripted in the Task 7 test. `CritiqueRequest.edit_history` (Task 6) consumed by `build_critic_messages` and `run_compose` (Task 6). ✅

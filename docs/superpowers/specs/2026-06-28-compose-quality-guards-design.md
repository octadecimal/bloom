# Compose quality guards — text, re-judge, oscillation, in-frame, transparency

**Status:** design (approved direction, pending spec review)
**Date:** 2026-06-28
**Builds on:** `2026-06-28-compose-critique-rework-design.md` (the per-asset quality +
backend-composite rework, merged as #120). This slice hardens that loop with five
targeted guards surfaced by real 10–11 element builds.

## Problem

The compose loop from #120 (`compose_scene` → `run_compose`: place → per-asset
quality critic → backend Pillow composite → composition critic → edits) works, but
two live builds (a pirate slot and an Egyptian slot, ~28–29 critique passes and
~73–79 edits each, 2 asset regenerations apiece) exposed five quality gaps:

1. **Garbled text passes as "asset ok."** The per-asset critic approved logos with
   misspelled/duplicated wordmarks ("PIRATE FORTUNEE"; "PHAARAOH'S RIICHES"). The
   asset-critic vision prompt (`ASSET_SYSTEM_PROMPT`) never checks text.
2. **A regenerated asset is never re-judged.** The per-asset gate regenerates a bad
   asset exactly **once** and never re-critiques it, so it can regenerate into
   another bad asset and pass silently. A reel frame was correctly caught ("needs
   transparent cutouts") but its regenerated replacement was still flat/unusable.
3. **The composition critic oscillates.** It re-edits the same element ~5× across
   passes, undoing its own moves (a reel frame walked y=400→430→390→up→down). It
   never sees its prior edits for an element, so it has no convergence pressure.
4. **Elements clip off the canvas edge.** A credits bar landed half off the bottom.
   The compositor already knows each sprite's rendered box, but nothing checks it
   against the canvas bounds.
5. **Strange transparency over solids.** Generated "transparent" assets sometimes
   come back with a **semi-transparent (ghosted) solid subject**, or with
   **transparency holes** punched through areas that should be opaque, so the
   background bleeds through when composited. The asset critic has an *empty*-cutout
   heuristic but nothing for this inverse failure.

These are all element-quality / convergence problems. None of them is about the
critique architecture (that landed in #120); each extends one existing seam.

## Goals

- The per-asset critic **reads text** and rejects garbled/illegible wordmarks.
- A regenerated asset is **re-judged** so regeneration converges instead of silently
  swapping one bad asset for another.
- The composition critic **sees its own per-element edit history** and is **hard-
  capped** so it converges instead of churning.
- Elements that **spill past the canvas** are deterministically pulled back in, with
  a visible note, before the critic grades the frame.
- **Ghosted / hole-punched** transparent assets are caught — egregious cases by a
  cheap deterministic guard, subtle ones by the vision critic.
- Every new judgment is **visible** in the `compose_scene` result notes and **fully
  tested** (unit + backend replay e2e), per the repo's "the part that failed last
  time" discipline.

## Non-goals

- The **whole-scene global polish pass** (stepping back from the look-behind window
  to rebalance the entire composite for reel dominance / left-right weight). That is
  a separate, larger slice with its own spec (item 5 of the backlog) — explicitly
  deferred here.
- OCR or a text-rendering engine. Text legibility (item 1) is a **vision-prompt**
  judgment, not a deterministic check.
- New seams or a rewiring of the loop. Every change extends an existing module
  (`asset_critic.py`, `critic.py`, `compose_loop.py`) plus a small pure refactor in
  `compositor.py`. No new Protocol is introduced except one additive `ComposeDeps`
  method for the in-frame guard.

## Design

All five items land in one coherent slice. New tunables become `ComposeBounds`
fields (greppable / unit-tunable), matching the existing `look_behind` / `max_passes`
/ `regen_budget` convention.

`ComposeBounds` after this slice:

```
look_behind        = 3   # unchanged
max_passes         = 3   # unchanged
regen_budget       = 5   # unchanged — the ONE shared regeneration budget
asset_regen_retries = 2  # NEW (item 2): max regenerate→re-judge cycles per asset
max_edits_per_element = 4 # NEW (item 3): deterministic per-element critic-edit cap
```

### Item 1 — Text legibility (asset critic vision prompt)

Extend `ASSET_SYSTEM_PROMPT` only. When an asset carries text — a logo wordmark, a
UI label, a button caption — the critic must **read** it and return
`action="regenerate"` if the text is misspelled, garbled, duplicated, or illegible,
**even when the art is otherwise good**. No heuristic / OCR: `asset_heuristic` is
untouched; this is a pure vision-stage judgment. A garbled wordmark now returns
`regenerate`, which flows through the item-2 re-judge loop and converges.

Test surface: a unit guard asserting the prompt contains the text-check language,
plus a `ReplayAssetCritic` cassette keyed to a garbled-wordmark role returning
`regenerate`.

### Item 2 — Re-critique after regenerate (`run_compose` asset gate)

Replace the one-shot regenerate (`compose_loop.py:99–115`) with a bounded
`regenerate → re-critique` loop:

```
verdict = await deps.critique_asset(target)
attempts = 0
while verdict.action == "regenerate" and regen_left > 0 \
        and attempts < bounds.asset_regen_retries:
    regen_left -= 1; result.regens_spent += 1; result.assets_regenerated += 1
    await deps.regenerate(target)
    result.notes.append(f"{target}: {verdict.reason} -> regenerated (attempt {attempts+1})")
    verdict = await deps.critique_asset(target)   # RE-JUDGE
    attempts += 1
# settle: ok, or kept-with-reason, or could-not-fix
```

- `asset_regen_retries` (default **2**) caps the cycles per asset; all regenerations
  draw down the single shared `regen_budget`, so a runaway build is impossible.
- If the asset is still `regenerate` when retries or budget exhaust, it is **kept**
  with a visible note distinguishing the cause (`"… could not fix: retries
  exhausted, kept"` vs `"… regen budget exhausted, kept"`).
- **Scope:** this re-judge loop covers the **per-asset gate** only. The composition
  critic's own `regenerate` edits stay single-shot — they are rarer and already
  budget-bounded, and re-judging them would entangle the asset and composition
  judgments. (Recorded as a deliberate boundary, not an oversight.)

### Item 3 — Critic convergence: history + hard cap (`critic.py` + `run_compose`)

Two complementary mechanisms:

**Soft — edit history into the critic.** Add an additive field to `CritiqueRequest`:

```
edit_history: dict[str, list[dict]]   # handle -> [{action, params, why}, ...]
```

`run_compose` accumulates, per build, the edits it has applied per handle and passes
the window-scoped slice into each `CritiqueRequest`. `build_critic_messages` threads
it into the JSON context (`"edit_history": …`), and `CRITIC_SYSTEM_PROMPT` gains a
**convergence-discipline** paragraph: *you are shown your prior edits to each
element; do not undo a move you already made; if an element has been adjusted
several times, leave it unless it is clearly wrong; prefer to declare `done`.* The
`ReplaySceneCritic` ignores the new field (it keys on target + `pass_index`), so
cassette-based tests stay deterministic.

**Hard — per-element edit cap.** `run_compose` tracks the count of applied critic
edits per handle. Before applying an edit, if that handle has already reached
`max_edits_per_element` (default **4**), the edit is **refused** with a note
(`"refused {action} {handle} (edit cap reached)"`) and `result.rejected` is
incremented. This guarantees convergence even if the model ignores its history.

The in-frame corrections from item 4 are geometric truth and **do not** count
against this cap (tracked separately — see item 4).

### Item 4 — Keep-in-frame guard (`compositor.py` + `run_compose`)

**Refactor (parity by construction).** Factor the per-sprite box math currently
inline in `composite_scene` (`tlx, tly, rw, rh` from `position`/`anchor`/`scale`)
into a shared pure helper:

```
def sprite_box(props, sprite_size, canvas) -> tuple[int, int, int, int]:
    """(left, top, width, height) of a sprite in canvas pixels."""
```

`composite_scene` calls it (no behaviour change — covered by existing golden tests),
and the guard calls the *same* helper, so the renderer and the guard can never
disagree about where a sprite sits.

**Guard.** Add one additive method to the `ComposeDeps` Protocol:

```
async def out_of_frame(self) -> list[FrameCorrection]: ...
# FrameCorrection(handle: str, x: float, y: float, reason: str)
```

The real impl (`_SceneComposeDeps`) loads the document + texture image sizes (already
available via `collect_scene_images`), computes each sprite's box with `sprite_box`,
and for any box that spills past the canvas returns a **clamped** `(x, y)` that
brings the box fully inside (preserving anchor/scale; only translating). The fake
deps in unit tests return a scripted list.

**Wiring.** At the **top of each composition pass** (before `render_scene` /
`critique`), `run_compose` calls `out_of_frame()` and applies each correction via
`deps.adjust(handle, EditParams(x=…, y=…))`, recording a note (`"{handle} spilled
off {edge}, nudged in"`). Because corrections only fire while a box is actually
out of frame, they self-terminate (once in-frame, nothing to correct) and cannot
oscillate. They tally in a new `ComposeResult.corrections_applied` and do **not**
count toward `max_edits_per_element`. The critic therefore always grades an
in-frame composite.

### Item 5 — Transparency integrity (asset critic: conservative heuristic + vision)

The inverse of the existing empty-cutout check. Two layers, mirroring the
empty/flat-plus-vision pattern already in `asset_critic.py`.

**Conservative deterministic guard** in `asset_heuristic` (transparent assets only),
tuned for **near-zero false positives** so legitimately translucent art (glass,
smoke, glow, soft shadows) is *not* flagged. It fires only on egregious, unambiguous
cases:

- **Ghosted solid:** among *visible* pixels (alpha > `_ALPHA_VISIBLE`), the fraction
  with **partial** alpha (`_ALPHA_VISIBLE < a < SOLID_ALPHA`, e.g. `SOLID_ALPHA=240`)
  is very high (≥ `MAX_PARTIAL_ALPHA_FRACTION`, e.g. **0.85**) **and** there is no
  substantial fully-opaque core (fully-opaque fraction < `MIN_OPAQUE_CORE`, e.g.
  **0.05**). I.e. the whole subject is see-through, with nothing solid anywhere —
  which a real translucent-FX asset (which still has opaque highlights/cores) won't
  trip.
- **Hole-punched solid:** a large **fully-transparent region enclosed by opaque
  pixels** (interior holes), detected by flood-filling transparency inward from the
  image border and counting transparent pixels **not** reached from the edge; flag
  when that interior-transparent fraction exceeds `MAX_INTERIOR_HOLE_FRACTION` (e.g.
  **0.04** of the frame). A normal cutout's transparency is all edge-connected
  surround, so its interior-hole fraction is ~0.

Both return `AssetVerdict(ok=False, action="regenerate", reason=…)` with a specific
reason ("solid subject is see-through"; "holes punched in solid area"). All
thresholds are module constants alongside `MIN_ALPHA_COVERAGE` / `MIN_OPAQUE_ENTROPY`.

**Vision check** for the subtler ghosting the heuristic deliberately won't touch:
extend `ASSET_SYSTEM_PROMPT` to flag a solid object that reads as semi-transparent /
ghostly / see-through where it should be opaque, returning `regenerate`.

## What changes, by file

- `app/scene/asset_critic.py` — extend `ASSET_SYSTEM_PROMPT` (items 1 + 5 vision);
  extend `asset_heuristic` with the conservative transparency-integrity guard (item
  5); new threshold constants.
- `app/scene/critic.py` — add `edit_history` to `CritiqueRequest`; thread it through
  `build_critic_messages`; add the convergence paragraph to `CRITIC_SYSTEM_PROMPT`.
- `app/scene/compositor.py` — extract `sprite_box`; `composite_scene` reuses it.
- `app/scene/compose_loop.py` — `asset_regen_retries` + `max_edits_per_element` on
  `ComposeBounds`; `corrections_applied` on `ComposeResult`; the re-judge loop (item
  2); per-element edit-history accumulation + cap (item 3); the in-frame guard call
  at the top of each pass (item 4); `out_of_frame` + `FrameCorrection` on the
  `ComposeDeps` Protocol.
- `app/agent_tools.py` — implement `_SceneComposeDeps.out_of_frame()` using
  `collect_scene_images` + `sprite_box`.

## Testing (the part that failed last time)

Unit (TDD, RED→GREEN→REFACTOR):

- **`asset_critic`** — prompt guard asserts the text-check and ghosted-solid language
  is present; `asset_heuristic` golden tests: a ghosted-solid fixture → regenerate, a
  hole-punched fixture → regenerate, **and negative fixtures** (a legit translucent
  glow/smoke asset, a clean cutout) → `None` (no false positive). A garbled-wordmark
  cassette → regenerate via `ReplayAssetCritic`.
- **`compositor`** — golden test for `sprite_box` (a sprite positioned to spill off
  each edge → expected box) and that `composite_scene` is unchanged (existing goldens
  still pass).
- **`run_compose`** (extends the existing fake-deps suite) — (a) re-judge converges
  (fake critic: regenerate then keep → `assets_regenerated`≥1, settles ok); (b)
  re-judge bounded (stays bad → stops at `asset_regen_retries`, budget respected, kept
  with the right note); (c) oscillation cap (fake critic keeps editing one handle →
  refused after `max_edits_per_element`, `edit_history` populated in the request); (d)
  in-frame guard (fake `out_of_frame` returns a correction → applied via `adjust`,
  noted, counted in `corrections_applied`, not in the edit cap).

Backend replay e2e (authoritative — no fakes in the path):

- Extend the real compose run so a **garbled-text** asset and a **ghosted/empty**
  asset each regenerate-and-converge (assert `assets_regenerated` and that the final
  verdict is ok / kept), and an **off-canvas** element gets pulled in (assert
  `corrections_applied > 0` and the final box is within the canvas). This is the gate
  that proves the guards actually run.
- Keep one **browser e2e** proving the build still renders live; it does not carry
  the new contracts (those live in the backend tier).

## Open decisions for the plan

1. **Transparency thresholds (item 5):** confirm starting values — `SOLID_ALPHA=240`,
   `MAX_PARTIAL_ALPHA_FRACTION=0.85`, `MIN_OPAQUE_CORE=0.05`,
   `MAX_INTERIOR_HOLE_FRACTION=0.04` — and back each with a fixture. Tune against the
   real ghosted/holed assets from the two live builds if recoverable.
2. **Interior-hole detection cost:** the flood-fill from the border is O(pixels) per
   transparent asset. Confirm it is acceptable inline (assets are ≤512×512 here) vs.
   a downscaled mask for the flood-fill.
3. **Edit-cap counting:** does a refused-edit (outside window, or budget) count toward
   `max_edits_per_element`? Leaning **no** — only *applied* critic edits count, so the
   cap measures real churn, not rejected attempts.
4. **`edit_history` window scope:** pass history for the whole build, or only the
   current look-behind window? Leaning **window-scoped** (the critic can only edit the
   window anyway, so unrelated history is noise).
5. **In-frame guard timing:** top-of-each-pass (chosen) vs. also once immediately
   after `place`. Leaning **top-of-pass only** — the first pass runs right after place,
   so it already covers the just-placed element; a second call is redundant.

## Self-review checklist (for the spec author)

- No implicit TBDs — remaining tuning choices are enumerated in Open decisions, not
  hidden.
- Internally consistent: one shared `regen_budget`; corrections excluded from the
  oscillation cap in every place they're mentioned; `sprite_box` is the single source
  of box math for both renderer and guard.
- Scoped to one implementation plan: five guards over four existing modules + one
  additive deps method + tests. Coherent (all element-quality/convergence) and not
  splittable into independently-shippable halves without re-touching the same files.
- The whole-scene polish pass is explicitly a **separate** later slice (non-goal).

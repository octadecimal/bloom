# Composition critique rework — per-asset quality + backend scene composite

**Status:** design (approved direction, pending spec review)
**Date:** 2026-06-28
**Supersedes the capture-dependent critique path of:** `2026-06-27-vision-in-the-loop-scene-composition-design.md` (Plans 1–4, merged through #119)

## Problem

The compose loop shipped in #119 (`compose_scene` → `run_compose`) is supposed to
catch a bad element — an empty/cut-off/poor asset, or one that lands wrong in the
scene — and fix it (regenerate or transform) before moving on. In real use it
does **nothing of the kind**, and silently.

Observed in a live build ("a background, a logo, a reel frame"):

- The generated reel-frame asset was a **7.6 KB near-empty PNG** and was never
  caught.
- The `compose_scene` tool result read: `Composed 3 element(s) over **0 critique
pass(es)**` — every element logged `no frame, skipped critique`.
- No feedback in chat that the AI judged anything.

### Root causes (confirmed by investigation)

1. **The critic never runs.** `run_compose` asks for a rendered frame via the
   Plan 3 `SceneCaptureBroker` (`ComposeDeps.capture()` →
   `request_capture(game_id)` over Socket.IO → studio → engine iframe → back). A
   live probe proved the **engine capture itself works** (returned a 538 KB PNG,
   no error, no hang) — so the failure is not taint, not `requestAnimationFrame`,
   not Pixi `extract`. The failure is that the round-trip only succeeds if, at the
   instant of each capture, the user has the Game Scene pane **open, the engine
   booted (`ready`), actively painting, and the game active**. During a real build
   that condition isn't reliably met, so every capture times out and the loop's
   best-effort fallback (decision 3 of the prior design) skips the critique.
2. **The critique is silently skipped.** "Best-effort capture" degrades to plain
   placement with no visible signal — identical to pre-#119 behaviour.
3. **No visibility.** Per-pass progress was deliberately not surfaced as run-feed
   steps (decision 2 of the prior design), so even a working loop is invisible.
4. **Only one kind of judgment.** The loop only ever judged the whole composed
   frame. There is no per-asset quality check, so an empty/cut-off asset isn't
   caught on its own merits.
5. **Untestable, so it shipped broken.** The backend e2e used a _fake_ capture
   responder and the browser e2e never asserted `passes > 0`, so a loop that did
   nothing passed every gate.

## Goals

- The critic **runs reliably and headlessly** — no dependency on a live, focused
  browser pane; works in agent-only flows.
- **Catch bad individual assets** (empty, cut off, low quality, off-theme) and
  regenerate them.
- **Judge scene composition** on a faithful backend recreation of the canonical
  scene (the just-placed element in context).
- **Make every verdict visible** in chat, and **never silently skip**.
- **Fully testable** — pure functions and golden images, no browser, no fakes
  standing in for the real path.

## Non-goals

- Reproducing engine-specific rendering effects or **bugs** (e.g. the observed
  "two backgrounds" artifact). The critic judges the _canonical_ scene; engine
  render glitches are a separate concern.
- Removing the Plan 3 capture machinery. It is **demoted out of the critical
  path** and kept for a possible future "use the true engine frame when a capable
  pane is attached" enhancement.
- A general-purpose headless Pixi/WebGL renderer. We composite the 2D sprite
  layout with Pillow, matching the engine's layout math — not its shader pipeline.

## Design

Two judgments, two inputs — matching the two real questions:

| Judgment              | Question                                                                                   | Input                                                             |
| --------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **Per-asset quality** | "Is this image empty / cut off / low quality / off-theme?"                                 | the raw generated asset image (the backend already has the bytes) |
| **Scene composition** | "Now that it's placed, does this element sit right — framing, overlap, balance, cohesion?" | a **backend composite** of the canonical scene                    |

Neither needs a browser frame capture.

### Component 1 — `AssetCritic` (new): per-asset quality gate

A swappable seam mirroring `build_scene_critic(settings)`:

- **Input:** the asset image bytes + intent (role, description/theme, whether it is
  expected transparent, target size).
- **Output:** `AssetVerdict { ok: bool, action: "keep" | "regenerate", reason: str }`.
- **Two-stage, cheap-first:**
  1. **Heuristic pre-filter (deterministic, no model):** flag a degenerate asset
     before spending a vision call. Signals: encoded byte size below a
     role-dependent floor; fraction of non-transparent (or non-background) pixels
     below a threshold; near-zero visual entropy / single-colour image; (for
     transparent cutouts) alpha coverage ~0. The 7.6 KB reel frame is caught here.
  2. **Vision check (model, behind the seam):** only if the heuristic passes,
     judge quality/cropping/theme. `LiveAssetCritic` = a direct
     `claude-sonnet-4-6` structured+image call (mirroring `LiveSceneCritic`);
     `ReplayAssetCritic` = keyed cassettes under `tests/fixtures/replay/asset/`
     (mirroring the critic cassettes), keyed by `normalize_prompt(role)` or a
     stable asset handle.
- **When it runs:** right after an element's art is generated, **before** the
  composition pass for that element. A `regenerate` verdict regenerates the asset
  (reusing the existing `regenerate_element` / `_regenerate_and_rebind` seam)
  before composition, bounded by the regen budget (see Open decisions for whether
  per-asset and composition regens share one budget).

### Component 2 — `SceneCompositor` (new): the faithful backend recreation

A pure function behind a `Compositor` protocol — the key new piece, and the thing
that replaces the live capture.

- **Input:** the canonical scene document (`GameSceneStore.get_document`) + the
  asset images for its textures.
- **Output:** PNG bytes of the composed scene, faithful to the engine's **layout**.
- **Replicates the engine's deterministic layout math:** canvas size from the Root
  node (`width`/`height`), background colour, and for each Sprite in `zIndex`
  order — load its bound texture image, apply `scale`, place at `position` honouring
  `anchor`, and apply `fit` (`cover` / `contain` / `none`). Implemented with
  Pillow.
- **Fidelity boundary:** it reproduces the _intended_ composition (position,
  anchor, scale, z-order, fit, canvas, background). It intentionally does **not**
  reproduce engine filters, blend modes, masks, or responsive-root scaling (#109).
  The layout-level edits the composition critic makes (move / scale / reorder /
  regenerate) are exactly what a layout-faithful composite supports.
- **Seam + parity:** `Compositor` protocol so it is swappable and unit-testable
  against golden images. The engine's `pixiRenderer` layout rules are the
  reference; a parity checklist (anchor, fit, z-order, canvas) keeps them aligned.

### Component 3 — `run_compose` rewiring

`run_compose` keeps its bounds/window/stop discipline. Changes:

- **`ComposeDeps.capture()` → `ComposeDeps.render_scene()`** backed by
  `SceneCompositor` instead of the broker. Same place in the loop; new, reliable
  source. (The method is renamed to stop implying a live capture.)
- **Per-asset gate added** before the composition pass: `place` → `AssetCritic` →
  (regenerate if needed) → composite → `SceneCritic` → apply edits → advance.
- **Fail-loud, not silent:** compositing a canonical document shouldn't fail the
  way a network round-trip did, but if an asset image is missing/unreadable the
  loop records a **visible** note ("couldn't render <handle> for review") rather
  than a silent skip, and still surfaces it in the result.
- `ComposeResult` gains per-element verdict notes (asset verdict + composition
  verdict) to drive visibility.

### Component 4 — Visibility (fail-loud + "I looked at it")

Surface the per-element judgments so the user can _see_ the loop work. Constraint:
`RunStep.index` is a contiguous Mongo array position owned by `TurnRunner`, so a
tool cannot inject extra contiguous run steps mid-execution (the reason the prior
design deferred this). Within that constraint:

- **Primary:** the `compose_scene` tool result already streams as the tool step's
  output — make its per-element notes carry the verdicts in plain language
  ("reel frame: looked empty → regenerated"; "logo: good — centred, in frame";
  "secretary: too large → scaled to 0.6 and moved into frame").
- **Evaluate (Open decision):** additionally emit a lightweight per-verdict chat
  message via the existing chat/scene event path, if it can be done without
  corrupting the `RunStep` index counter. If not cleanly possible, the rich tool
  result is the v1 surface and live-streamed per-verdict feedback is a logged
  follow-up.

### What changes vs. #119

- `SceneCaptureBroker` + the `scene_capture_request`/`scene_capture_result`
  handshake: **demoted from the critical path**, retained for a future
  true-frame enhancement. `ToolContext.capture_broker` stays but the compose loop
  no longer depends on it.
- `ComposeDeps`: `capture()` → `render_scene()` (compositor-backed); new asset-
  critique step.
- New modules: `app/scene/compositor.py`, `app/scene/asset_critic.py` (names TBD
  in the plan).

## Testing (this is the part that failed last time)

- **`AssetCritic`** — unit tests for the heuristic thresholds (golden empty /
  cut-off / good fixtures, incl. the real 7.6 KB reel frame as a fixture) and the
  vision stage via `ReplayAssetCritic` cassettes.
- **`SceneCompositor`** — golden-image unit tests: a known canonical document +
  known asset images → an expected composite (assert layout: a sprite lands at the
  right pixel box for given position/anchor/scale/fit/z; background fills; z-order
  correct). Parity test against the documented engine layout rules.
- **`run_compose`** — unit tests with a fake compositor + fake critics (extends the
  existing suite): per-asset regenerate path, composition edit/window/budget,
  fail-loud on unrenderable asset, stop-on-done.
- **Backend replay e2e (authoritative, no fakes-in-the-path)** — a real compose
  run that **composites for real** (no fake capture responder) and asserts the
  thing that was missing: **`passes > 0`**, the deliberately-empty asset is
  **regenerated**, a transform lands, the loop converges, and the verdicts appear
  in the result. This is the gate that would have caught the shipped bug.
- **Browser e2e** — keep one spec proving the build still renders live; it no
  longer carries the critique contract (that moves to the backend e2e, which is
  the right tier for it).

## Open decisions for the plan

1. **Regen budget:** one shared budget (current K=5) for per-asset + composition
   regenerations, or a separate small per-asset budget? (Leaning: shared, so a
   build can't run away.)
2. **Compositor fidelity scope for v1:** confirm the set — position, anchor,
   scale, `fit` (cover/contain/none), z-order, canvas size, background. Anything
   else (rotation, tint) deferred until a node type uses it.
3. **Visibility mechanism:** rich tool-result notes only (safe), vs. additionally
   streaming per-verdict chat messages (needs to respect the `RunStep` index
   constraint).
4. **Heuristic thresholds:** the empty/cut-off cutoffs (byte floor, alpha/coverage
   fraction, entropy) — pick defaults, make them constants, and back them with
   fixtures.
5. **Where the per-asset critique lives:** a step inside `run_compose` (keeps the
   loop the single orchestrator — preferred), vs. inside `generate_and_place`.
6. **Asset-critic input:** judge the standalone asset image only, or the asset on a
   neutral checkerboard/background so transparency/cropping reads correctly to the
   vision model?

## Self-review checklist (for the spec author)

- No TBDs left implicit — the open decisions above are explicitly enumerated for
  the plan, not hidden gaps.
- Internally consistent: capture is demoted everywhere it's mentioned; the
  compositor is the single new source of the composition frame.
- Scoped to one implementation plan: two new seams (`AssetCritic`,
  `SceneCompositor`) + `run_compose` rewiring + visibility + tests. Coherent and
  not decomposable into independently-shippable halves (the loop needs both).

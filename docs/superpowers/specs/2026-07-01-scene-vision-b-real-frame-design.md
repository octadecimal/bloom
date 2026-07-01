# Sub-project B — Real-frame vision: art/effects grade on the real engine frame

**Status:** design (approved direction, pending spec review)
**Date:** 2026-07-01
**Sub-project B of:** the generate → place → judge quality overhaul (see the
[Scene Blueprint design](2026-06-30-scene-blueprint-design.md), "Wider roadmap").
**Builds on:** the vision-in-the-loop capture path
([2026-06-27 spec](2026-06-27-vision-in-the-loop-scene-composition-design.md), Plan 3).

## Problem

The Scene Blueprint (sub-project A) gave the pipeline an up-front layout plan and a
critic that **reconciles each element to its planned region** — a _geometry_
judgment. That judgment is correct, but it is deliberately run against a **Pillow
layout-only composite**: position, anchor, scale, z-order, and background, with **no
filters, blends, masks, glows, particles, or responsive scaling**. `done: true`
certifies _geometry is plausible_, not that the scene looks premium.

Nothing in the pipeline ever looks at what actually ships. The runtime Pixi client
renders the real frame — with effects, blend modes, and the responsive root scaling
that fits the scene to the device safe area (PR #109) — but no stage grades it. The
art-direction prose the generator now consumes (sub-project A / C) has no closing
feedback loop: nobody checks whether the rendered result reads as a premium slot.

This is the biggest remaining premium-quality lever, and sub-project A explicitly
deferred it: _"Real-frame vision (critic grading the actual engine frame with effects
/ responsive scaling)… is sub-project B, additive on top of this work."_

## Goal

Add a single **art/effects grade** on the **real captured engine frame**, run once
after A's geometry loop converges. It judges the shipped look — lighting, depth,
cohesion, framing, readability, effect integrity — and can:

1. **Regenerate** assets that do not hold up when actually rendered in context
   (occluded, washed out by a blend, wrong at responsive scale), bounded by the
   existing per-build regeneration budget.
2. Emit a **human-facing premium verdict + notes**, surfaced in the chat feed (and,
   as an optional stretch, the A3 approval card).

The judgment is **additive**: A's geometry reconcile on the Pillow proxy is untouched.

## Non-goals

- **Geometry on the real frame.** The captured frame is responsively **root-scaled**
  to fit the viewport (`renderer.screen`), so plan-absolute pixels do **not** map to
  frame pixels. Geometry reconcile-to-plan stays on the unscaled Pillow proxy, where
  plan-px == frame-px. B does not re-open A's geometry judgment.
- **Effect-property actuators.** The art critic's _only_ actuator is `regenerate`. It
  does not tune glow/blend/filter/particle properties. A possible future slice.
- **Asset quality floor (sub-project C).** No negative prompts, `cfg`/steps tuning,
  upscaling, or asset-floor changes. B's `regenerate` reuses the existing generate
  path unchanged; C is where per-asset quality is raised.
- **A3 approval-card redesign.** Surfacing the real frame + verdict in the approval
  card is an _optional stretch_ at the end of B3, not a required deliverable. The
  deferred A3 follow-ups (override/render divergence, pane re-fetch, `set_role`
  atomicity, no-op sentinel) do not intersect B and are left for a cleanup pass.

## What already exists (extend, do not rebuild)

The real-frame capture round-trip is **built, tested, and intact** (vision-compose
Plan 3, PR #118) — it is merely **dormant**: `_SceneComposeDeps.render_scene()`
composites a Pillow proxy (PR #120) and never calls the broker.

```
compose_loop        _SceneComposeDeps          SceneCaptureBroker         runtime/client (Pixi)
run_compose ──render_scene()──► composite_scene (Pillow)          [capture_broker unused here]

  ── the wired-but-dormant real path B switches on: ──
run_compose ─capture_real_frame()─► broker.request_capture ─emit scene_capture_request─►
   protocolHost 'capture' ─► reconciler.capture ─► pixiRenderer.capture:
       await rAF (render-settled barrier)  ─►  renderer.extract.base64({stage, screen})
   ◄── 'captured' ◄── emitSceneCaptureResult ◄── scene_capture_result ◄── resolve_capture(future)
```

Two critic seams to **mirror exactly** — B's art critic is a third seam in the same
shape:

| Seam                          | Types                                   | Impls                                         | Selector                 | Cassettes                          |
| ----------------------------- | --------------------------------------- | --------------------------------------------- | ------------------------ | ---------------------------------- |
| `critic.py` (geometry)        | `CritiqueRequest` / `Critique`          | `ReplaySceneCritic` / `LiveSceneCritic`       | `build_scene_critic`     | `tests/fixtures/replay/critic/`    |
| `asset_critic.py` (per-asset) | `AssetCritiqueRequest` / `AssetVerdict` | `ReplayAssetCritic` / `LiveAssetCritic`       | `build_asset_critic`     | `tests/fixtures/replay/asset/`     |
| **`art_critic.py` (B, new)**  | `SceneArtRequest` / `SceneArtVerdict`   | `ReplaySceneArtCritic` / `LiveSceneArtCritic` | `build_scene_art_critic` | `tests/fixtures/replay/scene_art/` |

## Architecture

```
                       ┌─────────────────────────── run_compose ───────────────────────────┐
 elements ─► per-element geometry loop (A, UNCHANGED) ─► render_scene()=Pillow proxy ─► SceneCritic
                       │   converges on plan-px geometry                                     │
                       │                                                                     ▼
                       │        ── final art stage (B, NEW) ──                               │
                       │   frame = capture_real_frame()   ── None (no client) ─► skip + note │
                       │        │ bytes                                                      │
                       │        ▼                                                            │
                       │   for art_pass in ≤ art_passes:                                     │
                       │     verdict = SceneArtCritic.grade(frame, scene, plan, theme)       │
                       │     record verdict.summary + notes                                  │
                       │     if verdict.premium or no regenerate: break                      │
                       │     regenerate flagged handles (shared regen budget)                │
                       │     frame = capture_real_frame()  (re-capture; break if None)       │
                       └─────────────────────────────────────────────────────────────────────┘
                                                     │
                                        ComposeResult.notes ─► format_compose_summary ─► chat
```

### Component 1 — `studio/backend/app/scene/art_critic.py` (new seam)

Mirrors `critic.py` / `asset_critic.py` structurally.

```python
class ArtRegen(BaseModel):
    target_handle: str
    why: str = ""

class SceneArtVerdict(BaseModel):
    premium: bool = False                 # reads as a shipped premium slot?
    summary: str = ""                     # one-line human-facing verdict
    regenerate: list[ArtRegen] = []       # assets to remake (bounded by budget)
    notes: list[str] = []                 # specific observations

@dataclass(frozen=True)
class SceneArtRequest:
    frame_png: bytes                      # the REAL captured engine frame
    scene: dict                           # read_scene context (handles/roles/xy/size/z)
    plan: dict                            # intended regions (role → x,y,w,h,z)
    theme: str = ""
    regen_budget_left: int = 0
    pass_index: int = 0

class SceneArtCritic(Protocol):
    async def grade(self, request: SceneArtRequest) -> SceneArtVerdict: ...
```

- `ReplaySceneArtCritic` — deterministic; cassettes keyed by `normalize_prompt(theme)`
  and indexed by `pass_index`, with a `__default__` fallback and an over-iterated
  guard that returns `premium=true` so a loop ends. Follows `ReplaySceneCritic`.
- `LiveSceneArtCritic` — a **direct** structured+image completion via OpenRouter
  (`with_structured_output(SceneArtVerdict)`), reusing `settings.critic_model`. Not a
  bound tool (same rationale as the other two critics).
- `build_art_messages(request)` — pure builder (system prompt + multimodal human turn
  carrying scene/plan JSON + the frame as a base64 data URL); unit-testable offline.
- `build_scene_art_critic(settings)` — replay vs live by `provider_mode`.
- `load_scene_art_cassettes(dir)` — adds to `app/replay/cassette.py` alongside the
  existing loaders.

**Art system prompt** judges the _rendered_ frame on premium-slot aesthetics: overall
composition and balance, lighting/depth/contrast, colour cohesion vs the theme,
framing and negative-space discipline, readability of key elements (logo/reels/spin),
and effect integrity (an element must not be lost to a blend/glow/occlusion). It
prefers `premium=true` unless the scene is clearly not shippable, and flags
`regenerate` only for an asset that no re-render of the _same_ art could fix.

### Component 2 — `compose_loop.run_compose` final art stage

- `ComposeDeps` gains two async methods:
  - `capture_real_frame() -> bytes | None` — the real frame, or `None` when no client
    is attached / capture times out.
  - `art_grade(request: SceneArtRequest) -> SceneArtVerdict`.
    (`regenerate(handle)` is reused as-is.)
- `ComposeBounds` gains `art_passes: int = 2` (one grade + one re-grade after regens).
- **Budget:** art regenerations decrement the **same** `regen_left` used by the
  geometry loop, preserving the single hard per-build regeneration ceiling.
- The stage runs **once, after the element loop**:
  ```
  frame = await deps.capture_real_frame()
  if frame is None:
      result.notes.append("art grade skipped: no live client")
  else:
      for pass_index in range(bounds.art_passes):
          scene = await deps.scene_context()
          verdict = await deps.art_grade(SceneArtRequest(
              frame_png=frame, scene=scene, plan=<plan ctx>, theme=theme,
              regen_budget_left=regen_left, pass_index=pass_index))
          result.notes.append(f"art: {verdict.summary}")
          result.notes.extend(f"art: {n}" for n in verdict.notes)
          if verdict.premium or not verdict.regenerate:
              break
          for regen in verdict.regenerate:
              # guard: handle exists + budget left
              if regen_left <= 0: record refused; break
              if regen.target_handle not in <placed handles>: record rejected; continue
              regen_left -= 1; result.regens_spent += 1
              await deps.regenerate(regen.target_handle)
              result.notes.append(f"art regenerated {regen.target_handle}: {regen.why}")
          frame = await deps.capture_real_frame()
          if frame is None:
              result.notes.append("art re-grade skipped: no live client")
              break
  ```
- New `ComposeResult` counters as needed (e.g. `art_passes_run`, reuse `regens_spent`).

### Component 3 — `_SceneComposeDeps` + `ToolContext` (agent_tools.py)

- `ToolContext` gains `scene_art_critic: object = None` (next to `scene_critic`).
- `_SceneComposeDeps.capture_real_frame()`:
  ```python
  if self._ctx.capture_broker is None:
      return None
  try:
      return await self._ctx.capture_broker.request_capture(
          self._ctx.game_id, timeout=get_settings().art_capture_timeout)
  except (asyncio.TimeoutError, Exception):
      return None
  ```
  Wire the currently-unused **`art_capture_timeout`** setting (default ~3.0s) so a
  headless REST rebuild fails fast instead of stalling on the broker's 10s default.
- `_SceneComposeDeps.art_grade()` delegates to `self._ctx.scene_art_critic.grade(...)`.
- **Wiring:** `main.py` / `room_hub` build `build_scene_art_critic(settings)` and thread
  it into `ToolContext` exactly like `scene_critic`. `capture_broker` is already threaded.
- **Guard:** `compose_scene` / `rebuild_scene_core` continue to work when
  `scene_art_critic is None` (art stage simply does not run) — no hard dependency.

### Ordering guarantee (load-bearing)

`run_compose` **awaits** each `place` / `adjust` — which emits the scene op over the
game room — _before_ the art stage emits `scene_capture_request` on the **same
ordered Socket.IO room**. Socket.IO preserves per-connection message order, so the
client applies every pending op, _then_ handles the capture (which itself waits one
`requestAnimationFrame`). No extra settle delay is needed; the existing render-settled
barrier plus in-order delivery is sufficient. This ordering is why the first real
capture reflects the fully-built scene.

## Degradation & determinism

| Context                              | Frame source          | Grade source           | Result                          |
| ------------------------------------ | --------------------- | ---------------------- | ------------------------------- |
| Live studio, browser client attached | real capture          | `LiveSceneArtCritic`   | true art grade, may regenerate  |
| Playwright e2e (replay backend)      | **real** capture      | `ReplaySceneArtCritic` | true round trip, cassette grade |
| Backend replay e2e (no client)       | `None` (timeout)      | —                      | art skipped + note, geometry OK |
| Backend replay e2e (injected frame)  | fake broker bytes     | `ReplaySceneArtCritic` | cassette grade, bounded regen   |
| REST intent-save rebuild, no client  | `None` (fast timeout) | —                      | art skipped + note              |

The art grade is **non-deterministic only when live**; in replay it is
cassette-driven. It is **not a new reproducibility input**: reproduction reuses stored
`Generation.seed`s and runs the art critic against cassettes, consistent with the
Scene Blueprint reproducibility model (GDD intent + overrides + seeds + template
version). B adds no persisted state.

## Testing (TDD-first; e2e authoritative)

- **Unit (RED-GREEN-REFACTOR):**
  - `run_compose` art stage behind a `ComposeDeps` fake: grade → regenerate → re-grade
    → converge; `premium=true` short-circuits; regens deplete the **shared**
    `regen_left`; skip when `capture_real_frame()` returns `None`; `art_passes` bound;
    unknown / budget-exhausted regen handles refused.
  - `ReplaySceneArtCritic` cassette selection (keyed, `__default__`, over-iterated).
  - `build_art_messages` pure-builder shape (system prompt + image data URL + JSON).
- **Backend e2e (replay, CI-affordable) — `tests/e2e/`:**
  - **No-client:** compose/rebuild with no browser → art skipped, note present,
    geometry output byte-for-byte unchanged vs pre-B (regression guard).
  - **Injected-frame:** a fake `capture_broker` returning canned PNG bytes →
    `ReplaySceneArtCritic` grades from a hand-authored cassette → asserts a bounded
    regenerate is applied and the verdict summary is recorded in the compose summary.
  - New `tests/fixtures/replay/scene_art/` cassettes, hand-authored from static
    analysis (tuner-chat precedent) or recorded live.
- **Browser e2e (Playwright, local, authoritative) — worktree offset-1 ports:**
  - **Real** game client attached and joined to the scene room → build a scene →
    assert the **capture → art-grade round trip actually fires**: the art verdict /
    notes surface in the chat feed and the art pass is **not** skipped. Capture is
    real (browser + `renderer.extract`), grade is a replay cassette — full parity,
    deterministic. Reuses the `compose-loop.spec.ts` harness.
  - _(B3 optional stretch)_ if the approval-card surfacing is built: an approval-gate
    spec asserting the real frame + verdict render in the `ApprovalCard`.

## Phase breakdown (each a clean stop/ship point)

| Phase                      | Deliverable                                                                                                                                                           | Tests                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **B1 — art critic seam**   | `art_critic.py` (types, protocol, replay + live, `build_scene_art_critic`, pure builder) · cassette loader · `art_capture_timeout` + `scene_art_critic` config/wiring | unit (replay selection, builder)                         |
| **B2 — compose art stage** | `run_compose` final art stage · `ComposeDeps` `capture_real_frame` / `art_grade` · `_SceneComposeDeps` impls · graceful skip · shared budget · chat surfacing         | unit (stage logic) + backend e2e (skip + injected-frame) |
| **B3 — client contract**   | Playwright real capture → grade round trip; verdict in chat feed. _Optional stretch:_ real frame + verdict in the A3 `ApprovalCard` (+ approval-gate spec)            | Playwright (offset-1 replay backend)                     |

## Risks

- **Hot files.** `agent_tools.py` is edited across many sessions. B adds only thin
  call-sites there (one `ToolContext` field, two `_SceneComposeDeps` methods, wiring);
  all new logic lives in the fresh `art_critic.py` and inside `compose_loop.py`. Land
  B fast to avoid merge drift.
- **Capture flakiness in Playwright.** The real round trip depends on a joined client
  and a settled render. Mitigated by the in-order-delivery + `rAF` guarantee above and
  by reusing the proven `compose-loop.spec.ts` harness; if flaky, add a short
  post-op settle before the capture request rather than lengthening the timeout.
- **Headless stall.** Without a fast `art_capture_timeout`, a no-client rebuild would
  block on the broker's 10s default. The short timeout (default ~3s) bounds this; a
  live client answers in well under a second.
- **Scope creep into C.** The art critic can _flag_ regeneration but must not alter
  the generate path (prompts/cfg/steps/upscale) — that boundary keeps B additive and
  C independently shippable.

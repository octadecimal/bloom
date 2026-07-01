# Sub-project C — Asset quality floor: role recipes, flux-dev, mandatory critic, upscale

**Status:** design (approved direction, pending spec review)
**Date:** 2026-07-01
**Sub-project C of:** the generate → place → judge quality overhaul (see the
[Scene Blueprint design](2026-06-30-scene-blueprint-design.md), "Wider roadmap").
**Related prior art:** [compose quality guards](2026-06-28-compose-quality-guards-design.md)
(the per-asset critic + re-judge loop this spec makes mandatory and role-aware).

## Problem

Sub-projects A (Scene Blueprint) and B (real-frame vision) fixed _placement_ and
_judgment_, but both deliberately left the **generation path** untouched. Each named
C as the owner of per-asset quality and confirmed the boundary: A's generator "now
reads art direction + role but does not build" the quality floor; B's `regenerate`
"reuses the existing generate path unchanged; C is where per-asset quality is raised."

The generate path today produces "acceptable AI filler," and four structural causes
cap its ceiling:

1. **The prompt is bare.** Both `generate_asset` and `generate_and_place`
   (`agent_tools.py`) build the entire positive prompt as
   `description if not style else f"{description}, {style} style"`. No role-awareness,
   no quality boilerplate, no negatives. A latent `prompt_for_role()`
   (`scene/layout/intent.py`) that would fold in art-direction prose exists but is
   **never consumed** by generation, and `role_snippets` is always empty.

2. **The model structurally can't be steered.** Both wired workflows
   (`schnell-transparent` / `schnell-opaque`) use **FLUX schnell**
   (`flux1-schnell-fp8`, `cfg=1.0`, `steps=4`). Schnell is timestep-distilled: it
   **ignores CFG>1 and negative prompts** — the negative `CLIPTextEncode` node exists
   but is dead at `cfg=1.0`. "Negatives / cfg tuning" cannot bite on schnell. A
   `dev-transparent` workflow (`flux1-dev-fp8`, a `FluxGuidance` node, `steps=24`)
   exists in the repo but **is never selected by any code path** — the real quality
   headroom is dead code.

3. **Generation params are frozen.** `patch_graph` patches only prompt / width /
   height / seed; `cfg`, `steps`, `guidance`, and the negative text are baked into the
   workflow JSON, so nothing can tune them per asset, and the `Asset` record persists
   none of them (regeneration is not param-reproducible).

4. **The quality floor is optional.** The per-asset critic (`asset_critic.py`,
   `build_asset_critic`) runs **only inside the compose loop**'s asset gate. A
   standalone `generate_asset` / `generate_and_place` call — the ad-hoc "add one
   thing" path — never critiques, so a dud reaches the Asset Board unchecked. The
   critic's prompt is also role-blind in structure (it is told the role but has no
   per-role expectations).

## Goals

- **Role-aware generation.** A per-role **generation profile** drives both the prompt
  (positive boilerplate + optional negative) and the sampler params (steps, guidance,
  cfg), so a background, a logo, and a symbol are each generated the way their role
  demands.
- **Real steering.** Move default generation from schnell → **flux-dev everywhere**,
  turning guidance / steps / negatives into levers that actually affect the output.
- **Reproducible params.** Persist the generation params on the `Asset` so a
  regeneration reproduces byte-for-byte from `seed + params` — consistent with the
  Blueprint reproducibility model.
- **A mandatory floor.** Every generation — compose loop **and** direct
  `generate_asset` / `generate_and_place` — passes a role-aware asset critic with
  bounded regeneration before it reaches the board.
- **Hero polish.** Hero roles (logo, background) are model-upscaled for crispness;
  standard roles are not (they don't need it and shouldn't pay for it).

## Non-goals

- **Geometry / layout.** Owned by sub-project A (the `ScenePlan`, template, bind).
  C never sets positions, regions, or anchors.
- **Real-frame / effects grading.** Owned by sub-project B (`art_critic.py` grades the
  captured Pixi frame). C does not touch the art critic; B's `regenerate` actuator now
  simply flows through C's improved generate path.
- **A model _tier_ per role.** The decision is flux-dev **everywhere** (one model). The
  per-role variation is a param/upscale **profile**, not a different checkpoint.
- **Negatives on every role.** flux-dev at `cfg=1.0` + FluxGuidance ignores the
  negative node; activating negatives requires `cfg>1`, which ~doubles inference cost.
  Negatives are therefore active **only on the `logo` profile** (`cfg≈2.0`), where
  garbled-text / artifact suppression earns the cost. Every other role keeps `cfg=1.0`
  + FluxGuidance and relies on its positive recipe. (A deliberate boundary, revisitable
  per-role later.)
- **A ComfyUI graph rewrite.** The existing node topology is reused; C adds params to
  existing nodes and inserts one upscale node. No new sampler / VAE / RMBG wiring.

## The organizing abstraction — role → generation profile

A single pure, greppable mapping is the spine of all three phases. It is a **profile**
(same model — dev — everywhere), not a tier:

```
role         profile   steps  guidance  cfg   negative  upscale   positive boilerplate
background   hero        28     3.0      1.0     —          ✓       full-bleed cinematic scene, depth, no text
logo         hero        28     3.5      2.0     ✓          ✓       legible wordmark, clean cutout, premium
reels/frame  standard    24     3.5      1.0     —          ✗       clean UI frame, crisp edges
symbol_*     standard    20     3.5      1.0     —          ✗       crisp centered icon, clean cutout
spin/button  standard    20     3.5      1.0     —          ✗       glossy game button, readable
__default__  standard    20     3.5      1.0     —          ✗       (standard)
```

- Lives in a **new pure module `app/assets/recipes.py`** — fully unit-testable, keeps
  the hot `agent_tools.py` thin. All values are module constants (greppable / tunable),
  mirroring the `ComposeBounds` convention.
- Roles resolve through the **existing `canonical_role()` aliases** (`scene/layout/plan.py`),
  so `title`/`wordmark` → `logo`, `reel_frame` → `reels`, etc. Unknown roles → `__default__`.
- A profile carries: `steps`, `guidance`, `cfg`, `negative` (str, `""` = none),
  `upscale` (bool), and `positive` (role boilerplate). Two pure functions:
  - `profile_for(role) -> Profile`
  - `build_asset_prompt(role, art_direction, description) -> str` — extends the latent
    `prompt_for_role()`: `description` + the profile's positive boilerplate + the
    art-direction prose, deduped and comma-joined.

## Phase C1 — parameterized generation + role-aware prompts (foundation)

**Deliverable:** the bare-prompt / frozen-param / schnell generate path is replaced by
a role-recipe-driven flux-dev path with persisted, reproducible params.

- **`assets/graph.py`** — `patch_graph` / `build_graph` accept optional generation
  params and patch the corresponding nodes:
  - `negative` → node `7` (`CLIPTextEncode`) `text`.
  - `steps`, `cfg` → node `3` (`KSampler`).
  - `guidance` → node `11` (`FluxGuidance`) when present in the workflow (schnell
    workflows have no `11`; the patch is a guarded no-op there so the function stays
    total across workflows).
  - Existing prompt / width / height / seed patching is unchanged. Params are
    optional with today's baked defaults, so a call with no params is a no-op change.
- **New `dev-opaque` workflow JSON** (`assets/workflows/ai_slots_dev_opaque.json`) —
  the opaque sibling of `ai_slots_dev_transparent.json` (flux-dev + FluxGuidance,
  VAEDecode → SaveImage, no RMBG). `WORKFLOWS` map + the `Workflow` Literal
  (`assets/models.py`) gain `dev-opaque`.
- **Default workflow selection flips** schnell → dev: `transparent` bool now selects
  `dev-transparent` / `dev-opaque` in `generate_asset` / `generate_and_place`
  (and the compose path, which forwards through `generate_and_place`). The schnell
  workflows stay registered (not deleted) but are no longer the default.
- **`assets/recipes.py`** — the profile mapping + `profile_for` + `build_asset_prompt`
  (above).
- **Persist params on `Asset`** — a `GenParams` submodel
  (`negative`, `steps`, `guidance`, `cfg`, `upscale`) stored on the asset record and
  read back by `AssetHub._run` when building the graph, so a regeneration reproduces
  from `seed + params`. `asset_store.create_asset` gains an optional `params` arg;
  `build_graph` is called with them in `hub._run`.
- **Wire the recipe into the generate path** — `generate_asset` / `generate_and_place`
  resolve `role` → `profile_for(role)`, build the prompt via `build_asset_prompt`
  (pulling `art_direction` from the game's GDD intent via `read_intent`), and pass the
  profile's params into `create_asset`. The `description if not style…` line is removed.
  `generate_asset` has no `role` param today — it gains one (optional; `__default__`
  when absent).

**Tests (TDD, RED→GREEN→REFACTOR):**
- **unit** — `profile_for` alias resolution + default fallback; `build_asset_prompt`
  composition (dedupe, art-direction folded, role boilerplate present); `patch_graph`
  patches each node for dev and is a guarded no-op for `11` on schnell; `GenParams`
  round-trips on the `Asset` wire model.
- **backend e2e (replay, CI-affordable)** — an agent-driven `generate_and_place`
  produces an asset persisted with the **dev** workflow and the role's params, and the
  built graph carries them (assert against the fake comfy's received graph).

## Phase C2 — mandatory role-aware asset critic (the floor gate)

**Deliverable:** no asset reaches the board uncritiqued; the compose loop and the
direct path share one floor.

- **New pure module `app/scene/asset_floor.py`** — extract the generate → critique →
  bounded-regen loop that currently lives inline in `run_compose`
  (`compose_loop.py:166–186`) into a reusable unit:
  ```
  async def run_asset_floor(
      *, load_image, role, description, theme, transparent,
      critic, regenerate, bounds, regen_left,
  ) -> AssetFloorResult   # verdict + regens_spent + notes
  ```
  `load_image()` returns the current asset bytes; `regenerate()` remakes it; `critic`
  is the existing `AssetCritic`. Bounded by `asset_regen_retries` + the passed-in
  `regen_left` (the single shared budget). Pure I/O-behind-callables → unit-testable
  without Mongo / sockets / an LLM, exactly like `run_compose`.
- **`run_compose` delegates to it** for its per-asset gate — same behaviour, now shared
  (no double-critique; the compose loop keeps ownership of the shared `regen_left`,
  passing it in and reading back `regens_spent`).
- **`generate_asset` / `generate_and_place` call it** after generation and before
  placement: `load_image` reads the freshly-saved media by the asset's newest (or
  selected) generation `image_ref` (the seam-consistent path
  `_SceneComposeDeps.critique_asset` / `regenerate_element` already
  uses via `collect_scene_images` / the media store), `regenerate` re-runs
  `generate_and_wait`. A direct call now generates → critiques → (bounded) regenerates
  → then places / reports. Its own small regen budget (a `ToolContext`/settings
  constant) bounds an ad-hoc call.
- **Role-aware critic prompt** — extend `ASSET_SYSTEM_PROMPT` (`asset_critic.py`) with
  per-role expectations threaded from the request's `role`: background = full-bleed
  scene, no stray text; logo = legible wordmark, clean cutout; symbol = clean centered
  icon; button = readable label. The existing text / transparency checks stay. This is
  a **vision-prompt** change only — `asset_heuristic` is untouched.
- **Wiring** — the direct path needs an `asset_critic` on `ToolContext` (already
  present, wired for compose) and a way to load media bytes (media dir from settings,
  already used by `_SceneComposeDeps`). No new persistence.

**Tests (TDD):**
- **unit** — `run_asset_floor`: converges (regenerate then keep → `regens_spent≥1`,
  settles ok); bounded (stays bad → stops at `asset_regen_retries`, respects
  `regen_left`, keeps with the right note); role passthrough (the request carries the
  resolved role); shared-budget accounting matches the old inline loop (regression: a
  golden `run_compose` tally is unchanged after the extraction).
- **backend e2e (replay)** — a direct `generate_asset` whose first generation is a dud
  (heuristic-caught or a hand-authored `ReplayAssetCritic` cassette keyed to the role)
  **regenerates and converges**; assert the board asset is the converged one and the
  regen is noted. Cassettes hand-authored from static analysis (tuner-chat precedent)
  under `tests/fixtures/replay/asset/`.

## Phase C3 — hero-only model upscale (polish)

**Deliverable:** hero assets are crisper; standard assets are unchanged.

- **Upscale node in the dev workflows** — insert a model-upscale chain
  (`UpscaleModelLoader` → `ImageUpscaleWithModel`, then a downscale-to-target
  `ImageScale` back to the requested WxH so downstream size contracts hold) between
  `VAEDecode` (`8`) and the terminal node (`BiRefNetRMBG` `10` for transparent,
  `SaveImage` `9` for opaque). The chain is added by `patch_graph`/`build_graph`
  **only when the profile's `upscale` flag is set**, so standard-role graphs are byte-
  identical to C1's.
- **Profile gate** — `upscale=True` on `background` / `logo` only (already in the C1
  profile table); the flag is persisted in `GenParams` so a hero regeneration upscales
  too.
- **Prerequisite verification (plan task 0)** — before building, query the live
  ComfyUI `/object_info` to confirm the upscale model (e.g. `4x-UltraSharp`) is
  installed in `C:\ComfyUI\models\upscale_models`; a missing model hard-fails
  generation, so this is a gating check, not an assumption. The model name is a
  settings constant (`upscale_model`) so it's swappable without code changes.

**Tests (TDD):**
- **unit** — `build_graph` for a hero profile contains the upscale chain wired
  VAEDecode → upscale → terminal, and the final `ImageScale` targets the requested
  size; a standard profile's graph contains **no** upscale node (byte-identical to C1).
- **opt-in live/e2e** — a hero generation against the live ComfyUI returns an image at
  the requested size (proves the round trip); gated behind the live tier, never CI.

## Reproducibility

C adds one persisted input — the per-asset `GenParams` — alongside the existing
`Generation.seed`. A regeneration is reproducible from `seed + params + workflow`,
and the recipe that produced those params is itself derivable from `role +
art_direction`, so nothing new bloats the GDD. This slots into the Blueprint model
(GDD intent + overrides + seeds + template version) — C's params live on the asset
record, the natural home for generation inputs.

## What changes, by file

- `app/assets/recipes.py` — **new.** Profile table + `profile_for` + `build_asset_prompt`.
- `app/assets/graph.py` — `patch_graph`/`build_graph` accept params (negative, steps,
  guidance, cfg) and the conditional upscale chain (C3).
- `app/assets/workflows/ai_slots_dev_opaque.json` — **new** dev opaque workflow.
- `app/assets/models.py` — `GenParams` submodel; `Asset.params`; `dev-opaque` in the
  `Workflow` Literal; `WORKFLOWS` map entry.
- `app/assets/store.py` — `create_asset` persists `params`.
- `app/assets/hub.py` — `_run` reads `asset.params` into `build_graph`.
- `app/scene/asset_floor.py` — **new.** `run_asset_floor` (extracted shared floor).
- `app/scene/compose_loop.py` — the inline asset gate delegates to `run_asset_floor`.
- `app/scene/asset_critic.py` — role-aware expectations in `ASSET_SYSTEM_PROMPT`
  (vision only; heuristic untouched).
- `app/agent_tools.py` — thin call-sites: `generate_asset` gains `role`; both generate
  verbs resolve the recipe, build the prompt, pass params, and run the mandatory floor.
- `app/config.py` — `upscale_model` constant (C3); optional ad-hoc regen budget.

## Phase breakdown (each a clean stop/ship point)

| Phase | Deliverable | Tests |
| ----- | ----------- | ----- |
| **C1 — recipes + dev + params** | `recipes.py` profile spine · `patch_graph` params · `dev-opaque` workflow · schnell→dev default · `GenParams` persisted · generate path builds role-aware prompt + params | unit (profile/prompt/graph/params) + backend e2e (dev workflow + params persisted) |
| **C2 — mandatory critic** | `asset_floor.py` shared floor · compose delegates · direct path gated · role-aware critic prompt | unit (floor convergence/bounds/budget + `run_compose` regression) + backend e2e (direct dud regenerates & converges) |
| **C3 — hero upscale** | conditional upscale chain in dev workflows · profile-gated (hero-only) · `upscale_model` setting · prereq verification | unit (graph has/omits upscale by profile) + opt-in live check |

## Risks

- **Hot file `agent_tools.py`.** Frequently edited across sessions. All new logic lives
  in fresh modules (`recipes.py`, `asset_floor.py`); the two generate verbs gain only
  thin call-sites. Land C1 fast to minimize merge drift (see [[avoid-merge-conflicts]]).
- **dev-everywhere GPU cost.** ~5–6× schnell time per asset (24–28 vs 4 steps) × 8–12
  assets/scene, before upscale. Accepted per the model decision; the profile keeps
  standard roles at fewer steps, and hero upscale is the only added compute in C3.
- **Default-workflow ripple.** Persisted `workflow` strings and existing golden /
  replay fixtures reference schnell. Flipping the default must not silently break them:
  the plan audits `tests/fixtures` and any golden scene docs when the default changes,
  and keeps schnell selectable for existing assets.
- **Negatives cost/benefit.** `cfg>1` on the `logo` profile ~doubles that asset's
  inference cost. Scoped to the one role where legibility justifies it; revisitable.
- **Upscale-model dependency.** A missing upscale model hard-fails hero generation.
  Verified against the live ComfyUI in C3 task 0 before building; the model name is a
  swappable setting.
- **Replay parity.** Replay mode never calls ComfyUI, so param/workflow changes must be
  asserted against the **graph handed to the fake comfy** (not a real image). The C1
  backend e2e checks the received graph; cassettes cover the critic.

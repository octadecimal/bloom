# Math Consolidation — Design

**Date:** 2026-07-03
**Status:** Approved design (umbrella spec for three sub-projects)

## Problem

The studio's math workflow is spread across three plugins — Simulator, Tuner, and
Math Analytics — plus a Game Config plugin that starts empty. Producing a tuned
game means visiting multiple panes whose knobs overlap, whose data lives in
different Mongo stores, and whose shared source-of-truth class (`SlotModelStore`)
is buried under `app/simulator/` even though everything depends on it. There is
no way to tell the genetic algorithm "don't touch this part of my config," and a
fresh game has no symbols, reels, or paytable at all.

## Goal

One **Math** plugin: set target RTP / volatility / bonus rate, press
**Generate**, watch the GA evolve live, get an independently verified result,
click **Apply**. One backend module (`app/math`) and one per-game config
document behind it. Game Config is never empty and can lock sections against
automation.

## Division of labor (after this ships)

| Plugin          | Role           | Owns                                                                                      |
| --------------- | -------------- | ----------------------------------------------------------------------------------------- |
| **GDD**         | Intent         | Target RTP, volatility band, bonus hit rate (`math-model` aspect)                         |
| **Game Config** | Realization    | Structural SlotModel: symbols, reels, paytable, paylines, bonus; section locks; templates |
| **Math** (new)  | Reconciliation | Generate pipeline (tune → verify), live analytics, Apply                                  |

Simulator, Tuner, and Math Analytics panes are deleted.

## Decisions (with rationale)

1. **GDD stays the sole source of target intent.** The Math plugin's target
   inputs read and write the GDD `math-model` doc (via the existing
   `PUT /games/{id}/gdd/math-model`). No override layer, no second copy —
   the GDD plugin, chat, and the Math plugin edit the same fields.
2. **One plugin replaces all three.** No facade-plus-legacy period; four panes
   over the same data is more discombobulation, not less.
3. **Generate = tune → verify → human Apply.** The pipeline runs the GA with
   live analytics streaming, then automatically runs the independent curate
   verification on the winner. Apply remains a human-gated write.
4. **Section-level locks: reels, paytable, bonus.** Locks constrain
   _automation_ (GA, template apply), never humans. The GA already mutates only
   these three gene groups, so three toggles cover the whole tunable surface.
5. **Template picker with seed-on-creation.** New games are born with a
   complete playable **video-5x3** model (pre-tuned near 96% RTP, frozen into
   code); Game Config gains "Apply template…" (classic-3x3, video-5x3,
   high-vol-5x4) to restamp any time. A game's model is never `{}` again.
6. **Full backend merge.** `app/simulator` + `app/tuner` + `app/analytics`
   collapse into `app/math`; tuner params fold into the one `slot_models` doc.
7. **Sequencing: backend-out, three sub-projects** (each its own
   spec-referencing plan → worktree → PR). The risky data/module migration
   happens first, while the existing well-tested panes still exercise it.

## Current-state facts the design builds on

- `slot_models` (Mongo) is already the shared SoT doc, one per `game_id`, with
  every write broadcasting `slot_model_changed {gameId, updatedAt, source}`
  from a single choke point (`SlotModelStore.put`).
- Tuner params live in a **separate** tuner collection (`TunerStore`) — the
  config split this design removes.
- Targets are computed on demand by `derive_target(gdd math-model, params)`
  (`app/simulator/targets.py`); there are no manual target inputs anywhere.
- The GA genome (`studio/tuner/src/genome.rs`) encodes only per-reel symbol
  counts, paytable payouts, and bonus config; everything else is implicitly
  frozen by not being a gene.
- `app/scene/reels_spin.py` carries a hard-coded demo fallback model for games
  with an empty model — deleted once seeding guarantees a real model.
- The chat agent tools (`read_tuner_setup`, `tune_slot_model`,
  `apply_tuned_model`, …) go through the same stores and must keep their names
  (replay-cassette compatibility).

---

## Sub-project 1 — Unified math backend (`app/math`)

### Module merge

```
app/math/
  store.py       # MathStore (renamed SlotModelStore) — the one SoT accessor
  models.py      # SlotModelDoc (unified), CurationParams, TuningParams, MathRunDoc
  templates.py   # named starter models: classic-3x3, video-5x3 (default), high-vol-5x4
  targets.py     # derive_target (moved verbatim)
  rest.py        # all existing routes preserved + template + generate routes
  hub.py         # MathHub: absorbs sim/tuner/analytics hubs; owns the Generate pipeline
  runners/       # curate.py, tune.py (the two subprocess runners, moved)
```

All existing REST routes and socket event names are **preserved** (they move,
not change). The three current plugins and the chat agent tools keep working
with only backend import-path updates; the existing e2e suite is the
migration's regression net.

### Unified document

Collection name `slot_models` and existing field names are kept; new fields
are added:

```
{ id, game_id,
  model,          # slots@1 SlotModel — never {} after this ships
  presentation,   # unchanged
  params,         # CurationParams (unchanged)
  tuner_params,   # TuningParams — migrated in from the tuner collection
  locks,          # {reels: false, paytable: false, bonus: false}
  result,         # last CurationResult (unchanged)
  created_at, updated_at }
```

Startup migration in `MathStore` init: any doc missing `tuner_params` gets it
copied from the old tuner collection (or defaults); `locks` defaults stamped.
Dev-scale data — a one-shot in-process migration, no external script. The old
tuner collection is then unused. Locks are **stored but not enforced** until
sub-project 2.

### Templates and seeding

- `templates.py` holds complete, playable slots@1 models. **video-5x3** is the
  default and is pre-tuned near 96% RTP (produced once with the tuner, frozen
  into code).
- `MathStore.ensure()` seeds new games with the default template instead of
  `{}` (change source `"template"`), so Game Config is never empty.
- The `reels_spin.py` hard-coded fallback model is deleted; the stored doc is
  always real.
- New routes: `GET /slot-model/templates` (list),
  `POST /games/{id}/slot-model/apply-template {name}` — overwrites **unlocked**
  sections only, fires `slot_model_changed`.

### Generate pipeline (backend-owned)

`POST /games/{id}/math/generate` on `MathHub`:

1. `derive_target` (unchanged semantics; missing GDD intent → structured
   `target_gap` failure).
2. Run the tune, streaming per-generation `analytics_progress` exactly as
   today.
3. On completion, automatically run the curate verify pass on the winner.
4. Persist one `math_runs` doc that now **includes the verify verdict**; emit
   `run_complete`.

Apply stays a separate human-gated endpoint (unchanged semantics). Because the
pipeline is server-side, the chat agent's `tune_slot_model` upgrades to
tune+verify with no tool-name change.

---

## Sub-project 2 — Locks + templates UI

### Semantics

Locks constrain **automation, not humans**. A locked section (reels /
paytable / bonus) is never modified by the GA and never overwritten by "Apply
template", but remains fully human-editable in Game Config. Default: all
unlocked.

### Rust (`bloom-tuner`)

- `tuner_config.json` gains `locks: {reels, paytable, bonus}`.
- Implementation is **genome omission**, not masking: a locked group's genes
  are not encoded; decode copies that group verbatim from the seed model.
  Mutation/crossover code is untouched and the search space genuinely shrinks.
- All three locked → `tune_json` emits a structured error frame; the backend
  surfaces "everything is locked — nothing to tune".
- Cargo tests: locked sections byte-identical across a full tune; SplitMix64
  determinism preserved per lock set. Run `cargo fmt --check` + `clippy`
  locally before the PR.

### Game Config UI

- Padlock toggle on the Reels, Paytable, and Bonus section headers, bound to
  `locks` on the doc, saved through the existing debounced PUT and broadcast
  via `slot_model_changed`. Symbols and paylines get no padlock — the GA
  cannot touch them.
- Toolbar **"Apply template…"**: picker (classic-3x3 / video-5x3 /
  high-vol-5x4) → confirm dialog stating which sections will be overwritten
  and which are lock-protected → calls the sub-project-1 endpoint.

---

## Sub-project 3 — The Math plugin

New `studio/frontend/src/plugins/math/` (id `math`, title "Math"). Layout, top
to bottom:

1. **Target strip** — editable RTP %, volatility (enum select), bonus hit rate
   (1:N). Hydrated from the GDD `math-model` doc; saved via
   `PUT /games/{id}/gdd/math-model` with the debounce + `updatedAt` watermark
   pattern game-config already proved; live-syncs with chat/GDD edits via
   `gdd_updated`. Derived bands from `derive_target` render read-only beside
   the inputs. A missing-intent `target_gap` is fixed in place by filling in
   the strip.
2. **Generate** — the one primary-accent button, running the sub-project-1
   pipeline; status cycles _tuning gen N/M → verifying → done_. Disabled while
   a run is active or when everything is locked (explanatory chip). Secondary
   **"Verify only"** action: curate the current stored model without tuning
   (the Simulator pane's old role, kept for after hand-edits).
3. **Live body** — the four analytics tabs carried over from math-analytics:
   **Evolution** (default; streams live during a run), **Profile**,
   **Compare**, **Report**. `run_complete` swaps the live frames for the
   frozen trace, as today.
4. **Result strip** — verdict badge; measured RTP / volatility / hit-rate
   against target bands; chips showing which sections were locked for the run;
   **Apply** (human-gated; enabled even on a failed verdict, styled as a
   warning).
5. **Advanced expander** — GA knobs and curation params (today's Tuner /
   Simulator settings), collapsed by default, persisted to `tuner_params` /
   `params` on the doc.

**Deletions & continuity:** `plugins/simulator`, `plugins/tuner`, and
`plugins/math-analytics` are deleted in the same PR as the new pane, along
with their e2e specs (replaced — see Testing). Chat agent tool names stay
stable; internals point at `app/math`.

### SP3 brainstorm resolutions (2026-07-04)

- **Approach: grow `math-analytics` into `math`.** `git mv
plugins/math-analytics → plugins/math`; most surviving code (tabs, charts,
  RunSelector, socket/state plumbing) already lives there. The strips are added
  around it; `plugins/simulator` and `plugins/tuner` are deleted in the same PR.
- **Re-hydration ported (PR #99 behavior).** Pane open fetches the last
  persisted run/tune result so the result strip is populated and Apply is
  enabled after out-of-pane (chat) tunes. `tuner-chat.spec.ts` is reworked to
  assert Apply via the Math pane.
- **Result strip pinned to latest; tabs browse freely.** The RunSelector and
  run-history browsing carry over verbatim, but verdict/metrics/Apply always
  reflect the latest completed run or verify — never the browsed run. Tabs =
  analysis; strip = current state.
- **Backend prune: dead-only.** `POST /games/{id}/tuner/tune` dies, plus any
  route/emission with zero remaining consumers once the panes are gone
  (candidate: `GET /games/{id}/tuner/seed` — verify during planning). Everything
  the pane, chat tools, or replay cassettes still touch keeps its name.
- **One additive backend change.** `record_run` snapshots the doc's `locks`
  into the `math_runs` doc (and the `run_complete` payload) so the result strip
  can render per-run lock chips.
- Saved Dockview layouts referencing deleted pane ids already fall back to the
  default layout (`layoutService` drops unknown panels), so no layout migration
  is needed.

---

## Error handling

- **Tune failure** (subprocess crash, watchdog kill) → `tuning_failed`
  surfaces in an error strip; the stored doc is untouched.
- **Verify failure is a result, not an error** — red verdict; Apply available
  with warning styling.
- **One run per game** — Generate during an active run returns 409; the
  button is socket-state-disabled anyway.
- **All-locked** — structured error from Rust; Generate pre-disabled with an
  explanatory chip.
- **Concurrent edits** — target strip and Game Config both use the debounced
  PUT + `updatedAt` watermark pattern, so plugin, chat, and GDD edits do not
  fight.

## Testing

Repo rules apply: TDD at unit level; the Playwright e2e suite is the
behavioral contract, run locally (`just e2e`, replay backend), never CI.

- **Sub-project 1** — Python unit tests: doc migration, template seeding,
  generate pipeline ordering (fake runners: tune → verify → persist), and the
  apply-template endpoint (locked sections preserved). Routes preserved ⇒ the
  **existing** e2e suite is the acceptance bar (full `just e2e` green). New
  e2e: fresh game opens Game Config non-empty.
- **Sub-project 2** — Cargo tests as above. E2e: padlock toggles persist and
  survive reload; apply-template flow round-trips and the confirm dialog
  respects locks (the picker UI ships here).
- **Sub-project 3** — Vitest for state/reducers. New `math-plugin.spec.ts`
  covering the full contract: edit target → Generate → live Evolution frames →
  verdict + metrics → Apply → `slot_model_changed` reflected in Game Config.
  The tuner binary is real Rust and masterSeed-deterministic, so replay-tier
  runs need no new cassettes for it; direct GDD PUTs do not involve the LLM.
  All asserts on observable end-state, not dispatch.
- Frontend gates before every push: prettier check, typecheck, vitest, build.

## Out of scope

- Fine-grained (row/field-level) locks — section-level only; the `locks`
  object can grow keys later without a schema migration.
- Reworking how targets are derived (`derive_target` moves verbatim).
- Game-creation-flow UI changes (seeding happens in the store, not the
  create dialog).
- Homing target band / Rust-side `derive_target` (tracked separately as the
  analytics follow-up).
- Scene/presentation concerns beyond deleting the `reels_spin.py` fallback.

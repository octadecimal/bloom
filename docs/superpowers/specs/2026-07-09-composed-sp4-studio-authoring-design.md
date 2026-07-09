# Composed SP4 — Studio Authoring of `composed@1` Games

**Date:** 2026-07-09
**Status:** Approved design, pre-implementation
**Umbrella:** [2026-07-09-composed-games-mechanics-states-design.md](2026-07-09-composed-games-mechanics-states-design.md) (§8 sketches this sub-project)
**Prior sub-projects (all merged):** SP1 kernel (#170), SP2 package + server dispatch (#174), SP3 client trace playback (#175)

## 1. Goal

Let a studio user author and edit a `composed@1` `GameDefinition`, persist it
per game, build a signed playable `.pkg` from it, see informational math
metrics for what they built, and play it — without leaving the studio for a
terminal.

Today the only composed game is a hand-authored fixture
(`runtime/server/demo/composed.definition.json`) built by a justfile recipe
and served by a runtime server that loads exactly one package from an env
var. SP4 closes that loop: **author → persist → validate → build → play.**

## 2. Decisions made during brainstorm

| Question             | Decision                                                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authoring path       | New **Game Structure** plugin, pattern-cloned from `game-config`. The `game-config` editor stays slots@1; GDD/agent-driven composed authoring stays deferred per the umbrella spec.                                                   |
| Build→play           | Runtime server gains a **package-directory mode**; studio build writes into it; play surface selects by package id.                                                                                                                   |
| Curation gap (#172)  | **Informational metrics only** at build time (RTP, hit rate, max win, state visits). No verify gates, no freeze, no targets — #172 stays open, narrowed to gating/convergence.                                                        |
| Presentation         | Template-seeded blob stored beside the definition, editable only via the JSON escape hatch. Scene-derived presentation and per-state variants (#176) are follow-ups.                                                                  |
| Client follow-ups    | #176 (per-state presentation variants) and #177 (playback speed) both out of scope.                                                                                                                                                   |
| reels@1 inner config | Structured forms cover composition-relevant fields only; the math arrays (strips/symbols/paylines/paytable) are a JSON subsection. Visual reels editing on composed is a follow-up (game-config convergence, already the filed todo). |
| Validation           | Rust-authoritative only — the kernel's `composed::compile` via a subprocess. No TypeScript mirror of the rules.                                                                                                                       |

## 3. Architecture

```
studio frontend                studio backend               Rust
┌──────────────────┐  REST     ┌──────────────────┐  stdin  ┌──────────────────┐
│ game-structure    │────────▶│ app/compose       │────────▶│ compose_json bin  │
│ plugin            │  socket  │ store + router    │  json   │ (bloom-simulator) │
│ (4 sections)      │◀────────│ Mongo:            │◀────────│ validate │ build  │
└──────────────────┘          │ game_definitions  │ metrics │ + pool metrics    │
                               └────────┬─────────┘         └────────┬─────────┘
                                        │ writes                      │ writes
                                        ▼                             ▼
                               var/packages/<game_id>.pkg  ◀──────────┘
                                        │ reads (lazy, mtime-checked)
                                        ▼
                               runtime server (BLOOM_RUNTIME_PACKAGES dir mode)
                                        ▲ /handshake?package=  /spin{package}
                               runtime client play surface (?package=<game_id>)
```

## 4. Persistence — `app/compose`, Mongo `game_definitions`

New small backend module cloning the proven `slot_models` spine
(`app/math/store.py` pattern):

- Collection **`game_definitions`**, unique index on `game_id`. Doc:
  `{game_id, definition, presentation, updated_at}`.
  - `definition`: the `composed@1` `GameDefinition` JSON (same shape the
    kernel compiles — see `runtime/server/demo/composed.definition.json`).
  - `presentation`: the runtime presentation blob embedded verbatim into the
    built package.
- `GET /games/{id}/game-definition` — **get-or-seed**: first read seeds the
  doc from a checked-in template module (the demo definition + demo
  presentation, lifted into `app/compose/templates.py`). Never seeds `{}`.
- `PUT /games/{id}/game-definition` — partial patch
  `{definition?, presentation?, source}`. The store's `put` is the single
  choke point that emits a **`game_definition_changed`** socket event
  (wired in `app/main.py` exactly like `slot_model_changed`), carrying
  `source` and `updated_at` so open panes watermark-rehydrate.
- **No section locks.** Nothing automated (GA, templates) mutates composed
  definitions yet; locks are speculative here.

## 5. Rust `compose_json` bin (crate `bloom-simulator`)

Mirrors the `curate_json` stdin/stdout pattern:

- **Input (stdin, JSON):**
  `{definition, presentation, package_id, seed_count, master_seed, out_path, validate_only}`.
  Defaults: `seed_count` 10000; `master_seed` supplied by the backend
  (deterministic per game id so rebuilds are reproducible).
- **Validate-only** → `{ok: false, errors: [DefinitionError…]}` or
  `{ok: true}`. Errors are the kernel's own (`composed::compile`), serialized
  with enough structure for the UI to list them (message plus offending
  id/path where the kernel provides one).
- **Full build** → `build_composed_package` (SP2) writes the signed pkg to
  `out_path`, then evaluates **every seed in the pool** through the kernel
  evaluator and reports informational metrics on stdout:
  `{ok: true, metrics: {rtp, hit_rate, max_win_x, state_visits}}`.
  - `rtp` = total payout over the pool ÷ (spins × unit bet), same unit
    conventions as the kernel golden vectors. `hit_rate` = share of rounds
    with any payout; `max_win_x` = largest single-round payout in bet
    multiples.
  - `state_visits` = per-state-id enter counts across the pool (from
    `state_enter` trace entries) — cheap and genuinely useful for a
    transitions author ("does fs2 ever trigger?").
- Dev signing key stays the fixed `[7u8;32]` the compose CLI uses.
- The existing `compose` CLI and `composed-demo-pkg` recipe remain untouched.

## 6. Backend endpoints (`app/compose/rest.py`)

- `POST /games/{id}/game-definition/validate` — synchronous, fast; runs
  `compose_json --validate` on the stored (or request-supplied) definition;
  returns `{ok, errors}`. The plugin calls this **debounced on edit** for
  inline validation.
- `POST /games/{id}/game-definition/build` — **synchronous** (a 10k-seed
  build takes seconds; no 202/socket dance): validates, writes
  `var/packages/{game_id}.pkg`, returns `{ok, errors?, metrics?, package_id}`.
  `var/` is per-checkout, so worktrees isolate for free.
- The subprocess call sits behind the same runner seam the curation runner
  uses, so Python unit tests mock it.

## 7. Runtime server — package-directory mode

- New env var **`BLOOM_RUNTIME_PACKAGES=<dir>`**. When set, it takes
  precedence over `BLOOM_RUNTIME_PACKAGE` (which stays the prod-shaped
  single-package default and behaves exactly as today).
- **Lazy load + cache:** first request naming a package id resolves
  `<dir>/<id>.pkg`, runs `verify_and_load` + family dispatch/compile, and
  caches the `LoadedGame` in a `RwLock<HashMap<String, …>>`.
- **Selection:** `GET /handshake?package=<id>`; `SpinRequest` gains a
  `package: Option<String>` field. In dir mode the parameter is **required**
  (400 without it); in single-package mode it is ignored.
- **Staleness:** handshake stats the file's mtime and reloads if the studio
  rebuilt it since caching; `/spin` always uses the cache (a play session
  keeps its package until the next handshake).
- Unknown id, bad signature, or unknown family → 4xx/5xx with a loud error,
  never a fallback package. Audit lines carry the package id as they do now.

## 8. Studio plugin — `game-structure`

Pattern-clone of `studio/frontend/src/plugins/game-config/`: hookstate slice,
`openGameStructure` hydrate action, 600 ms debounced partial `PUT` with
`source: 'editor'`, watermark rehydrate on external `game_definition_changed`,
sync pill, CommittedInput/Stepper component reuse, and a whole-doc JSON
escape hatch. Four sections:

### Mechanics

- Instance list: add (from the catalog: `reels@1`, `meter@1`), remove,
  rename `id`.
- `meter@1`: full typed form — `target`, `count_symbol`, `reset_on_full`.
- `reels@1`: typed form for **composition-relevant** fields only — `rows`
  and the `events` table (`symbol`, `min_count`, `emit`), because the `emit`
  strings are the seam transitions bind to. The math arrays —
  `strips`, `symbols`, `paylines`, `paytable` — render as a **JSON
  subsection** inside the mechanic card (parse-validated, Apply-gated, same
  UX as game-config's JSON tab).
- Action vocabulary per mechanic type is a hardcoded map
  (`reels@1 → spin`, `meter@1 → accumulate`); a registry is YAGNI until
  mechanic #3 exists.

### States

Per-state card:

- **Bindings:** mechanic-instance picker + free-form per-binding `override`
  JSON micro-editor (override shape is mechanic-defined and open-ended).
- **Steps budget:** `number`, or `"awarded"` with `initial`.
- **Script:** ordered list of `invoke` steps, each picked from the actions of
  that state's bound instances.

### Transitions

- The declarative table: `from` (state picker), `on` (event picker — options
  derived from what the configured mechanics can emit: every `events[].emit`
  string plus `meter:full`), then `to` (state picker) **or** `effect`
  (`steps:add:N` with a numeric input).
- Also here: `start` state picker and `caps.max_steps`.
- Kernel validation errors (from the debounced validate endpoint) render in
  an inline strip; there is deliberately **no** TS re-implementation of the
  validation rules.

### JSON

Whole-doc escape hatch (definition + presentation), identical UX to
game-config's: textarea draft, parse → normalize → apply, error on failure.
This is also the **only** editor for the presentation blob this slice.

### Build & Play toolbar

- Validation pill (ok / N errors / checking).
- **Build** → `POST …/build`; on success render the metrics panel: RTP,
  hit rate, max win, per-state visit counts.
- **Play** (enabled after a successful build) → opens the runtime play
  surface in a new tab with `?package=<game_id>`, host derived from the page
  hostname and the worktree port offset (LAN rule: never hardcode
  localhost); server URL flows through the existing `?server=`/hostname
  derivation in `runtimeServerUrl.ts`.

## 9. Testing

- **TDD units:** Python `app/compose` store/router with the subprocess
  runner mocked; Rust `compose_json` round-trip + metrics tests (build →
  verify_and_load → evaluate parity) and runtime-server dir-mode tests
  (lazy load, cache, mtime reload, required-param 400, unknown id);
  vitest for plugin reducers/normalizers and event-vocabulary derivation.
- **Playwright e2e (authoritative for client behavior):** the authoring
  flow — open the pane, edit the meter target, introduce a deliberate
  validation error and see it inline, fix it, Build, metrics appear, then
  Play: the runtime play surface handshakes the authored package and
  completes a spin (trace playback walks to `round:complete`).
  Runs against the replay backend; the build step shells real Rust exactly
  as curate already does under e2e. Per repo policy the suite runs locally
  (`just e2e`), not in CI.

## 10. Out of scope (explicit)

- #176 per-state presentation variants; #177 playback speed/turbo.
- Full curation for composed: verify gates, targets, pool freeze — **#172
  stays open**, narrowed to gating/convergence (informational metrics land
  here).
- Tuner / GA / simulator / analytics convergence on composed games.
- Section locks on the game-definition doc.
- GDD-driven or agent-driven composed authoring (umbrella spec defers the
  SoT-doctrine re-examination).
- Visual editing of reels strips/paylines/paytable inside composed
  (JSON subsection only; convergence with game-config is the filed todo).
- Scene-derived presentation; presentation forms of any kind.
- Multi-package **prod** story: dir mode is a dev/studio affordance;
  single-package env-var deployment remains the canonical prod shape.

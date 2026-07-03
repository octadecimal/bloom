# Math Analytics Dashboard — Design

**Date:** 2026-07-02
**Status:** Approved design, not yet built
**Scope:** One spec → one phased implementation plan (3 phases)

## Motivation

The math stack (`bloom-math` kernel, `bloom-simulator` curation, `bloom-tuner`
genetic optimizer, plus their studio panes) can generate, tune, and curate a
slot model — but the process and the resulting math are opaque. The tuner streams
only the _best_ individual per generation; the simulator emits only scalar
metrics (`rtp`, `volatility`, `hit_frequency`, …). There is no way to _see_ how
the GA converged, or what the final math's payout distribution actually looks
like.

This project adds a **Math Analytics dashboard** — a studio plugin that
visualizes both **how the math was found** (GA evolution) and **what the math
is** (volatility curve, tail risk), with a persisted **history** for comparing
runs. It must be **impressive for demos** and **genuinely useful** for tuning.

## Goals

- Visualize the **genetic algorithm's evolution** — population convergence, gene
  agreement, RTP/volatility homing — both **live during a tune** and **post-hoc**.
- Visualize the **final generated math** — a true **win-distribution / volatility
  curve**, tail-risk metrics, RTP composition, and sampling convergence.
- Keep a **persisted history of past tunes** and let the user **compare runs**.
- Provide an **exportable report** surface (the "hand to a stakeholder" view).
- Comply with the studio **design language** and TDD / e2e discipline.

## Non-goals

- Editing or applying models from this plugin — it is **read-only analytics**.
  (Tuning is initiated from the existing tuner pane / agent; applying stays there.)
- Changing the GA algorithm itself, the kernel math, or the curation contract —
  we only **emit richer telemetry** from them.
- Persisting per-generation live frames or raw per-individual / per-round data.
  We persist **summaries** (binned/quantized), not raw populations or spins.

## User-facing shape — the dashboard

A new Dockview pane, `math-analytics`, mirroring the existing `tuner` / `simulator`
plugins. **Cockpit shell:** a persistent header strip (run selector, verdict
badge, headline stat tiles) over four tabs. **Every tab fills the pane exactly
with no inner scroll, except Report, which scrolls by design.**

### Tab 1 — Evolution (live + post-hoc)

The GA story. Watched live as a tune runs; re-opened later to inspect.

1. **Fitness landscape** (hero) — best-of-generation fitness line over a shaded
   **population spread band** (min–max + interquartile), with live candidate dots
   and a current-generation playhead. The band narrowing is the live "money shot".
2. **RTP homing** — best RTP curving into its target band.
3. **Volatility homing** — best volatility curving into its band.
4. **Gene-convergence heatmap** — one row per tunable gene dimension, color =
   population agreement on that gene, warming as generations lock in.
5. **Generation scrubber** — replay the run frame-by-frame; drives the live playhead.

### Tab 2 — Math Profile (post-hoc)

The final, settled model.

1. **Win distribution — the volatility curve** (hero) — histogram of per-round
   payout on a **log-multiplier x-axis**, segmented base → feature → rare tail.
2. **Tail & risk** stat tiles — max win, P(win ≥ 100×), % losing spins,
   bonus-trigger rate, longest dead streak, realized-vs-target drift.
3. **RTP composition** — base vs feature split, realized vs target, house edge.
4. **Hit-rate by payout band** — probability mass per multiplier bucket.
5. **RTP convergence** — realized RTP settling onto target as the sample grows,
   with a narrowing confidence band (the "trust the math" chart).

### Tab 3 — Compare

Cross-run analysis over persisted history. Select N runs (color-coded chips);
see **overlaid RTP-convergence curves**, **overlaid volatility curves**, and a
**delta table** (RTP, volatility, hit freq, max win, generations-to-converge,
verdict) — one column per run.

### Tab 4 — Report

The one intentional scroll surface. Every chart stacked top-to-bottom into a
single document — summary, GA evolution, gene convergence, win distribution,
tail/risk, RTP convergence, and the **config used** — with **Export PDF/PNG**.

## Architecture

Three layers. Each has a well-defined interface so it can be understood and
tested independently.

### Layer 1 — Rust telemetry (the enabling work)

Two crates emit richer data. **Summaries only** — no raw populations or spins.

**`bloom-tuner`** — enrich the per-generation snapshot (both the live progress
line _and_ the persisted trace) beyond best-only:

- fitness `min` / `mean` / `q1` / `median` / `q3` / `max` across the population,
- a scalar **diversity** measure (e.g. normalized population fitness spread or
  mean pairwise gene distance),
- **per-gene agreement** for each tunable gene dimension (payout, spins,
  multiplier, min-count …) — a 0–1 concentration/consensus scalar for the heatmap.

**`bloom-simulator`** — add a **profiling API** over the outcome stream it already
consumes to compute volatility, returning:

- a **win-distribution histogram** — counts per binned payout-multiplier bucket
  (log-spaced bins; base vs feature attribution),
- **tail metrics** — max win, P(win ≥ threshold), P(losing spin), longest
  dead streak, bonus-trigger rate,
- a **RTP-convergence series** — realized RTP vs cumulative sample size (downsampled).

**Profiling runs in-process at end-of-tune.** After the GA settles, `bloom-tuner`
calls the `bloom-simulator` profiling API on the winning model (it already depends
on the kernel) — **no second subprocess**. `tune_json`'s result line gains a
`profile` block alongside the enriched `trace`. Every tune run is thus
**self-contained**: Evolution + Math Profile from one record, independent of
whether the model is later curated into a `.pkg`.

**Wire additions (NDJSON, camelCase):**

- `progress` line gains: `fitnessMin/Mean/Q1/Median/Q3/Max`, `diversity`,
  `geneAgreement` (map or ordered array of gene → 0–1).
- `result` line gains: `profile: { histogram: [{binLo, binHi, base, feature}],
tail: { maxWin, pGE100x, pLosingSpin, longestDeadStreak, bonusTriggerRate },
rtpConvergence: [{ n, realizedRtp }] }`, and the per-gen `trace` entries carry
  the same enriched fields as `progress`.

### Layer 2 — Backend persistence + streaming (`app/analytics`)

- **`math_runs` collection — append-only.** One document per completed tune run:
  `{ id, game_id, params, verdict, metrics, trace[], profile, tail,
rtp_convergence, timings, created_at }`. Indexed on `(game_id, created_at)`.
  History and Compare read this collection; a run is **never overwritten**.
  (The existing `tuner_jobs` doc remains the "current params / latest result"
  pointer for the tuner pane; `math_runs` is the historical archive.)
- **`AnalyticsHub`** reuses the existing socket-room pattern
  (`join_analytics` / `leave_analytics`, room = `game_id`). It relays the
  **enriched live progress** during a tune and, on completion, **appends the
  frozen run doc** and emits a `run_complete` event.
- **Live is ephemeral; the doc is the post-hoc source.** Per-generation frames
  are streamed but not persisted individually (matches current tuner behavior).
  Reloading mid-tune yields the socket stream from that point; the full run is
  available once frozen.
- **REST**: `GET /analytics/runs?game_id=…` (history list, newest first, capped
  page), `GET /analytics/runs/{id}` (one run's full doc).
- **Retention**: unbounded initially, ordered by `created_at`; an optional
  per-game cap (keep last N) is a later refinement, not in scope now.

The tuner's existing run path (`TunerHub.request_tune`) is extended (or a sibling
path added) so a tune emits enriched progress and, on completion, writes to
`math_runs`. The tuner's own `tuning_complete` contract is preserved.

### Layer 3 — Frontend plugin (`math-analytics`)

- New pane under `studio/frontend/src/plugins/math-analytics/`, registered like
  the other plugins. Live-subscribes via the analytics socket during a tune;
  reads REST history for the run selector, Compare, and Report.
- **Cockpit shell** with the four fill-to-pane tabs above. The fit rule: header /
  tabs / scrubber take natural height; the chart region is a CSS grid consuming
  all remaining space; charts stretch to their cells. Report is the scroll
  exception.
- **Charting via an `IChart` seam** (per coding standards, `I`-prefixed
  interface). Behind the seam:
  - **uPlot** for streaming time-series (fitness landscape + spread band, RTP/vol
    homing, RTP convergence, Compare overlays) — tiny and fast under live updates.
  - **Hand-rolled SVG / CSS** for the bespoke marks (gene-convergence heatmap,
    win-distribution histogram, stat tiles) — full design-language control.
    The seam keeps the library swappable (see the repo's "prefer proven libraries
    behind a thin seam" principle) and lets tests target a stable interface.
- **Design language**: 4 surfaces / 2 hairlines / 3 text tiers / rationed accent;
  raw colors only via `styles.css` (the guard test blocks otherwise). Chart color
  roles (base / feature / tail / target-band / per-run series) are defined as
  tokens there.

## Data-size discipline

Everything persisted or streamed is a **summary**:

- GA telemetry = per-generation quantiles + scalars (not the population).
- Win distribution = fixed-bin histogram (not per-round payouts).
- RTP convergence = downsampled series (not per-spin cumulative).

This keeps live frames small enough to stream smoothly and `math_runs` docs
small enough to store per tune indefinitely.

## Testing strategy

- **TDD (mandatory).** Rust: unit tests for the new telemetry math (quantiles,
  diversity, gene agreement, histogram binning, tail metrics) with known-input
  golden vectors; NDJSON shape tests for the enriched `progress` / `result`
  lines (mirroring the existing `tune_json` / `curate_json` line tests).
  Backend: unit tests for `math_runs` append/read, the hub's live relay, and REST
  serialization (camelCase wire). Frontend: unit tests for chart-data transforms
  and the `IChart` seam adapters.
- **Playwright e2e is the behavioral contract** and must be exhaustive: drive a
  tune against the **replay backend**, assert the Evolution tab renders live
  progress and freezes, the Math Profile renders the volatility curve + tail
  tiles, Compare overlays multiple seeded runs, and Report scrolls + exports.
  Assert **observable end-state** (charts reflect persisted `math_runs`), never
  just that an event was dispatched. Not run in CI (browser e2e is local-only);
  Rust + backend unit/non-browser suites are CI-affordable.
- **Replay fixtures**: seed `math_runs` and a recorded enriched tune stream so the
  dashboard is deterministic offline; refresh from live when the wire changes.

## Phasing (one plan, three phases)

1. **Backbone + post-hoc Math Profile.** Rust telemetry (both crates) + end-of-tune
   profiling + `math_runs` persistence + REST. Frontend: the Math Profile tab
   reading a persisted run. Proves the enabling work end-to-end.
2. **Live Evolution.** Enriched live progress relay + the Evolution tab (fitness
   landscape, homing, gene heatmap, scrubber) subscribing to the socket.
3. **Compare + Report.** Run selector over history, Compare overlays + delta
   table, Report scroll + Export PDF/PNG.

## Decisions locked (from brainstorming)

- **Ambition:** full telemetry across all three layers (not dashboard-only).
- **Mode:** live streaming _and_ post-hoc, with persisted run history for compare.
- **Shell:** cockpit with tabs; one tab (**Report**) is the full single-scroll view.
- **Fit:** every tab fills the pane with no inner scroll, except Report.
- **Profile source:** end-of-tune profiling simulation (self-contained run doc).
- **Charting:** uPlot for streaming + hand-rolled SVG/CSS for bespoke, behind an
  `IChart` seam.
- **Scope:** one spec, one phased plan.

## Risks / open questions

- **Diversity metric definition** — fitness-spread vs mean pairwise gene distance;
  pick one in Phase 1 and pin it with a golden vector. Low risk (internal, swappable).
- **Histogram binning** — bin count / log-base affect the curve's readability;
  choose defaults in Phase 1, expose as constants. Low risk.
- **End-of-tune profiling cost** — one extra high-fidelity simulation per tune;
  bounded by the same watchdog as curation. Acceptable; profile fidelity is a tunable.
- **PDF/PNG export** (Phase 3) — client-side export of the Report DOM; library
  choice deferred to that phase, behind the same "proven library" principle.

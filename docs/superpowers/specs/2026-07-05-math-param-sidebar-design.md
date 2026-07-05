# Math Param Sidebar — design

**Date:** 2026-07-05
**Status:** approved (brainstormed with user)
**Scope:** `studio/frontend` only — no backend, wire, or Rust changes.

## Problem

The Math pane's "Advanced" section (`plugins/math/components/AdvancedSection.tsx`)
is a cramped bottom strip: a text-link toggle revealing 11 bare, flex-wrapped
number inputs with terse labels (`rtp tol`, `corr band`) and no explanation of
what any field does. Four GA knobs that already ride the wire (`elitism`,
`crossoverRate`, `stagnationWindow`, the fitness `weights`) aren't exposed at
all. A known gotcha compounds it: a typo'd value silently persists via the
PUT-before-Verify flow (see math-consolidation notes).

## Goal

Promote the params to a first-class, toggle-able right sidebar inside the Math
pane — premium per the studio design language — where every field has a rich
hover tooltip explaining what it does, sensible validation, units/formatting,
reset-to-default, and design-language-styled stepper buttons.

## Decisions (user-confirmed)

- **Layout:** inline right sidebar (~240px) inside the Math pane; content
  reflows narrower while open (charts are resize-aware since PR #149).
- **Toggle:** ghost icon button (sliders icon) at the far right of the Math
  header row, `aria-pressed`; open/closed persists in `localStorage`
  (`bloom.math.sidebar`); default closed.
- **Tooltips:** hover anywhere on the label row (subtle ⓘ hint icon); ~300ms
  delay; rich card = field name + 1–2 sentence explanation + practical effect
  - default value. Keyboard-focusable (a11y).
- **Field scope:** ALL knobs — the 11 current fields plus elitism, crossover
  rate, stagnation window, and the 3 fitness weights (~18 fields).
- **Enrichments:** section groups, reset-to-default, validation guardrails,
  units & formatting, custom stepper buttons matching the app.
- **Approach:** Radix tooltip + config-driven field registry (approach A).
  Rejected: hand-rolled tooltip (positioning/a11y reinvention), slice-persisted
  visibility (UI preference, not game data).

## Architecture

```
MathPane
├── header row ················ + sidebar toggle button (ghost icon, right)
├── <flex-row>
│   ├── existing vertical stack (TargetStrip, GenerateBar, tabs, content,
│   │   ResultStrip) — unchanged, shrinks when sidebar open
│   └── ParamSidebar (when open) — hairline-separated right column
└── (AdvancedSection deleted)
```

New files:

| File                                       | Purpose                                                                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/ui/tooltip.tsx`                | shadcn-style wrapper over **new dep `@radix-ui/react-tooltip`**, token-styled (`--raised` bg, hairline border, text tiers), portal so it never clips at the Dockview card edge. Reusable app-wide.        |
| `plugins/math/components/paramFields.ts`   | The field registry: one entry per param — `key`, `label`, `group`, `tooltip` copy, `unit`, `min`/`max`/`step`, `default`, and slice get/set accessors (accessor functions handle the nested `weights.*`). |
| `plugins/math/components/ParamField.tsx`   | Renders one registry row: label + ⓘ + tooltip, number input with custom chevron steppers, validation state, unfocused formatting.                                                                         |
| `plugins/math/components/ParamSidebar.tsx` | Maps the registry grouped by section; group headers (uppercase `text-2`) with per-group reset; owns the `localStorage` visibility hook (exported so MathPane's toggle shares it).                         |

Deleted: `AdvancedSection.tsx` (+ its spec, superseded by the new specs).

## Data flow (unchanged)

Edits write the hookstate slice (`tunerParams` / `curationParams`) exactly as
today; `actions.ts#generateMath` / `verifyMath` PUT the params wholesale before
running. Exposing the 4 hidden GA knobs needs zero backend work — they're
already in `ITuningParams` and already ride the PUT. Reset writes backend
defaults into the slice and persists through the same flow.

## Field registry

Groups and defaults (defaults mirror `default_tuning_params()` /
`default_params()` in `studio/backend/app/math/models.py` — lockstep comment on
both sides; tooltips display "Default: N"):

### Tuner

| Field                  | Label        | Default | Constraints   | Unit        | Tooltip essence                                                                                     |
| ---------------------- | ------------ | ------- | ------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `masterSeed`           | Seed         | 2026    | int           | —           | Seeds the GA's RNG. Same seed + same params → identical run (reproducibility).                      |
| `population`           | Population   | 24      | int ≥ 2       | candidates  | Candidates per generation. Higher = broader search per generation, slower.                          |
| `maxGenerations`       | Generations  | 40      | int ≥ 1       | —           | GA budget; stops earlier when feasible or stagnated.                                                |
| `searchCandidateCount` | Search spins | 20,000  | int ≥ 1,000   | spins       | Spins measuring each candidate during search (low fidelity). Higher = less noise, slower.           |
| `finalCandidateCount`  | Final spins  | 200,000 | int ≥ 10,000  | spins       | Spins for the trusted final-fidelity confirmation of the best candidate.                            |
| `elitism`              | Elitism      | 2       | int ≥ 0       | candidates  | Best candidates copied unchanged into the next generation; guards against losing the best solution. |
| `mutationRate`         | Mutation     | 0.25    | 0–1, step .05 | fraction    | Chance a gene mutates during breeding. Higher = more exploration, less stability.                   |
| `crossoverRate`        | Crossover    | 0.9     | 0–1, step .05 | fraction    | Chance two parents mix genes (vs cloning).                                                          |
| `stagnationWindow`     | Stagnation   | 12      | int ≥ 1       | generations | Generations without improvement before the GA stops early.                                          |

### Fitness weights

| Field                | Label      | Default | Constraints  | Tooltip essence                                                                    |
| -------------------- | ---------- | ------- | ------------ | ---------------------------------------------------------------------------------- |
| `weights.rtp`        | RTP        | 1.0     | ≥ 0, step .1 | Relative importance of RTP error in fitness; higher = GA prioritizes matching RTP. |
| `weights.volatility` | Volatility | 1.0     | ≥ 0, step .1 | Relative importance of volatility error.                                           |
| `weights.hitRate`    | Hit rate   | 1.0     | ≥ 0, step .1 | Relative importance of bonus hit-rate error.                                       |

### Curation

| Field                    | Label           | Default | Constraints    | Unit     | Tooltip essence                                                                                                                         |
| ------------------------ | --------------- | ------- | -------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `poolSize`               | Pool size       | 1,000   | int ≥ 100      | outcomes | Outcomes frozen into the signed pool the game server draws from.                                                                        |
| `candidateCount`         | Candidates      | 50,000  | int ≥ 1,000    | spins    | Spins simulated to measure the model during verification.                                                                               |
| `masterSeed`             | Sim seed        | 2026    | int            | —        | Seeds the verification simulation (reproducibility).                                                                                    |
| `rtpTolerance`           | RTP tolerance   | 0.01    | > 0, step .005 | fraction | Allowed absolute deviation of measured RTP from target (0.01 = ±1%).                                                                    |
| `realizedCorrectionBand` | Correction band | 0.05    | > 0, step .01  | fraction | Honesty guardrail: curation may only correct the pool toward a target within this band of the model's measured RTP; otherwise it fails. |
| `bonusRateTolerance`     | Bonus tolerance | 0.25    | > 0, step .05  | fraction | Relative ± band around the GDD bonus hit rate during verification.                                                                      |

Final tooltip prose is authored in the registry at implementation time from the
essences above (title + explanation + practical effect + default) — the table
is the authoritative content outline.

## Behavior

- **Validation:** clamp to min/max/step on blur. While typing, out-of-range or
  non-numeric shows a `--danger` border and the value does NOT land in the
  slice until valid — a half-typed value can never ride an in-flight PUT
  (fixes the persisted-typo gotcha).
- **Formatting:** unfocused large counts show thousands separators
  (`200,000`); focused shows the raw editable number. Fraction-natured fields
  stay as the raw fractions the wire expects — no % conversion in the input
  (avoids the double-normalization bug class); the unit hint + tooltip explain
  the scale.
- **Steppers:** shared chevron-up/down buttons at the field's right edge,
  hairline-separated, `--raised-hover` hover, stepping by `step`, respecting
  clamps; native spinners hidden via CSS.
- **Reset:** per-group reset affordance in each section header writes that
  group's defaults into the slice.
- **Design language:** inputs are `--raised` wells, hairline borders, accent
  focus ring; labels uppercase `text-2`; no new colors (guard spec enforces).
- **Testids:** keep `advanced-toggle` (now the header icon), `advanced-params`
  (sidebar body), `param-master-seed`, `param-pool-size` so existing e2e keeps
  passing; new fields get `param-*` testids.

## Testing

Unit (TDD, vitest):

- `paramFields.spec.ts` — registry completeness (every `ITuningParams` /
  `ICurationParams` field covered), tooltip copy non-empty, defaults match the
  backend values.
- `ParamField.spec.tsx` — clamp on blur, invalid state doesn't write the
  slice, stepper clicks step+clamp, unfocused formatting.
- `ParamSidebar.spec.tsx` — toggle + localStorage persistence, groups render,
  per-group reset restores defaults.
- `tooltip.spec.tsx` — opens on hover and keyboard focus, renders content.
- `MathPane.spec.tsx` — updated for the moved toggle/sidebar placement.

E2e (Playwright, replay backend, local): extend the math pane spec — open the
sidebar, hover a label → tooltip text visible; edit a param → Generate →
assert the edited value persisted (observable end-state, per repo convention).

Gates: prettier + typecheck + vitest + build; design-language guard spec; `just
e2e` before PR.

## Error handling

Unchanged — the sidebar only writes the slice; all network behavior stays in
existing `actions.ts`. Validation is the only new failure surface and it is
local (invalid input never leaves the component).

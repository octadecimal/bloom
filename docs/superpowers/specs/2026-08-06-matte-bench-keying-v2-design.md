# Matte Bench — Keying v2 and Class B Original Truthfulness — Design

**Date:** 2026-08-06
**Status:** Approved (autonomous session; decisions documented for operator review)
**Builds on:** [2026-08-05-matte-bench-class-b-design.md](2026-08-05-matte-bench-class-b-design.md)

## Problem

PR #229 made Class B backdrop-key masking real. Judging every bucket live
afterwards (13 verdicts across wispy, glow-soft, filigree, crisp-text,
low-contrast) surfaced three follow-ups:

1. **Light-bloom halo.** Flux paints a luminance gradient behind subjects
   even when the clause asks for a flat backdrop. The keyer compares every
   pixel to ONE global color (the border median), so backdrop regions that
   have drifted from the border color — vignettes, glows, soft ground
   shadows — survive as semi-opaque slabs. Observed live: a lavender slab in
   `wispy-1578148740` (magenta side), bloom washes in `filigree-931261850`
   (both sides), a retained ground shadow in `crisp-text-938842772` (green
   side).

2. **Keying through the subject.** The same global rule has no notion of
   _where_ the backdrop is, so subject pixels whose color happens to sit
   near the border median are keyed out of the subject's own body. Observed
   live, and worse than the halo in practice: the glow-soft glass orb
   half-erased, the crisp-text letter faces punched through, the
   low-contrast heart's face eroded — all on the magenta side, with milder
   smudging on green in low-contrast.

3. **The "original" toggle lies in Class B.** Pressing `o` shows the
   subject's _plate_ on both panels with the notice "showing ORIGINAL — same
   source for both sides". For Class B that is false twice over: neither
   side was cut from the plate, and the two sides are _different
   generations_ (same seed, different prompt — the clause is part of the
   technique). This is the confusion the operator reported: the two
   "originals" they saw were not the images either side was actually keyed
   from.

Per-side differing art in Class B is **by design** (the class exists to
compare how the image is made; the prior spec explicitly accepts that B/X
sides "visibly differ in art"). The defect is only that the UI _presents_ a
shared original that does not exist.

## Goal

One branch, three coherent pieces:

1. **Keying v2** — replace the single global color test with a
   border-connected region grow that tolerates smooth gradients (kills the
   halo) and cannot jump sharp edges into the subject (kills the erosion),
   plus an enclosed-hole pass so the enclosed-holes bucket still works.
2. **Clause hardening** — extend both backdrop clauses with anti-vignette
   wording so flux paints less halo to begin with. Rides the same
   config-hash bump as (1); one re-render, not two.
3. **Original truthfulness** — cache each backdrop render's pre-key
   generation and serve it per side; scope the "same source" notice to
   Class A, where it is true.

## Non-goals

- No Qwen work (still weight-gated; not installed on the box).
- No redesign of Class B toward shared-pixel sides — impossible for
  backdrop-vs-native comparisons and contrary to the approved class design.
- No numpy or other new dependencies: keying stays pure PIL + stdlib,
  deterministic, GPU-free.
- No ranking/schema changes. Retired identities keep their logged verdicts,
  exactly like the #229 retirement.

## Design

### Keying v2: border-connected region grow

`chroma_key` (a pure function in `keying.py`) is replaced by a
connectivity-aware keyer with this behavioral contract:

- **Seed.** Border pixels within `seed_tolerance` of the border median
  (`sample_key_color`, unchanged) are backdrop.
- **Grow.** BFS from the seed: a 4-neighbor joins the backdrop when its
  color is within `step_tolerance` of the neighbor it grew from. Smooth
  gradients (halo, vignette, soft shadow) pass step by step; sharp
  subject edges block the walk. This is what makes the keyer
  gradient-tolerant _and_ unable to eat border-alike subject interiors:
  connectivity, not color alone, decides.
- **Enclosed holes.** After the grow, a not-yet-keyed pixel is also keyed
  when it sits within `hole_tolerance` (strict) of the color of the
  spatially nearest already-keyed pixel — this keeps the enclosed-holes
  bucket honest (a donut hole showing backdrop must still clear) without
  reopening global erosion; `hole_tolerance` is deliberately tighter than
  the old global tolerance, and the nearest-keyed anchor tracks backdrop
  drift better than the border median would mid-frame.
- **Soft edges.** Pixels adjacent to the keyed region get a linear alpha
  ramp over `softness` (color distance to their nearest keyed neighbor's
  color), preserving the wispy/fur edge quality the ramp existed for.
- **Despill** on visible pixels, unchanged.
- Deterministic, O(pixels), pure PIL/stdlib; seconds-scale at 768² is
  acceptable (paid once per render, cached).

Parameter set (recorded in `params`, so the change retires the current
hashes `552a60c75a287bb0`/`4bc8eba4d3cfc3d5` and forces re-render):
`key_source: "border-median"`, `seed_tolerance`, `step_tolerance`,
`envelope`, `hole_tolerance`, `softness`, `despill`.

**Amendment (2026-08-06, post-merge live verification):** the grow needs an
`envelope` cap — the maximum color distance from the key a grow-keyed pixel
may have. Without it, a soft drop shadow (a smooth backdrop→near-black ramp)
lets the step-chain walk into solid dark subjects and erase them: measured
live on crisp-text, letters at drift 246 from the key were grow-keyed
through their own shadows on an otherwise perfect chroma plate. Envelope 180
chosen from measured drift distributions: genuine halo/gradient backdrop
stays below ~180 in the verified buckets, while the erased subjects sat at
246+ (letters) and 254+ (glow-soft crystals). This retires the uncapped v2
hashes `736227dbf40b9b44`/`bc6bfa23c5a3d03f`. Exact values are calibrated during
implementation against the cached live corpus
(`var/matte-bench/renders/{wispy-1578148740,glow-soft-1750666863,filigree-931261850,crisp-text-938842772,low-contrast-25047655}` —
the raw generations are regenerated same-seed for calibration). Their
honest verdicts stay in the log; the retired identities simply stop being
served, as with #229.

### Clause hardening

Both `BACKDROP_VARIANTS` clauses gain anti-vignette wording, e.g.
"perfectly uniform color, no vignetting, no glow, no gradient, no light
bloom". Wording is finalized during implementation; it is part of `params`,
so it participates in the same hash bump as keying v2. The halo defense is
then layered: prompt reduces it, keyer tolerates what remains.

### Original truthfulness

- **Render.** The backdrop path in `render.py` writes the raw pre-key
  generation next to the keyed result as
  `renders/<subject>/<config_hash>.orig.png` (atomic write, same cache
  discipline). Class A and qwen-layered write no original: A's original IS
  the plate; qwen decodes straight to RGBA and has no pre-key image.
- **Serve.** New route `GET /original/{subject}/{technique}.png` with the
  same traversal guard as `/render/...`; 404 when no original exists.
- **UI.** The `o` toggle becomes per-class:
  - Class A: both panels show the plate; notice "showing ORIGINAL — same
    source for both sides" (now always true when shown).
  - Class B: each panel shows its own side's `/original/...`; notice
    "showing each side's OWN generation (pre-key) — sides differ by
    design". A side with no original (legacy cache, qwen) keeps its render
    and is dimmed.
  - Class X: the A side shows the plate, the B side its own original; the
    same per-side rule, notice "showing each side's own source".

### Testing

TDD throughout, in the bench's existing style (no Playwright, per the
repo-wide ruling):

- **Keying:** synthetic-image unit tests — flat backdrop fully keyed
  (regression); linear-gradient backdrop fully keyed (halo case); a
  border-colored patch _inside_ the subject, disconnected from the border,
  survives (erosion case); an enclosed hole matching adjacent backdrop is
  keyed (enclosed-holes case); sharp-edge subject untouched; soft-edge ramp
  present; despill behavior unchanged; determinism (same input → same
  bytes).
- **Techniques:** new params present; config hashes differ from the retired
  pair; a regression test pins the retirement of
  `552a60c75a287bb0`/`4bc8eba4d3cfc3d5` alongside the #229 pair.
- **Render:** backdrop path writes `.orig.png` beside the keyed render;
  Class A does not; cache behavior (no rewrite when both exist).
- **Web:** `/original/...` serves, 404s when absent, and rejects traversal;
  `TestClient` for all route changes.
- **Live verification** (operator's-seat rule from the #229 postmortem):
  restart the :8400 bench, confirm `/api/techniques` lists the new hashes,
  and judge at least one Class B comparison per bucket, checking halo,
  erosion, and the `o` toggle per class.

## Decisions made autonomously (for operator review)

- Chose connectivity-based keying over a pure "background field estimate"
  (border interpolation cannot model a mid-frame bloom) and over
  accept-as-weakness (the erosion failure mode makes magenta look
  non-viable for reasons that are our keyer's fault, not the technique
  concept's — the bench should measure a competent implementation).
- Bundled clause hardening into the same hash bump to avoid paying two
  re-render generations.
- Kept per-side differing originals as designed; fixed only the UI's false
  claim about them.

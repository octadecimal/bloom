# Matte Bench — design

**Date:** 2026-08-04
**Status:** design approved, implementation not started

A standalone, human-in-the-loop bench for finding which transparency-masking
techniques work best, and on what kind of image.

## Why

Every transparent asset in Bloom goes through one hard-coded matting config —
`BiRefNet-HR`, `refine_foreground: true`, `mask_blur: 0`, `mask_offset: 0`,
baked into `ai_slots_transparent.json` and `ai_slots_dev_transparent.json`. It
has never been varied or compared against an alternative.

Meanwhile the GPU box offers **15 matting models** across two nodes —
`BiRefNetRMBG` (general, 512x512, HR, portrait, matting, HR-matting, lite,
lite-2K, dynamic, lite-matting, toonout) and `RMBG` (RMBG-2.0, INSPYRENET, BEN,
BEN2) — plus `GrowMask`, `FeatherMask` and `ThresholdMask` as alpha
post-processing primitives.

Observed failures on a single generated reel frame, all attributable to matting:

- **leftover background** — foliage kept in the top-left corner,
- **subject erosion** — bites taken out of the bottom and right edges,
- **partial-alpha haze** — 21.9% of pixels neither opaque nor clear.

We have a large unexplored parameter space and concrete failures to test it
against, and no instrument for deciding between options. This is that
instrument.

## Goals

- Learn which techniques suit which **kinds of image**, generally.
- Accumulate verdicts into a standing leaderboard rather than one-off opinions.
- Produce failure-mode labels that could later train an automatic selector.

## Non-goals

- Automatically changing the pipeline. The bench measures; adoption is a
  separate, deliberate change.
- Ranking by product role. See below.
- Fixing generation quality. This is about the mask, not the art.

## Key decision: characteristics, not roles

Judging by product role (logo / reels / flourish) would bake in categories that
do not predict matting difficulty. Foliage and lettering fail differently
regardless of what the asset is called, and a "logo" may be crisp lettering or
soft glow depending on its art.

So the corpus is organised by **image characteristic**, and every ranking is
computed **per characteristic bucket**. A technique must lose _within_ a bucket
to be dropped from it — which also protects the model that is mediocre
everywhere except the one hard case where it is the only survivor.

## Architecture

`tools/matte-bench/` — a Python service serving one page, started with
`just matte-bench`, bound to `8400 + BLOOM_PORT_OFFSET`. Nothing in `studio/`
changes; nothing imports the bench.

**Total footprint outside `tools/matte-bench/`:** a `matte-bench` recipe in the
`justfile`, and a `var/matte-bench/` entry in `.gitignore`. That is the whole
blast radius.

It runs under the studio backend's venv and imports `LiveComfyProvider`,
`build_graph` and `get_settings` from `app.*`. This is deliberate coupling in
one direction only: the bench must exercise the **real** ComfyUI client and the
**real** graph builder, or we would be measuring a reimplementation and drawing
conclusions that do not transfer. It inherits `COMFYUI_URL` from the same
`.env`, so it targets the same GPU box with no second config to drift.

### Units

| Unit            | Responsibility                                                                  |
| --------------- | ------------------------------------------------------------------------------- |
| `corpus.py`     | Subject definitions; renders the raw pre-matting plate once per subject, cached |
| `techniques.py` | Registry: a technique is a name plus how it turns a plate into RGBA             |
| `render.py`     | Applies a technique to a plate; caches by `(subject, technique)`                |
| `pairing.py`    | Chooses the next comparison to serve (pure)                                     |
| `ranking.py`    | Verdicts to standings, per bucket (pure)                                        |
| `store.py`      | Manifest, verdict log, cache paths                                              |
| `web.py`        | Routes and the judging page                                                     |

`pairing` and `ranking` are pure functions over plain data: the parts most
likely to be wrong are the parts easiest to test, with no GPU in the loop.

### Reproducibility

The corpus commits **recipes** (prompt, seed, size, workflow), not PNGs. Plates
regenerate deterministically from a fixed seed into gitignored
`var/matte-bench/`. Git stays small and a fresh clone can rebuild the bench.

Determinism holds only while the ComfyUI and FLUX versions on the box stay put.
If they move, plates must be regenerated and affected verdicts marked stale —
never silently compared against pixels they were not cast on. See _Staleness_.

## Corpus

Six buckets, **sampled, not fixed**. A fixed corpus overfits: after a few
sessions the judge has memorized every image and every technique's quirks on
it. Instead each bucket carries a template bank (`templates.json` — prompt
patterns with randomized fragment pools), and the bench composes a fresh
prompt plus a fresh random seed per draw. A sampled subject serves
`PAIRS_PER_SUBJECT` comparisons (amortizing its plate generation), then a new
one is drawn from whichever bucket has the least evidence. Every draw is
registered append-only in `subjects-sampled.jsonl` — the recipe (prompt,
seed, size) that keeps its verdicts attributable and its plate regenerable.
Both sides of a comparison always mat the single plate its draw produced, so
left/right stay pixel-identical by construction.

**Subjects are generated in isolation, exactly as production prompts them.**
Every prompt composes like `build_asset_prompt`: subject description plus the
production cutout boilerplate from `recipes.py` (standard, logo, or reels
profile). Composed scene backdrops are banned: diffusion cannot be trusted to
keep scenery *behind* the subject — it bleeds foreground detail over it
(foliage across a reel frame), and occluded pixels are unrecoverable by any
matting technique, so such plates measure generation failure instead of
matting quality. Difficulty must come from the subject itself.

| Bucket           | What makes it hard                                    | Seeded with                              |
| ---------------- | ----------------------------------------------------- | ---------------------------------------- |
| `wispy`          | Fine semi-transparent fringes                         | Ferns, trailing vines, fur-like edges    |
| `filigree`       | Thin rigid structures that break when eroded          | Metal scrollwork, lattice, ornate frames |
| `enclosed-holes` | Interior negative space — must clear, or must not     | Rings, arcades, the production reel frame |
| `glow-soft`      | Partial alpha is _correct_ here                       | Glass, bloom, smoke, translucency        |
| `crisp-text`     | Hard edges; halo and erosion are glaring              | Lettering, wordmarks                     |
| `low-contrast`   | Subject tone near the plain ground it is cut out on   | Green subject on plain green ground      |

`enclosed-holes` carries three subjects: the third is the production reel
frame itself — the pipeline's paramount transparent asset, prompted with the
`reels` profile boilerplate verbatim.

The registry is **append-only**: a subject's recipe never changes once judged,
and a real asset that fails in the studio can still be promoted into the bench
as a hand-written registry entry without invalidating existing verdicts.

## Techniques

### Class A — same pixels

All variants run over **one cached plate per subject**, so every technique is
judged on byte-identical art and the comparison isolates the mask. Staged,
because the full grid is roughly 200 combinations per subject:

1. **Models.** 15 models at default params. The big unknown, cheapest to
   resolve.
2. **Params.** Sweep `refine_foreground`, `mask_blur`, `mask_offset` on each
   bucket's top 3 only.
3. **Alpha post-ops.** `ThresholdMask`, `GrowMask`/`FeatherMask`, plus two of
   our own: **despeckle** (drop alpha islands below a threshold, expressed as a
   fraction of image area so it scales with resolution) and **hole-fill**. Each
   post-op is registered at two or three settings and ranked like any other
   technique — they are not tuned by hand.

Stage 3 matters more than it looks. The leftover fleck that misaligned the reel
cut is not a model failure — despeckle removes it whatever model wins. Some
defects are cheaper to fix after the mask than by choosing a better one, and
staging separates those two questions.

### Class B — different pixels

Techniques that change how the image is made: prompting for a flat contrasting
backdrop to key against, and native-RGBA generation (the box exposes
`EmptyQwenImageLayeredLatentImage`; weights unconfirmed).

These are **ranked as their own category and never pooled with Class A**. They
change the art as well as the alpha — a different base model may give flawless
alpha and worse composition — so a verdict conflates two judgments. Pooling
them would corrupt the leaderboard.

Class B is in the schema from day one but implemented after Class A, which
needs no new weights and gives clean answers.

## Judging

**The viewer decides the answer's quality more than the ranking math does.**
Alpha defects are invisible on the wrong backdrop: halo hides on white, erosion
hides on dark, partial-alpha haze only shows against a busy scene. So every
comparison composites live over a backdrop cycled with one key — light, dark,
checkerboard, real game background — plus an alpha-only view. A magnifier
follows the cursor, because fringe quality is a pixel-level judgment.

**One comparison:** two results of the same subject, same bucket, side by side.
Identity hidden, left/right randomised. `left`/`right` picks a winner, `down`
for "no meaningful difference", `space` cycles backdrop, `z` toggles zoom.

**Pair selection is adaptive** — pairs are drawn where current ratings are
closest and uncertainty is highest. Settled matchups are not re-served. This is
what makes 15 techniques tractable without judging all 105 pairs per subject.

**Ranking is Bradley-Terry, fitted per bucket**, not sequential Elo. Elo depends
on the order votes arrive; Bradley-Terry fits all verdicts at once, so
re-running gives a stable answer and late votes can overturn early noise.
Standings carry bootstrap confidence intervals; a lead is reported as real only
when intervals separate, and "too close to call" is itself a finding.

**A bucket stops** when top-1 separates from top-2 with confidence, or a
judgment budget is hit.

**Finalists.** The top 3 per bucket go to a grid where the losers are tagged
with _why_: `halo`, `eroded`, `leftover-bg`, `soft-edge`, `holes-wrong`,
`speckle`. These tags are the labels a future automatic selector would train on
— preferences alone cannot teach it, failure modes can.

**Bias control.** Roughly 1 in 20 comparisons is a silent repeat of one already
judged. Agreeing with yourself measures whether a difference is above your own
perceptual threshold. Disagreement is not failure: it is evidence the two
techniques are equivalent in practice, which is worth knowing before adopting a
more expensive one.

## Data model

**Committed** — small, diffable, the accumulated knowledge:

- `subjects.json` — corpus recipes
- the technique registry
- `verdicts.jsonl`, `faults.jsonl` — append-only logs

**Gitignored** — regenerable and large: `var/matte-bench/plates/`, `renders/`.

The leaderboard is **never stored**; it is always recomputed from the verdict
log. One source of truth, no cache to fall out of sync.

### Staleness

Every verdict records a **plate hash**, **technique-config hash** and
**ComfyUI version**. If a plate regenerates differently after an upgrade,
verdicts referencing the old hash are marked stale and excluded from standings
rather than silently compared against pixels they were never cast on.

## Failure handling

**The case that matters most:** several of the 15 models likely have no weights
on the box — the node classes are confirmed to exist, the checkpoints are not.
The first run **probes every technique and reports which are unavailable and
why**, rather than quietly ranking eight models while the operator believes
they are seeing fifteen. A technique that errors mid-run is recorded
`unavailable`, never silently skipped.

Render caching is write-atomic (temp file then rename), so a crash cannot leave
a truncated PNG that later reads as a legitimate comparison. Pairing only serves
pairs where both renders exist.

## Testing

The pure units carry the risk and get real coverage:

- `pairing` — never re-serves settled pairs, respects bucket boundaries,
  randomises sides
- `ranking` — synthetic verdict sets with known outcomes, tie handling,
  confidence-interval sanity
- `store` — round-trip, stale-by-hash detection

Plus golden tests applying post-ops to tiny synthetic plates, asserting alpha
properties with no GPU in the loop.

**Deliberate deviation from `AGENTS.md`:** no Playwright e2e. The bench is not a
product surface, its UI is a thin shell over pure logic, and an exhaustive suite
would cost more than the tool it guards. Accepted by the user during design; to
be revisited if the bench outlives its purpose and becomes something others rely
on.

## Open questions

- Whether Class B weights (Qwen layered) are present on the box. Resolved by
  the first availability probe, not by guessing.
- How many judgments a bucket actually needs before intervals separate. The
  budget is a parameter; the first real session calibrates it.

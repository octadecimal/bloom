# Matte Bench Class B — Design

**Date:** 2026-08-05
**Status:** Approved
**Builds on:** [2026-08-04-matte-bench-design.md](2026-08-04-matte-bench-design.md)

## Problem

The original bench design splits techniques into Class A (re-mat one cached
plate; every comparison judged on byte-identical art) and Class B (techniques
that change how the image is made), and rules that the two are **never pooled**
into one leaderboard. Today that rule holds only by accident: `Verdict` has no
class field, every ranking computation pools all of a bucket's verdicts, and
pairing draws pairs from the whole technique list. The only reason nothing has
gone wrong is that `stage1_models` hardcodes `cls="A"` — the moment a Class B
technique enters the registry, A and B verdicts silently merge into one
Bradley-Terry fit over a disconnected comparison graph, which is exactly the
corruption the original spec forbids. The whole-branch review of PR #227 flagged
this as a must-fix before Class B lands.

Class B itself is also still unimplemented, so the bench cannot yet answer its
full question: which production approach — re-matting, backdrop keying, or
native-RGBA generation — should Bloom use?

## Goal

One coherent delivery, in dependency order inside a single branch:

1. **Class plumbing.** Verdicts carry their class; ranking, pairing, and
   progress are scoped per class; cross-class pooling becomes unrepresentable.
2. **Backdrop-key Class B techniques**, working end-to-end with the weights
   already on the GPU box.
3. **Qwen native-RGBA Class B techniques**, code-complete and weight-gated:
   an install note plus probe auto-detection, so putting the weights on the
   box is the only install-day step.
4. **Champion playoff.** Once a bucket's A and B standings have both
   separated, the bench serves best-A vs best-B head-to-heads so the final
   cross-class decision is answered by the verdict log, not by eyeball.

## Non-goals

- No stage-2 param sweeps or stage-3 post-op grids (unchanged from the
  original design; the registry already supports them later).
- No change to the Bradley-Terry machinery, the evidence floor, or the
  blindness rules — they are reused, not redesigned.
- No Playwright: the bench has no browser e2e harness (ruling carried from
  PR #227).
- The bench does not download model weights. Installing Qwen weights on the
  GPU box is an operator action, documented not automated.

## Design

### Verdict schema and class integrity

`Verdict` gains `cls: str = "A"` with values `"A"`, `"B"`, `"X"` (playoff).

- Old log lines parse as `"A"` via the dataclass default — factually correct,
  since everything judged so far is Class A. The append-only log is never
  rewritten.
- New writes always include the field.
- The **server derives `cls`** at `/api/verdict` time from the two sides'
  registry classes: A+A→A, B+B→B, and current-champions A+B→X. The client
  never asserts a class, so a stale or buggy UI cannot mislabel history. A
  pair whose derived class is illegal — cross-class but not the bucket's
  current champions — is rejected with 422.

### Registry and probe

Two new technique builders join `stage1_models` in bootstrap:

- **`backdrop_techniques()`** — `cls="B"`, pseudo-node `"backdrop-key"`, one
  technique per backdrop variant. Start with two: chroma green and magenta.
  `params` carries the backdrop prompt clause plus keying parameters
  (`key_color`, `tolerance`, `softness`, `despill`). Available whenever the
  plate workflow's flux checkpoint is installed on the box — probed, never
  assumed.
- **`qwen_techniques()`** — `cls="B"`, node `"qwen-layered"`, materialized
  only when the probe finds Qwen weights in the ComfyUI loader choices.
  Install day requires zero code changes: weights appear on the box →
  techniques appear in the bench.

`config_hash` already covers `cls`, node, model, params, and post, so B
identities are stable, and a technique's hash pins its class forever.

The probe grows from matting-nodes-only to reporting three availability
facts: matting models (as today), the plate workflow's generator checkpoint
(gates backdrop-key), and Qwen weights (gates qwen-layered).

### Rendering

`ensure_render` branches on the technique's class; all outputs cache at the
existing `renders/<subject>/<config_hash>.png`.

- **Class A** — unchanged: upload the cached plate, run the matting graph.
- **Backdrop-key** — generate a fresh image through the existing flux
  workflow using the subject's **same seed**, with the technique's backdrop
  clause appended to the subject prompt; then key the backdrop out **in
  PIL** in the post-op layer. The keying is pure alpha math (color distance →
  alpha, with tolerance/softness/despill), deterministic and unit-testable
  without a GPU.
- **Qwen-layered** — a layered-latent graph
  (`EmptyQwenImageLayeredLatentImage`) decoding directly to RGBA. The exact
  node wiring is validated against the box's live `object_info` during
  implementation, not guessed in this spec.

**Provenance.** `plate_hash` keeps its single-field role, redefined precisely
as the _subject-generation fingerprint_. Its job is detecting subject
redefinition (edited prompt/seed), and a redefined subject changes its plate
and its B renders alike — so A, B, and X verdicts all pin the subject's plate
hash, and `fresh_verdicts` is unchanged. The technique side of provenance is
already pinned by the config hashes in `left`/`right`.

### Pairing and playoff

The pairing pool partitions by class:

- **Class choice** mirrors bucket choice: within the target bucket, serve
  the class with the fewest verdicts (ties broken alphabetically, so A
  before B — deterministic, like `least_judged_bucket`). An open playoff
  competes for service the same way, counted by its X verdicts. Pair selection _within_ a class is
  today's logic untouched (least-judged first, tie-broken toward closest
  strengths, sides randomized).
- The repeat-probe re-serves logged pairs, which are intra-class by
  construction — no change needed.
- **Playoff:** when a bucket's A standings _and_ B standings are both
  separated, that bucket's playoff opens: best-A vs best-B served on the
  bucket's subjects, verdicts logged as `cls="X"`. Ranking reuses the
  Bradley-Terry + bootstrap machinery verbatim — a playoff is a
  two-technique class, and `separated()` (evidence floor included) is its
  stopping rule. If a class's leader later changes (more verdicts can still
  arrive via the repeat-probe), the playoff pair follows the current
  champions; X verdicts for a dethroned pairing remain in the log and simply
  stop accumulating.
- A bucket's terminal state: playoff separated → one named production
  recommendation, straight from the log.

### Ranking and progress scoping

Every `standings`/`fit`/`progress` computation filters on `(bucket, cls)`.
No public code path can fit mixed-class verdicts — the pooling the review
warned about becomes unrepresentable rather than merely avoided.

### API and UI

- `GET /api/standings/{bucket}?cls=A|B|X`, defaulting to `A` (back-compat).
- `GET /api/progress` returns per-class sections; the progress line renders
  like `A 127 · holes 31 → toonout | B 6 · wispy 4 | playoff —`, showing
  only classes that have techniques or verdicts. Blindness holds per class:
  winners named only for separated buckets; the playoff result named only
  once the playoff itself separates.
- `GET /api/techniques` adds each hash's `cls` so the UI can badge
  comparisons ("Class B") — honest rather than leaky, since the two sides of
  a B or X comparison visibly differ in art, and the badge names no
  technique.

### Qwen install note

Shipped as `tools/matte-bench/README-qwen.md` (referenced from the spec, not
inlined in code):

| File                                            | Destination on the GPU box         |
| ----------------------------------------------- | ---------------------------------- |
| `qwen_image_fp8_e4m3fn.safetensors` (~20 GB)    | `ComfyUI/models/diffusion_models/` |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` (~9 GB) | `ComfyUI/models/text_encoders/`    |
| `qwen_image_vae.safetensors` (~250 MB)          | `ComfyUI/models/vae/`              |

Source: the Comfy-Org `Qwen-Image_ComfyUI` release. Exact filenames are
re-verified during implementation and the probe's detection patterns match
what the loaders actually report, so a renamed upstream file shows up as
"not installed" rather than a false positive.

### Testing

TDD throughout, in the bench's existing style:

- **Partition purity:** through public paths it is impossible to construct a
  ranking input mixing classes.
- **Schema:** old verdict lines parse as `cls="A"`; new writes carry `cls`;
  server-side derivation A+A→A, B+B→B, champions→X; 422 on illegal
  cross-class pairs.
- **Keying:** chroma-key math on synthetic PIL images (flat key color →
  fully transparent; subject pixels untouched; tolerance/softness/despill
  behavior).
- **Probe:** fixtures with and without Qwen weights and with/without the
  flux checkpoint; techniques materialize accordingly.
- **Playoff:** opens only when both classes separated; follows champion
  changes; stopping rule honors the evidence floor.
- **Progress/standings:** per-class response shapes; blindness per class.
- FastAPI `TestClient` for all route changes. No Playwright.

## Open questions

- Whether the box's `EmptyQwenImageLayeredLatentImage` + installed ComfyUI
  version decode layered RGBA the way the release notes describe. Resolved by
  probing `object_info` and a single hand-run graph during implementation,
  before the technique builder is wired in.
- How many playoff verdicts a bucket needs in practice. The evidence floor
  (`_MIN_EVIDENCE = 8`) is the starting rule; the first real playoff
  calibrates it.

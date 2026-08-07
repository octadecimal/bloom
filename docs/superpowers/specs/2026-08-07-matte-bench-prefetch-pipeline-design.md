# Matte-bench: depth-N prefetch pipeline

**Date:** 2026-08-07
**Status:** Approved
**Branch:** `feat/prefetch-pipeline`

## Problem

Measured live (2026-08-07, UTC): the operator votes a Class B subject's pairs
in ~7-20s, but generating the next subject costs ~50-65s (LLM imagining ~15s +
two ~16s flux generations + overhead). The #228 prefetcher speculates exactly
**one** comparison ahead and only starts the expensive next-subject work when
the current subject's **final** pair is served (`rotation_next`), giving it a
~2s head start. Result: a measured 71s operator wait between subjects
(verdict 19:33:57 → next pair judged 19:35:08).

The GPU is the hard floor (~32s of generation per Class B subject), but with
continuous pipelining the wait per subject drops to
`max(0, gpu_time - judging_time)` ≈ 10-20s instead of the full 50-65s, and to
zero whenever the operator actually inspects pairs.

## Design

All changes in `matte_bench/web.py` (+ tests). No API shape change, no keying
or config-hash change.

### Staged queue replaces the single staged slot

`State.staged_subject / staged_rng_state / staged_generation` become a FIFO:

```python
@dataclass
class StagedEntry:
    subject: Subject
    consume_rng_state: object   # clone state post-sample, pre-choose (what
                                # _pick_subject setstates on consumption)
    chain_rng_state: object     # clone state after this entry's comparison
                                # draws — the next entry chains from here
    predicted_pair: tuple[str, str]   # for synthetic-tie chaining
    generation: int             # consumable when == state.generation

# on State:
staged: list[StagedEntry] = field(default_factory=list)
```

`PREFETCH_DEPTH = 2` (module constant): at most 2 fresh subjects staged ahead
of the active one.

**Consumption** (`_pick_subject`): on rotation, if `state.staged` is non-empty
and `staged[0].generation == state.generation`, pop it, apply its
`consume_rng_state`, use its subject — exactly today's semantics, one entry
deep at a time. On a generation mismatch, clear the **whole** queue (the chain
is a single rng/verdict lineage; a stale head means every later entry is
stale) and fall back to a fresh draw. Log one line to the server console on
each rotation: `prefetch hit: <subject>` or `prefetch miss (<reason>)` — the
only observability needed to validate this live.

### The prefetch worker fills the queue, starting immediately

`_prefetch_async(served)` becomes a loop that tops the queue up to
`PREFETCH_DEPTH`, and no longer gates fresh-subject work on `rotation_next`:

1. Prepare the active subject's own next pair first (today's else-branch —
   usually a cache hit, keeps intra-subject serves instant).
2. Build the predicted verdict set: live verdicts + a synthetic tie for
   `served` + `PAIRS_PER_SUBJECT - active_served` ties for the active
   subject's remaining serves + `PAIRS_PER_SUBJECT` ties per already-staged
   entry (using its `predicted_pair`).
3. Chain the rng clone: start from the **last** staged entry's
   `chain_rng_state` when the queue is non-empty (and its lineage is still
   valid, i.e. entries' generations still line up with `state.generation`),
   else from a fresh clone of `state.rng` — snapshotting
   `generation` at the same moment, as today.
4. While `len(state.staged) < PREFETCH_DEPTH`: sample a fresh subject on the
   clone (`_sample_fresh(..., rng=pred_rng)`), record `consume_rng_state`,
   run `_choose_comparison` on the clone, record `chain_rng_state` and
   `predicted_pair`, `await _prepare(c, noop)`, append the `StagedEntry`
   stamped `generation = G + len(state.staged)` (evaluated at append: entry
   k is consumable at the rotation that finds `state.generation == G + k`),
   append its synthetic ties, continue.

Worker lifecycle is unchanged: one thread at a time (`state.prefetch` +
`prefetch_lock`), spawned per serve by `_start_prefetch`, exits after topping
the queue. When the queue is already full the run is a millisecond no-op.
Failures stay best-effort (swallowed; the demand path pays the render and
reports errors properly — including the #232 outage classification, which the
prefetcher must continue to never touch: no `unavailable` writes, no
technique drops).

**Prediction fidelity note:** intermediate serves draw from `state.rng`
(side flips, tie-breaks, repeat injection), so a deep chain can diverge from
the demand path. That is accepted: subjects are consumed from the queue (never
re-derived), so divergence only risks a render-cache miss on the _pair_
choice — and Class B renders are cached per `(subject, technique)` with only
two techniques in the pool, so any predicted pair pre-renders exactly the
right files. Class A pair mispredictions cost seconds (plate cached, matting
cheap).

### Per-subject in-flight guard replaces the blanket join

Today `_compute_next` joins the entire prefetch thread before `_prepare` to
avoid cache-write races — with a looping worker that could block the demand
path for the whole queue's render time. Replace it:

```python
# on State:
rendering: set[str] = field(default_factory=set)   # subject ids being prepared
render_cond: threading.Condition                    # guards `rendering`
```

- The worker wraps each subject's `_prepare` in add/notify/remove on
  `render_cond`.
- `_compute_next` waits (bounded, 300s total) only while **its** comparison's
  subject id is in `state.rendering`. On timeout it proceeds — worst case a
  duplicate render, the pre-#228 behavior, never a wedge.
- The old `state.prefetch.join()` call is deleted.

## Testing

TDD, no GPU: monkeypatch `_prepare` (recording fake with controllable
completion) and run with `state.llm = None` (deterministic template sampling)
via the existing `_client` reset helper. New tests in `tests/test_web.py`:

1. After a serve, the worker stages `PREFETCH_DEPTH` fresh subjects and
   `_prepare`s their comparisons before any vote is cast.
2. Rotation consumes the queue head: the served subject equals the staged
   prediction and the demand path performs no fresh sample (assert via a
   recording `_sample_fresh` wrapper).
3. Two consecutive rotations consume entries 0 and 1 in order.
4. A fallback rotation (queue invalidated by generation mismatch) clears the
   whole queue and logs a miss.
5. In-flight guard: demand blocks until the worker releases the same
   subject; an unrelated subject is never blocked; the guard releases on a
   prepare failure; the bounded timeout never wedges.
6. Existing depth-1 behaviors that still hold (single worker at a time; a
   prefetch failure never drops a technique or touches `unavailable`) stay
   pinned by the existing suite, which must remain green throughout.

## Non-impact

No keying params change → no hash retirement, no re-renders. `/api/next`
contract unchanged. UI untouched.

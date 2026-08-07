# Matte-bench Prefetch Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `PREFETCH_DEPTH` fresh subjects fully rendered ahead of the operator so the GPU never idles and the between-subject wait drops from ~50-65s to the GPU-bound floor.

**Architecture:** Generalize the single staged-subject slot in `matte_bench/web.py` to a FIFO of `StagedEntry` items chained on one rng-clone lineage; the prefetch worker tops the queue to depth on every serve (no longer waiting for the rotation-imminent moment); the demand path's blanket thread-join is replaced by a per-subject in-flight guard so it only waits for the specific subject it needs.

**Tech Stack:** Python (FastAPI, threading, pytest via `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`).

**Spec:** `docs/superpowers/specs/2026-08-07-matte-bench-prefetch-pipeline-design.md` (read it first — it carries the rationale and the fidelity/consumption semantics).

## Global Constraints

- Working directory is the worktree `C:\code\bloom.wt\prefetch-pipeline`, branch `feat/prefetch-pipeline`. Never touch `C:\code\bloom`.
- TDD: every step's test watched failing before the implementation lands.
- `PREFETCH_DEPTH = 2` (module constant in web.py).
- Consumption stamp rule: an entry appended when the queue holds k entries is stamped `generation = G + k` (G = the `state.generation` snapshot taken when the chain lineage was started); the head is consumable only when `staged[0].generation == state.generation`; any mismatch clears the whole queue.
- The prefetcher must never write `state.unavailable`, never drop techniques, and never call the reachability probe (`state.comfy_probe` is the demand path's tool) — outage classification from #232 stays demand-side only.
- The in-flight guard wait is bounded at 300 seconds total; on timeout the demand path proceeds (duplicate render, never a wedge).
- `/api/next` response shape unchanged; no keying/config-hash changes.
- Semantic commits, imperative mood; run the full bench suite before each commit.
- Before each commit, run the repo-pinned prettier on any touched .md files from the worktree root: `npx prettier --write <files>` (node_modules exists after `npm install`; verify with `npx prettier --version` → 3.6.2).

---

### Task 1: StagedEntry FIFO + consumption in `_pick_subject`

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (State dataclass; `_pick_subject`; `_prefetch_async` minimally adapted to the new fields so the file stays importable and the existing suite green)
- Test: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Produces (Task 2 and 3 rely on these exact names):
  - `PREFETCH_DEPTH = 2` module constant
  - `@dataclass class StagedEntry: subject: Subject; consume_rng_state: object; chain_rng_state: object; predicted_pair: tuple; generation: int`
  - `State.staged: list[StagedEntry]` (replaces `staged_subject`, `staged_rng_state`, `staged_generation` — delete those three fields and every reference)
- Consumption semantics in `_pick_subject`: pop head when `state.staged and state.staged[0].generation == state.generation`; apply `entry.consume_rng_state` to `state.rng`; on mismatch (non-empty queue, wrong head generation) clear the queue entirely; print `prefetch hit: <subject-id>` / `prefetch miss (stale)` / `prefetch miss (empty)` to the server console (plain `print`, matching the module's existing operator-facing prints if any — check; if the module has no prints, plain `print` is fine, it runs under uvicorn's console).

- [ ] **Step 1: Write the failing tests**

Append to `tools/matte-bench/tests/test_web.py`. These drive consumption directly through `web._pick_subject` (async — use `asyncio.run`) rather than the HTTP layer, with `_client` providing the state reset. Imports needed at top of file if absent: `import asyncio`, `from matte_bench.web import StagedEntry, PREFETCH_DEPTH` (add to the existing `from matte_bench.web import ...` line).

```python
def _staged_entry(subject, generation, rng_seed=99):
    """A StagedEntry the way the worker would build one: consume state is a
    clone advanced past the sampling draws."""
    clone = random.Random(rng_seed)
    return web.StagedEntry(subject=subject, consume_rng_state=clone.getstate(),
                           chain_rng_state=clone.getstate(),
                           predicted_pair=("a", "b"), generation=generation)


def test_rotation_consumes_staged_queue_head(tmp_path, monkeypatch):
    """A staged prediction for the current generation is consumed verbatim:
    no fresh sample, rng fast-forwarded to the staged state."""
    _client(tmp_path)
    staged_subject = Subject(id="wispy-777", bucket="wispy", prompt="a tuft",
                             seed=777, width=8, height=8)
    state.subjects.append(staged_subject)
    state.staged = [_staged_entry(staged_subject, generation=state.generation)]
    state.active_subject_id = None    # forces rotation

    async def fail_sample(*a, **k):
        raise AssertionError("consumption must not draw a fresh subject")

    monkeypatch.setattr(web, "_sample_fresh", fail_sample)
    subject = asyncio.run(web._pick_subject(_live(), lambda *a, **k: None))
    assert subject.id == "wispy-777"
    assert state.staged == []
    assert state.active_subject_id == "wispy-777"


def test_two_rotations_consume_entries_in_order(tmp_path, monkeypatch):
    _client(tmp_path)
    s1 = Subject(id="wispy-1", bucket="wispy", prompt="p1", seed=1, width=8, height=8)
    s2 = Subject(id="wispy-2", bucket="wispy", prompt="p2", seed=2, width=8, height=8)
    state.subjects += [s1, s2]
    g = state.generation
    state.staged = [_staged_entry(s1, generation=g),
                    _staged_entry(s2, generation=g + 1)]
    state.active_subject_id = None

    async def fail_sample(*a, **k):
        raise AssertionError("no fresh draws while the queue holds valid entries")

    monkeypatch.setattr(web, "_sample_fresh", fail_sample)
    first = asyncio.run(web._pick_subject(_live(), lambda *a, **k: None))
    state.active_subject_id = None    # force the next rotation immediately
    second = asyncio.run(web._pick_subject(_live(), lambda *a, **k: None))
    assert [first.id, second.id] == ["wispy-1", "wispy-2"]
    assert state.staged == []


def test_stale_queue_is_cleared_whole(tmp_path, monkeypatch):
    """One stale head invalidates the entire lineage — entry 2 chained its
    rng and verdict predictions off entry 1, so it cannot survive alone."""
    _client(tmp_path)
    s1 = Subject(id="wispy-1", bucket="wispy", prompt="p1", seed=1, width=8, height=8)
    s2 = Subject(id="wispy-2", bucket="wispy", prompt="p2", seed=2, width=8, height=8)
    state.subjects += [s1, s2]
    state.staged = [_staged_entry(s1, generation=state.generation + 5),
                    _staged_entry(s2, generation=state.generation + 6)]
    state.active_subject_id = None
    sampled = Subject(id="wispy-fresh", bucket="wispy", prompt="f", seed=9,
                      width=8, height=8)

    async def fake_sample(*a, **k):
        return sampled

    monkeypatch.setattr(web, "_sample_fresh", fake_sample)
    subject = asyncio.run(web._pick_subject(_live(), lambda *a, **k: None))
    assert subject.id == "wispy-fresh"
    assert state.staged == []
```

`_live()` refers to the existing helper the file uses to read verdicts for these calls — check the file; if there is no such helper, pass `[]` (the verdict list is unused by the consumption branch; use whatever the existing tests pass to `_pick_subject`-adjacent helpers, keeping consistency). Also update `_client` to reset the new field (`state.staged = []`) and REMOVE the old `state.staged_subject = None` / `staged_rng_state` / `staged_generation` resets in the same edit — the fields no longer exist.

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: new tests FAIL with `ImportError`/`AttributeError` (no `StagedEntry`), pre-existing tests may also fail on the `_client` edit until Step 3 lands — note which, they must all be green by Step 4.

- [ ] **Step 3: Implement**

In `tools/matte-bench/matte_bench/web.py`:

1. Add near the top (after imports, before `State`):

```python
PREFETCH_DEPTH = 2


@dataclass
class StagedEntry:
    """One fully-rendered future subject in the prefetch pipeline. Entries
    form a single rng/verdict lineage: entry k was predicted assuming entries
    0..k-1 get consumed first, so a stale head invalidates the whole queue."""
    subject: Subject
    consume_rng_state: object   # clone state post-sample: what state.rng
                                # becomes when this entry is consumed
    chain_rng_state: object     # clone state after this entry's comparison
                                # draws: where the next entry's prediction resumes
    predicted_pair: tuple
    generation: int             # consumable when == state.generation
```

2. In `State`: delete `staged_subject`, `staged_rng_state`, `staged_generation`; add `staged: list = field(default_factory=list)`.

3. Rewrite the consumption branch of `_pick_subject` (keep the active-subject fast path and the tail bookkeeping exactly as they are):

```python
    if state.staged and state.staged[0].generation == state.generation:
        entry = state.staged.pop(0)
        subject = entry.subject
        # Catch the shared stream up to exactly where the prefetcher's clone
        # landed after sampling this subject — as far as a real draw would
        # have advanced it, no further.
        state.rng.setstate(entry.consume_rng_state)
        print(f"prefetch hit: {subject.id}")
    else:
        if state.staged:
            # The head was predicted for a rotation that already happened
            # some other way; every later entry chained off it — drop them all.
            state.staged.clear()
            print("prefetch miss (stale)")
        else:
            print("prefetch miss (empty)")
        subject = await _sample_fresh(verdicts, progress)
```

4. Adapt `_prefetch_async` MINIMALLY so the module still works at depth 1 through the new field (full loop arrives in Task 2): where it read/wrote `staged_subject`/`staged_rng_state`/`staged_generation`, stage a single `StagedEntry` (with `chain_rng_state=pred_rng.getstate()` taken after its `_choose_comparison` call, `predicted_pair=(c.left, c.right)` or `("", "")` when `c` is None) and check `state.staged`/`state.staged[0].generation` in the staleness condition. Keep its trigger conditions untouched in this task.

- [ ] **Step 4: Run the full suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: all pass (pre-existing prefetch tests — search test_web.py for `staged` — must be updated in this task ONLY where they reference the deleted field names, preserving each test's intent; list every such edit in your report).

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "refactor(matte-bench): staged prefetch slot becomes a FIFO"
```

---

### Task 2: worker loop — fill the queue to depth, starting immediately

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (`_prefetch_async`, `_predicted_verdicts` or a new helper beside it)
- Test: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: `StagedEntry`, `PREFETCH_DEPTH`, `State.staged` from Task 1.
- Produces: `_prefetch_async(served)` that (a) still prepares the active subject's next pair first, (b) then fills `state.staged` to `PREFETCH_DEPTH` regardless of `rotation_next`, chaining rng and synthetic-tie verdicts per the spec; `_synthetic_ties(verdicts, subject_id, bucket, pair, count, cls)` helper returning the extended list (Task 3's tests reuse it).

- [ ] **Step 1: Write the failing tests**

```python
def test_prefetch_fills_queue_to_depth_after_first_serve(tmp_path, monkeypatch):
    """The pipeline must start rendering future subjects the moment a subject
    begins serving — not when its last pair goes out. Serve ONE comparison
    (active_served=1 of PAIRS_PER_SUBJECT) and run the worker body directly:
    the queue must reach PREFETCH_DEPTH with every staged comparison prepared."""
    _client(tmp_path)
    prepared = []

    async def fake_prepare(c, progress):
        prepared.append(c.subject)

    monkeypatch.setattr(web, "_prepare", fake_prepare)
    state.active_subject_id = "wispy-active"
    state.subjects.append(Subject(id="wispy-active", bucket="wispy",
                                  prompt="p", seed=5, width=8, height=8))
    state.active_served = 1
    served = {"subject": "wispy-active", "bucket": "wispy", "left": "a",
              "right": "b", "repeat_of": None, "cls": "A"}
    asyncio.run(web._prefetch_async(served))
    assert len(state.staged) == web.PREFETCH_DEPTH
    # every staged subject was rendered ahead of need
    staged_ids = [e.subject.id for e in state.staged]
    assert set(staged_ids) <= set(prepared)
    # entries are stamped for consecutive future rotations
    assert [e.generation for e in state.staged] == [state.generation,
                                                    state.generation + 1]


def test_prefetch_tops_up_existing_queue_without_duplicates(tmp_path, monkeypatch):
    """A second worker run with one entry already staged adds exactly one
    more, chained after it — it must not re-sample or re-stage the head."""
    _client(tmp_path)
    prepared = []

    async def fake_prepare(c, progress):
        prepared.append(c.subject)

    monkeypatch.setattr(web, "_prepare", fake_prepare)
    state.active_subject_id = "wispy-active"
    state.subjects.append(Subject(id="wispy-active", bucket="wispy",
                                  prompt="p", seed=5, width=8, height=8))
    state.active_served = 1
    served = {"subject": "wispy-active", "bucket": "wispy", "left": "a",
              "right": "b", "repeat_of": None, "cls": "A"}
    asyncio.run(web._prefetch_async(served))
    head_id = state.staged[0].subject.id
    asyncio.run(web._prefetch_async(served))
    assert len(state.staged) == web.PREFETCH_DEPTH
    assert state.staged[0].subject.id == head_id


def test_consuming_pipeline_end_to_end_needs_no_demand_render(tmp_path, monkeypatch):
    """Serve → worker fills queue → vote-equivalent rotation consumes the
    head; the demand path's _prepare must find everything it needs already
    prepared (same comparison object the worker prepared)."""
    _client(tmp_path)
    prepared = []

    async def fake_prepare(c, progress):
        prepared.append((c.subject, tuple(sorted((c.left, c.right)))))

    monkeypatch.setattr(web, "_prepare", fake_prepare)
    state.active_subject_id = "wispy-active"
    state.subjects.append(Subject(id="wispy-active", bucket="wispy",
                                  prompt="p", seed=5, width=8, height=8))
    state.active_served = PAIRS_PER_SUBJECT      # next pick rotates
    served = {"subject": "wispy-active", "bucket": "wispy", "left": "a",
              "right": "b", "repeat_of": None, "cls": "A"}
    asyncio.run(web._prefetch_async(served))
    head = state.staged[0]
    subject = asyncio.run(web._pick_subject(_live(), lambda *a, **k: None))
    assert subject.id == head.subject.id
    c, _cls = web._choose_comparison(subject, _live(), state.rng)
    assert (c.subject, tuple(sorted((c.left, c.right)))) in prepared
```

(`PAIRS_PER_SUBJECT` import: add to the test file's `from matte_bench.web import ...` line. As in Task 1, `_live()` means whatever the existing suite uses for a live-verdict list — keep consistent; `[]` is acceptable if that is what neighboring tests do.)

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: the three new tests FAIL — the depth-1 `_prefetch_async` from Task 1 stages at most one entry and only when `rotation_next` (`len(state.staged) == PREFETCH_DEPTH` assertions fail).

- [ ] **Step 3: Implement**

Rewrite `_prefetch_async` per the spec's worker-loop section (and add the helper it needs beside `_predicted_verdicts`):

```python
def _synthetic_ties(verdicts, subject_id, bucket, pair, count, cls="A"):
    """Ties the operator hasn't cast yet, for prediction only: each moves the
    pair counts exactly like a real verdict without picking a winner."""
    left, right = pair
    return verdicts + [Verdict(subject=subject_id, bucket=bucket, left=left,
                               right=right, winner="tie",
                               plate_hash="prediction", ts="", cls=cls)
                       for _ in range(count)]


async def _prefetch_async(served: dict) -> None:
    verdicts = _predicted_verdicts(_live_verdicts(), served)
    noop = lambda *a, **k: None                       # noqa: E731

    # 1. The active subject's own next pair (usually a cache hit) keeps
    # intra-subject serves instant, exactly as before.
    active = next((s for s in state.subjects
                   if s.id == state.active_subject_id), None)
    if active is not None and state.active_served < PAIRS_PER_SUBJECT:
        c, _cls = _choose_comparison(active, verdicts,
                                     _cloned_rng(state.rng))
        if c is not None:
            await _prepare(c, noop)

    # 2. Account for the serves that will happen before the first rotation:
    # the active subject's remaining pairs vote as synthetic ties.
    if active is not None:
        remaining = max(0, PAIRS_PER_SUBJECT - state.active_served)
        verdicts = _synthetic_ties(verdicts, active.id, active.bucket,
                                   (served["left"], served["right"]),
                                   remaining, served.get("cls", "A"))

    # 3. Resume the lineage: continue from the tail entry when the queue is
    # valid, else start a fresh clone. Generation stamps follow the spec's
    # G + len(queue-at-append) rule via `next_generation`.
    if state.staged and state.staged[0].generation == state.generation:
        pred_rng = _cloned_rng_state(state.staged[-1].chain_rng_state)
        next_generation = state.staged[-1].generation + 1
        for e in state.staged:
            verdicts = _synthetic_ties(verdicts, e.subject.id,
                                       e.subject.bucket, e.predicted_pair,
                                       PAIRS_PER_SUBJECT)
    else:
        if state.staged:
            state.staged.clear()          # stale lineage — never extend it
        pred_rng = _cloned_rng(state.rng)
        next_generation = state.generation

    # 4. Fill to depth. Each iteration mirrors one future demand rotation.
    while len(state.staged) < PREFETCH_DEPTH:
        subject = await _sample_fresh(verdicts, noop, rng=pred_rng)
        consume_state = pred_rng.getstate()
        c, _cls = _choose_comparison(subject, verdicts, pred_rng)
        if c is None:
            return
        await _prepare(c, noop)
        state.staged.append(StagedEntry(
            subject=subject, consume_rng_state=consume_state,
            chain_rng_state=pred_rng.getstate(),
            predicted_pair=(c.left, c.right), generation=next_generation))
        next_generation += 1
        verdicts = _synthetic_ties(verdicts, subject.id, subject.bucket,
                                   (c.left, c.right), PAIRS_PER_SUBJECT)


def _cloned_rng(source: random.Random) -> random.Random:
    clone = random.Random()
    clone.setstate(source.getstate())
    return clone


def _cloned_rng_state(saved_state) -> random.Random:
    clone = random.Random()
    clone.setstate(saved_state)
    return clone
```

Notes for the implementer:

- This REPLACES the old `_prefetch_async` body including its `rotation_next` gate and the comment blocks tied to the old single-slot design; write comments that describe the new design (the spec's language is the guide), keeping the existing comment about why one clone chains the draws.
- The generation snapshot subtlety from the old code (snapshot before slow awaits) is now carried by `next_generation` being computed BEFORE the loop's awaits; the staleness of a mid-flight rotation is caught at consumption (head generation mismatch) — state the spec's reasoning in a comment.
- `Verdict` import already exists in web.py (check; add if not).

- [ ] **Step 4: Run the full suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: all pass, including Task 1's consumption tests and every pre-existing prefetch test (update any that pinned the old rotation-gated trigger — list each such edit and why in your report).

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): prefetch pipeline fills a depth-2 subject queue"
```

---

### Task 3: per-subject in-flight guard replaces the blanket join

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (`State`, `_compute_next`, `_prefetch_async`/`_run_prefetch`)
- Test: `tools/matte-bench/tests/test_web.py`

**Interfaces:**

- Consumes: the Task 2 worker loop.
- Produces: `State.rendering: set` + `State.render_cond: threading.Condition`; `_guarded_prepare(c, progress)` used by the worker (adds/removes `c.subject` in `rendering` under `render_cond`, notifying on exit); `_await_subject_free(subject_id, timeout=300.0)` used by `_compute_next` in place of the `state.prefetch.join()` call (which is deleted).

- [ ] **Step 1: Write the failing tests**

```python
def test_demand_waits_only_for_its_own_subject(tmp_path, monkeypatch):
    """The worker is mid-render on subject X: a demand for X waits until X is
    released; a demand for Y does not wait at all."""
    client = _client(tmp_path)
    release = threading.Event()
    entered = threading.Event()

    def hold_x():
        with state.render_cond:
            state.rendering.add("wispy-x")
        entered.set()
        release.wait(timeout=5)
        with state.render_cond:
            state.rendering.discard("wispy-x")
            state.render_cond.notify_all()

    t = threading.Thread(target=hold_x, daemon=True)
    t.start()
    assert entered.wait(timeout=5)

    t0 = time.time()
    web._await_subject_free("wispy-y", timeout=5.0)
    assert time.time() - t0 < 0.5          # Y never waits for X

    waited = {}

    def demand_x():
        s = time.time()
        web._await_subject_free("wispy-x", timeout=10.0)
        waited["x"] = time.time() - s

    d = threading.Thread(target=demand_x, daemon=True)
    d.start()
    time.sleep(0.3)
    release.set()
    d.join(timeout=10)
    assert "x" in waited and waited["x"] >= 0.25


def test_guard_timeout_never_wedges(tmp_path):
    """A worker that never releases (crash, hang) must not deadlock the
    demand path — the bounded wait expires and the caller proceeds."""
    _client(tmp_path)
    with state.render_cond:
        state.rendering.add("wispy-stuck")
    t0 = time.time()
    web._await_subject_free("wispy-stuck", timeout=0.5)
    assert 0.4 <= time.time() - t0 < 3.0


def test_worker_prepare_registers_and_releases_subject(tmp_path, monkeypatch):
    _client(tmp_path)
    seen = {}

    async def fake_prepare(c, progress):
        seen["during"] = set(state.rendering)

    monkeypatch.setattr(web, "_prepare", fake_prepare)
    c = web.Comparison(subject="wispy-g", bucket="wispy", left="a", right="b")
    asyncio.run(web._guarded_prepare(c, lambda *a, **k: None))
    assert seen["during"] == {"wispy-g"}
    assert state.rendering == set()
```

(`import threading`, `import time` at the test file top if absent. `Comparison` import from `matte_bench.pairing` — check existing imports.)

- [ ] **Step 2: Run to verify failure**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -q`
Expected: FAIL — `_await_subject_free`, `_guarded_prepare`, `State.rendering`, `State.render_cond` don't exist.

- [ ] **Step 3: Implement**

1. `State` gains:

```python
    rendering: set = field(default_factory=set)
    render_cond: threading.Condition = field(default_factory=threading.Condition)
```

and `_client` in test_web.py resets both (`state.rendering = set()`, `state.render_cond = threading.Condition()`).

2. New helpers in web.py:

```python
def _await_subject_free(subject_id: str, timeout: float = 300.0) -> None:
    """Block while the prefetch worker is preparing this exact subject —
    writing the same plate/renders from two threads races rmtree against
    fresh files. Bounded: on timeout the caller proceeds and worst-case pays
    a duplicate render (the pre-pipeline behavior), never a wedge."""
    deadline = time.monotonic() + timeout
    with state.render_cond:
        while subject_id in state.rendering:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            state.render_cond.wait(remaining)


async def _guarded_prepare(c, progress) -> None:
    """The worker's _prepare wrapper: registers the subject as in-flight so
    the demand path can wait for exactly this subject and nothing else."""
    with state.render_cond:
        state.rendering.add(c.subject)
    try:
        await _prepare(c, progress)
    finally:
        with state.render_cond:
            state.rendering.discard(c.subject)
            state.render_cond.notify_all()
```

(`import time` at module top if absent.)

3. In `_prefetch_async`: every `await _prepare(c, noop)` becomes `await _guarded_prepare(c, noop)`.

4. In `_compute_next`: DELETE the `if state.prefetch is not None and state.prefetch.is_alive(): state.prefetch.join()` block (and its long comment) and replace with:

```python
        _await_subject_free(c.subject)
```

placed where the join was (immediately before the `try: await _prepare(c, progress)`).

- [ ] **Step 4: Run the full suite**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -q`
Expected: all pass. Any pre-existing test that pinned the join behavior gets updated to pin the guard instead (list each edit and why in your report).

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): per-subject render guard replaces prefetch join"
```

---

### Task 4: push, PR, live-validation instructions

- [ ] **Step 1: Prettier the docs, push**

```bash
npx prettier --write docs/superpowers/specs/2026-08-07-matte-bench-prefetch-pipeline-design.md docs/superpowers/plans/2026-08-07-matte-bench-prefetch-pipeline.md
git add -A && git diff --cached --quiet || git commit -m "style: prettier on prefetch-pipeline docs"
git push -u origin feat/prefetch-pipeline
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(matte-bench): depth-2 prefetch pipeline for subject generation" --body "<summary per repo conventions: problem (measured 71s waits), design (FIFO StagedEntry lineage, immediate fill to PREFETCH_DEPTH=2, per-subject render guard), testing (TDD, suite counts), spec link, and the live-validation checklist: relaunch :8400, judge a few subjects, confirm 'prefetch hit' console lines and near-zero between-subject waits>"
```

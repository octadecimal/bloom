# Matte Bench Progress Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-visible one-line progress display in the bench web page: total verdict count, per-bucket counts, and the winner's name for buckets whose ranking has separated.

**Architecture:** A new pure module `matte_bench/progress.py` aggregates fresh verdicts into a `ProgressReport` (reusing the existing `standings()`/`separated()` from `ranking.py`), a new `GET /api/progress` route in `web.py` serves it, and `static/index.html` renders it as a dim one-liner in the existing `#bar`, refreshed on page load and after every successful vote.

**Tech Stack:** Python 3.12, FastAPI, pytest, vanilla JS/HTML (no build step).

**Spec:** `docs/superpowers/specs/2026-08-05-matte-bench-progress-display-design.md`

## Global Constraints

- All work happens in the `C:\code\bloom.wt\matte-bench` worktree on branch `feat/matte-bench`.
- Python `>=3.12`; runs under `studio/backend`'s uv venv. Never create a second venv.
- All changes stay inside `tools/matte-bench/`. No schema changes, no new dependencies.
- Blindness: winner names appear ONLY for separated (finished) buckets; active buckets show a bare count. No technique name may be shown for an unseparated bucket.
- The progress line must never block or delay judging: a failed `/api/progress` fetch renders an empty line and logs to the browser console only.
- Counts are fresh (non-stale) verdicts only — the same set rankings are fitted from (`_live_verdicts()` in `web.py`).
- Markdown must pass `npx prettier --check .` before commit.
- Semantic commits (`feat:`, `test:`, `docs:`).

---

### Task 1: Pure progress module

**Files:**

- Create: `tools/matte-bench/matte_bench/progress.py`
- Test: `tools/matte-bench/tests/test_progress.py`

**Interfaces:**

- Consumes: `matte_bench.store.Verdict` (frozen dataclass: `subject, bucket, left, right, winner, plate_hash, ts, repeat_of`); `matte_bench.ranking.standings(verdicts, bucket) -> list[Standing]` and `matte_bench.ranking.separated(rows) -> bool`. `separated()` needs at least 8 comparisons on each of the top two contenders before it can return `True`.
- Produces: `progress(verdicts: list[Verdict], technique_names: dict[str, str]) -> ProgressReport` where `ProgressReport` is a frozen dataclass `(total: int, buckets: tuple[BucketProgress, ...])` and `BucketProgress` is a frozen dataclass `(bucket: str, count: int, separated: bool, winner: str | None)`. Buckets sorted by count descending, then bucket name ascending for determinism. Task 2 relies on these exact names.

- [ ] **Step 1: Write the failing tests**

`tools/matte-bench/tests/test_progress.py`:

```python
from matte_bench.progress import BucketProgress, ProgressReport, progress
from matte_bench.store import Verdict


def _v(bucket, left="a", right="b", winner="left"):
    return Verdict(subject="s1", bucket=bucket, left=left, right=right,
                   winner=winner, plate_hash="h", ts="2026-08-05T00:00:00Z")


def test_empty_log_reports_zero_and_no_buckets():
    assert progress([], {}) == ProgressReport(total=0, buckets=())


def test_thin_bucket_is_counted_but_not_separated_and_names_no_winner():
    report = progress([_v("wispy")], {"a": "Node/BiRefNet_alpha"})
    assert report.total == 1
    assert report.buckets == (
        BucketProgress(bucket="wispy", count=1, separated=False, winner=None),)


def test_separated_bucket_carries_the_winners_human_label():
    verdicts = [_v("wispy") for _ in range(10)]  # 10 unanimous wins for "a"
    report = progress(verdicts, {"a": "Node/BiRefNet_alpha"})
    assert report.buckets[0].separated is True
    assert report.buckets[0].winner == "Node/BiRefNet_alpha"


def test_winner_falls_back_to_the_hash_when_no_label_is_known():
    verdicts = [_v("wispy") for _ in range(10)]
    report = progress(verdicts, {})
    assert report.buckets[0].winner == "a"


def test_buckets_sort_by_count_descending_then_name():
    verdicts = ([_v("wispy")] * 2 + [_v("filigree")] * 3
                + [_v("crisp-text")] * 2)
    report = progress(verdicts, {})
    assert [b.bucket for b in report.buckets] == [
        "filigree", "crisp-text", "wispy"]
    assert report.total == 7
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_progress.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'matte_bench.progress'`

- [ ] **Step 3: Write the implementation**

`tools/matte-bench/matte_bench/progress.py`:

```python
"""Per-bucket judging progress: counts, separation, and settled winners.

Pure aggregation over the fresh verdict set — the route feeds it the same
verdicts the rankings are fitted from, so the numbers the operator watches
are the numbers that decide.
"""
from dataclasses import dataclass

from matte_bench.ranking import separated, standings
from matte_bench.store import Verdict


@dataclass(frozen=True)
class BucketProgress:
    bucket: str
    count: int
    separated: bool
    winner: str | None


@dataclass(frozen=True)
class ProgressReport:
    total: int
    buckets: tuple[BucketProgress, ...]


def progress(verdicts: list[Verdict],
             technique_names: dict[str, str]) -> ProgressReport:
    counts: dict[str, int] = {}
    for v in verdicts:
        counts[v.bucket] = counts.get(v.bucket, 0) + 1
    buckets = []
    for bucket in sorted(counts, key=lambda b: (-counts[b], b)):
        rows = standings(verdicts, bucket)
        done = separated(rows)
        # Winner names only for finished buckets: the operator judging an
        # active bucket stays blind to its standings.
        winner = (technique_names.get(rows[0].technique, rows[0].technique)
                  if done else None)
        buckets.append(BucketProgress(bucket=bucket, count=counts[bucket],
                                      separated=done, winner=winner))
    return ProgressReport(total=len(verdicts), buckets=tuple(buckets))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_progress.py -v`
Expected: 5 PASS

- [ ] **Step 5: Commit**

```bash
git add tools/matte-bench/matte_bench/progress.py tools/matte-bench/tests/test_progress.py
git commit -m "feat(matte-bench): pure per-bucket progress report"
```

---

### Task 2: `GET /api/progress` route

**Files:**

- Modify: `tools/matte-bench/matte_bench/web.py` (add route next to `api_standings`, ~line 325; add `progress` to imports)
- Test: `tools/matte-bench/tests/test_web.py` (append)

**Interfaces:**

- Consumes: `matte_bench.progress.progress(verdicts, technique_names) -> ProgressReport` (Task 1); existing `_live_verdicts()` helper and `state.technique_names` in `web.py`.
- Produces: `GET /api/progress` returning `{"total": int, "buckets": [{"bucket": str, "count": int, "separated": bool, "winner": str | null}, ...]}`. Task 3's frontend fetches exactly this shape.

- [ ] **Step 1: Write the failing tests**

Append to `tools/matte-bench/tests/test_web.py` (uses the file's existing `_client` helper; `_client` seeds `state.plate_hashes = {"s1": "h"}` and `/api/verdict` stamps each verdict with that live hash, so posted verdicts count as fresh):

```python
def test_progress_reports_totals_and_unseparated_bucket_without_winner(tmp_path):
    client = _client(tmp_path)
    for _ in range(2):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    body = client.get("/api/progress").json()
    assert body["total"] == 2
    assert body["buckets"] == [
        {"bucket": "wispy", "count": 2, "separated": False, "winner": None}]


def test_progress_names_the_winner_once_a_bucket_separates(tmp_path):
    client = _client(tmp_path)
    state.technique_names = {"a": "Node/BiRefNet_alpha"}
    for _ in range(10):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    body = client.get("/api/progress").json()
    assert body["buckets"][0]["separated"] is True
    assert body["buckets"][0]["winner"] == "Node/BiRefNet_alpha"


def test_progress_counts_only_fresh_verdicts(tmp_path):
    """Stale verdicts (cast on an outdated plate) feed neither the rankings
    nor the displayed counts — the number watched is the number that decides."""
    client = _client(tmp_path)
    for _ in range(2):
        client.post("/api/verdict", json={
            "subject": "s1", "bucket": "wispy", "left": "a", "right": "b",
            "winner": "left",
        })
    state.plate_hashes["s1"] = "regenerated"  # invalidates both verdicts
    body = client.get("/api/progress").json()
    assert body["total"] == 0
    assert body["buckets"] == []


def test_progress_is_served_with_no_store(tmp_path):
    assert (_client(tmp_path).get("/api/progress").headers.get("cache-control")
            == "no-store")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -k progress -v`
Expected: 4 FAIL — `/api/progress` returns 404

- [ ] **Step 3: Implement the route**

In `tools/matte-bench/matte_bench/web.py`, extend the store/ranking import block with the new module:

```python
from matte_bench.progress import progress
```

Add after `api_standings` (~line 337):

```python
@app.get("/api/progress")
def api_progress() -> dict:
    """One line of session progress: how much has been judged and which
    buckets are settled. Winner names only for separated buckets — the
    judge stays blind to the standings of buckets still in play."""
    report = progress(_live_verdicts(), state.technique_names)
    return {
        "total": report.total,
        "buckets": [
            {"bucket": b.bucket, "count": b.count,
             "separated": b.separated, "winner": b.winner}
            for b in report.buckets
        ],
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests/test_web.py -k progress -v`
Expected: 4 PASS

- [ ] **Step 5: Run the whole bench suite for regressions**

Run: `cd studio/backend && uv run pytest ../../tools/matte-bench/tests -v`
Expected: all PASS

- [ ] **Step 6: Commit**

```bash
git add tools/matte-bench/matte_bench/web.py tools/matte-bench/tests/test_web.py
git commit -m "feat(matte-bench): /api/progress endpoint"
```

---

### Task 3: Progress line in the judging page

**Files:**

- Modify: `tools/matte-bench/matte_bench/static/index.html`

**Interfaces:**

- Consumes: `GET /api/progress` (Task 2's exact response shape).
- Produces: a `#progress` div rendering e.g. `133 verdicts · enclosed-holes 35 → toonout · glow-soft 21 · crisp-text 20`.

No JS test harness exists for the bench (vanilla HTML, no build step, no Playwright coverage of `tools/` per the spec), so this task is verified against the running server in Step 2.

- [ ] **Step 1: Add the line, styles, and fetch**

In `tools/matte-bench/matte_bench/static/index.html`:

1. Add a style rule after the `#status.error` rule (~line 145):

```css
#progress {
  padding-top: 4px;
  font-size: 12px;
  color: #aaa;
}
#progress:empty {
  display: none;
}
```

2. Add the div at the END of `#bar` (after the `<kbd>o</kbd> original` line, ~line 174):

```html
<div id="progress"></div>
```

3. In the script, add below `setStatus` (~line 188):

```js
// "Node/BiRefNet_toonout" -> "toonout" for the one-line bar; standings
// keep full labels. Unrecognised label shapes pass through untrimmed.
function shortLabel(label) {
  const tail = label.split('/').pop();
  const trimmed = tail.replace(/^BiRefNet[_-]?/, '');
  return trimmed || tail;
}

// Never blocks judging: on any failure the line simply goes empty.
async function refreshProgress() {
  const el = document.getElementById('progress');
  try {
    const resp = await fetch('/api/progress');
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    const body = await resp.json();
    const parts = body.buckets.map((b) => (b.separated && b.winner ? `${b.bucket} ${b.count} → ${shortLabel(b.winner)}` : `${b.bucket} ${b.count}`));
    el.textContent = [`${body.total} verdicts`, ...parts].join(' · ');
  } catch (err) {
    console.error('progress fetch failed:', err);
    el.textContent = '';
  }
}
```

4. Add `refreshProgress();` as the first line of the existing `load()` function body (fire-and-forget, deliberately not awaited). `load()` runs once at startup and after every successful vote, which is exactly the refresh cadence the spec asks for.

- [ ] **Step 2: Verify against the running bench**

With the bench running (`just matte-bench`, port `8400 + BLOOM_PORT_OFFSET`; this worktree's offset is 2 → 8402):

Run: `curl -s http://localhost:8402/api/progress`
Expected: JSON with `total` matching the fresh-verdict count and one entry per bucket, sorted by count descending.

Then reload `http://localhost:8402/` in a browser: the dim progress line appears under the keyboard hints, shows `N verdicts · <bucket> <count> …`, and updates after casting a verdict. Buckets that have not separated show no technique name.

- [ ] **Step 3: Commit**

```bash
git add tools/matte-bench/matte_bench/static/index.html
git commit -m "feat(matte-bench): always-on progress line in the judging page"
```

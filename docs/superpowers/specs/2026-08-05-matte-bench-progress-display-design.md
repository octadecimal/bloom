# Matte Bench Progress Display — Design

**Date:** 2026-08-05
**Status:** Approved
**Builds on:** [2026-08-04-matte-bench-design.md](2026-08-04-matte-bench-design.md)

## Problem

The bench's stopping rule is statistical — "a bucket stops when top-1 separates
from top-2 with confidence" — but the only way to check it today is to curl
`/api/standings/{bucket}` for each bucket by hand after a session. The operator
judging pairs has no visibility into how many verdicts have accumulated or
whether any bucket has settled, so they either over-judge settled buckets or
stop before anything has separated.

## Goal

An always-visible one-line progress display in the bench web page showing:

- the total accumulated verdict count,
- per bucket: its verdict count, and
- for buckets that have separated: the winning technique's name.

Refreshed after every verdict, so the operator watches buckets settle in real
time and knows when to stop.

## Non-goals

- No full leaderboard UI (confidence intervals, per-technique rows). The
  `/api/standings/{bucket}` endpoint already serves that for anyone digging in.
- No toggle/overlay panel, no separate page.
- No change to pairing, ranking, or the verdict log.

## Blindness constraint

The bench keeps the judge blind: mid-comparison progress text never names a
technique. The progress line preserves this — **winner names appear only for
separated buckets**, which are finished. Active buckets show a bare count.

## Design

### Backend

**Pure function** in a new module `matte_bench/progress.py`:

```python
def progress(verdicts: list[Verdict],
             technique_names: dict[str, str]) -> ProgressReport
```

- Groups verdicts by bucket.
- Per bucket: `count` (number of verdicts), `separated` (reusing the existing
  `separated(standings(...))` logic), and `winner` — the top-1 technique's
  human label when separated, else `None`.
- Buckets sorted by count descending. Only buckets present in the verdict log
  appear; nothing is hardcoded.
- Input is the **fresh** (non-stale) verdict set — the same set rankings are
  fitted from, so the displayed numbers are the ones that decide. `total` is
  the size of that set (the sum of the bucket counts).

**Route** in `web.py`, wrapping the pure function exactly as `api_standings`
does:

```
GET /api/progress
{
  "total": 133,
  "buckets": [
    {"bucket": "enclosed-holes", "count": 35, "separated": true,
     "winner": "BiRefNetRMBG/BiRefNet_toonout"},
    {"bucket": "glow-soft", "count": 21, "separated": false, "winner": null}
  ]
}
```

### Frontend (`static/index.html`)

- New `#progress` line inside the existing `#bar`, styled like `#meta` (dim,
  small; wraps on narrow windows).
- Rendered as:
  `133 verdicts · enclosed-holes 35 → toonout · glow-soft 21 · crisp-text 20 · …`
- Technique labels are shortened for the bar by trimming the common
  `<Node>/BiRefNet_`-style prefix (client-side, display only).
- Fetched once on page load and re-fetched after each successful vote (called
  from `load()`), so the line is current after every verdict. No polling.

### Error handling

The line must never block or delay judging. If `/api/progress` fails, the line
renders empty and the error goes to the browser console only.

### Testing

TDD, per repo policy:

- Unit tests for `progress()`: empty log; one bucket unseparated (winner is
  `None`); separated bucket carries the winner's label; stale verdicts
  excluded from counts; buckets sorted by count descending.
- One FastAPI `TestClient` test asserting the `/api/progress` response shape.
- No Playwright: the bench has no e2e harness and the repo suite does not
  cover `tools/`.

## Footprint

All changes inside `tools/matte-bench/`: one new pure module + tests, one new
route, one new line and fetch in `index.html`. No schema changes, no new
dependencies.

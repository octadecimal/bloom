# Matte-bench: ComfyUI outage visibility

**Date:** 2026-08-07
**Status:** Approved
**Branch:** `test/matte-bench-followups` (PR #232)

## Problem

When the remote ComfyUI box (`COMFYUI_URL`, a LAN machine) is unreachable, the
judging bench fails in two misleading ways, observed live on 2026-08-07:

1. `/api/next` reports the session **done**, so the UI shows "No comparisons
   left." — indistinguishable from actually finishing the session.
2. The render failure path retires the technique that happened to be rendering
   (`state.unavailable`, removed from `state.techniques`) for the rest of the
   session — chroma-magenta was dropped by a websocket handshake timeout even
   though nothing was wrong with the technique.

The operator gets no signal that the GPU box is the problem.

## Design

### Server (`matte_bench/probe.py`, `matte_bench/web.py`)

New helper in `probe.py`:

```python
def comfy_unreachable(url: str, timeout: float = 3.0) -> str | None:
    """Reason string if the ComfyUI box does not answer, else None."""
```

Implemented as a short-timeout `GET /system_stats`. Two call sites in
`_compute_next`:

- **On any `_prepare` failure** (RenderError or generic): probe first.
  - Unreachable → the job fails with
    `ComfyUI unreachable at <url>: <reason>` — the technique is **not**
    dropped and `state.unavailable` is untouched, so the pool survives a
    reboot of the box.
  - Reachable → exactly today's behavior: the technique is genuinely broken;
    drop it, record the reason in `/api/unavailable`.
- **Before reporting the session done** (no comparison choosable — also the
  startup path when the box was down at bench launch and the bootstrap probe
  yielded zero techniques): probe. Unreachable → same job failure instead of
  a false "No comparisons left."

The job failure flows through the existing `_NextJob.error` →
`HTTPException(500, detail=...)` path; no API shape change.

### Client (`matte_bench/static/index.html`)

The `load()` error path currently renders only `Error: <status> <statusText>`
and discards the response body. It will parse the JSON body when present and
prefer its `detail` string, with a ` — reload to retry` suffix, e.g.:

> Error: ComfyUI unreachable at http://192.168.1.110:8188: timed out — reload to retry

This makes every server-reported error legible, not just outages. Refreshing
the page remains the retry mechanism; no auto-polling.

## Testing

TDD at both layers:

- **pytest (`tests/test_web.py`)**: render failure + probe unreachable →
  `/api/next` 500 with `ComfyUI unreachable` detail, pool intact, empty
  `unavailable`; render failure + probe reachable → technique dropped (pins
  today's behavior); done-path while unreachable → 500, not `done`.
- **jsdom harness (`ui-tests/judge-ui.spec.ts`)**: a 500 with a JSON `detail`
  renders that detail in the status bar.

## Non-impact

No keying parameters change: no config-hash retirement, no re-renders. The
`o`-toggle and pairing logic are untouched.

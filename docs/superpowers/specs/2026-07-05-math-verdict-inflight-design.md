# Math plugin: in-flight verdict state

**Date:** 2026-07-05
**Status:** Approved
**Scope:** `studio/frontend/src/plugins/math/components/ResultStrip.tsx` + tests. Pure view change — no state shape changes, no backend.

## Problem

The Math pane's Verdict strip (`ResultStrip`) pins its badge and metrics table to
`latestOutcome` — the newest of the last recorded generate run vs the last
verify-only curation. It never consults `genStatus` / `verifyStatus`, so while a
tune or verify is in flight the strip keeps showing the **previous** run's
PASS/FAIL verdict and metrics as if they were current. The GenerateBar shows
"tuning gen 3/50" at the top of the pane while the bottom strip contradicts it
with a stale PASS — confusing, and it obscures whether a run is in progress.

## Behavior

- `ResultStrip` derives a `running` flag from state it already subscribes to:
  `genStatus` ∈ {`tuning`, `verifying`, `cancelling`} **or**
  `verifyStatus === 'running'`.
- While running:
  - The `result-verdict` badge shows **RUNNING…** (**CANCELLING…** when
    `genStatus === 'cancelling'`) in neutral text-tier-2 styling (`text-text-2`),
    replacing the stale PASS/FAIL/NEAR-MISS/ERROR badge.
  - The previous outcome's metrics table, stop-reason label, lock chips, and
    "Applied" note are all hidden.
  - The Apply button stays visible but disabled for the whole running window.
    Today its disable condition misses `cancelling` and the verify-only-running
    case; extending it closes a small race where Apply could fire mid-verify.
- When the run finishes (`done` / `failed` / `cancelled`), the strip reverts to
  exactly today's behavior: `latestOutcome` verdict + metrics. After a failure
  or cancel that is the previous completed result again — now honest, because
  the GenerateBar separately shows "failed" / "run cancelled".

## Alternatives considered

- **Push the running state into `outcomeVerdict()` in `reducers.ts`** — makes a
  pure outcome reducer depend on transient pipeline status; the strip already
  reads status directly. Rejected.
- **Clear `verifyResult` / the newest run at run start** — destroys recorded
  data for no gain. Rejected.
- **Keep the stale verdict, add a "previous result" label** — smaller diff but
  leaves stale numbers on screen; user chose the hide variant. Rejected.

## Testing

- **Unit (TDD, `ResultStrip.spec.tsx`):**
  - each running state (`tuning`, `verifying`, `cancelling`, verify-only
    `running`) → RUNNING…/CANCELLING… badge, no metrics table / stop label /
    lock chips / applied note, Apply disabled;
  - idle/done states → current behavior unchanged (existing specs keep passing).
- **E2e (`math-plugin.spec.ts`):** extend the existing generate flow with a
  mid-run assertion — badge reads RUNNING… right after clicking Generate — if
  replay timing allows observing it; if the replay run completes too fast to
  catch reliably, the component tests carry the contract (do not ship a flaky
  assertion).

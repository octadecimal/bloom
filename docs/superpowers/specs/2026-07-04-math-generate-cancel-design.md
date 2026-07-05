# Math Generate Cancel — design

**Date:** 2026-07-04
**Status:** approved (brainstormed in-session)
**Motivation:** a run with a very high mutation rate appeared to grind forever with no
way to stop it. The Generate button must toggle into a Cancel button that aborts the
in-flight generate pipeline.

## Decision: discard semantics

Cancel discards everything. The tuner subprocess is hard-killed, nothing is persisted
(already true today — `math_runs` docs and `slot_models.tune_result` are only written
on successful completion), and the UI returns to idle. No Rust changes: the GA binary
keeps no external stop hook; cancel is an on-demand version of the existing watchdog
kill (`subprocess_guard.kill_proc_tree`).

Rejected alternatives:

- **Socket.IO cancel event** — generate itself is REST; REST keeps symmetry and gives
  a proper 409 when there is nothing to cancel.
- **`asyncio.Task.cancel()`** — broken on the Windows `--reload` path where
  `LoopSafeRunner` runs the subprocess on a private ProactorEventLoop in a daemon
  thread; cancelling the wrapper task leaves the subprocess alive. Killing by process
  is required regardless, so the task handle adds nothing.

## Backend (`studio/backend/app/math`)

### MathHub state

- `_cancels: dict[str, Callable[[], None]]` — per-game kill callable, registered by the
  active runner while its subprocess is alive.
- `_cancelled: set[str]` — games whose current run was cancelled; consulted at phase
  boundaries and on error classification.

Both live next to the existing `_active` set and are cleaned in the same `finally`
block of `_generate_reserved`.

### Runner hook

`SubprocessTunerRunner.run` (and the verify-phase runner, so cancel works during
`verifying` too) gains an optional `on_spawn: Callable[[Callable[[], None]], None]`
parameter. Right after `create_subprocess_exec`, the runner calls
`on_spawn(lambda: kill_proc_tree(proc.pid))`; the hub stores it in `_cancels[game_id]`.
The registration is cleared when that subprocess exits (each phase re-registers).
This works on the `LoopSafeRunner` daemon-thread path because `kill_proc_tree` is
pid-based and thread-safe (psutil), not loop-bound.

### Cancel route

`POST /games/{game_id}/math/generate/cancel`

- `game_id` not in `_active` → **409** `{"detail": "no active run"}`.
- Otherwise: add to `_cancelled`, invoke `_cancels.get(game_id)` if present, return
  **202**. (If the pipeline is between subprocesses there is no kill callable; the
  flag alone aborts it at the next phase boundary.)

### Pipeline changes (`_generate_reserved`)

- After each awaited phase (tune, verify), check `game_id in _cancelled` → stop,
  emit `generate_status: {status: "cancelled"}`, skip `record_run`, return.
- When a phase returns an error and the game is in `_cancelled`, classify it as
  cancelled (emit `cancelled`, not `failed` / `tuning_failed`).
- `finally`: discard from `_active`, `_cancelled`, `_cancels`.

`cancelled` is a new terminal value on the existing `generate_status` socket event.
No new socket events.

## Frontend (`studio/frontend/src/plugins/math`)

- **GenerateBar**: while `running` (`genStatus` is `tuning`/`verifying` or verify in
  flight), the button renders as **Cancel** with `data-testid="cancel-button"` and is
  always enabled (the `locked`/`gap` disabling applies only to the Generate state).
  Click → `cancelMath(gameId)`; after a 202 the button shows a disabled
  "Cancelling…" state until the `cancelled` socket event lands.
- **actions.ts**: `cancelMath` → `restClient` POST `/games/{id}/math/generate/cancel`.
  On **409** ("no active run"), reset `genStatus` to idle anyway — the backend is the
  source of truth, so a stuck UI self-heals when the user clicks Cancel.
- **socketClient.ts**: handle `generate_status: cancelled` → reset `genStatus`/
  `genProgress` to idle (same cleanup as `failed`, without the error toast — show a
  quiet "run cancelled" note in the existing `generate-status` line).

## Edge cases

- **Cancel between phases**: no live subprocess → flag-only; pipeline aborts at the
  next boundary check. The 202 response does not guarantee the kill happened, only
  that cancellation is underway; on 202 the button shows a disabled "Cancelling…"
  state and the UI resets only on the `cancelled` socket event (the authority).
  Only a 409 resets the UI directly.
- **Double-click Cancel**: second POST finds the game still in `_active` → 202 again,
  idempotent (flag already set, kill callable already consumed or re-invoked on a
  dead pid, which `kill_proc_tree` tolerates).
- **Cancel racing natural completion**: if the run finishes before the flag is seen,
  the run persists normally and emits `done` — acceptable; the user asked to stop a
  run that was effectively finished.
- **Stuck-UI self-heal**: the 409 → reset-to-idle behavior doubles as recovery for
  the "UI stuck in tuning after a missed socket event" failure mode.

## Testing (TDD)

- **Backend unit** (`test_math_generate.py` style, gated fake runners):
  - cancel during tune → subprocess-kill callable invoked, `generate_status:
cancelled` emitted, no `math_runs` doc, no `tune_result` write, `_active` freed.
  - cancel between phases (no kill registered) → pipeline aborts at boundary.
  - cancel with no active run → 409.
  - error during a cancelled run classified as `cancelled`, not `failed`.
- **Frontend vitest**: GenerateBar toggles Generate↔Cancel by `genStatus`; Cancel
  enabled even when `locked`; `cancelMath` 409 resets state; socket `cancelled`
  resets state.
- **Playwright e2e**: start a generate in replay, click Cancel, assert the button
  returns to Generate and status shows cancelled. Feasibility of catching the
  in-flight window in replay is resolved in the plan (a gated/slow replay runner or
  a stub run); if the window can't be held open deterministically, the e2e asserts
  the 409 self-heal path instead.

## Out of scope

- Graceful best-so-far cancel (Rust cooperative stop) — not wanted; discard is the
  contract.
- Cancel for curation/sim runs outside the generate pipeline.
- Persisted "cancelled run" history entries.

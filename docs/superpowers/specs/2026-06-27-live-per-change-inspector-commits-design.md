# Live per-change Property Inspector commits

**Date:** 2026-06-27
**Status:** Approved (design) — ready for implementation plan

## Problem

In the Property Inspector, editing a numeric value (typing, or clicking the
native number-input spinner) does not appear to update the live game on every
change — the game only updates once the edit "settles." Users want the game to
reflect **every** change as it happens.

## Diagnosis

The mutation path is already live end-to-end. A value edit flows:

```
EditableValue.onChange
  → commitSetProp(nodeId, path, value)        commit.ts
  → emitSceneApplyOp(gameId, {kind:'setProp'}) socketClient.ts (socket emit)
  → backend applies + broadcasts `scene_op`
  → applyInbound updates sceneStore AND getBridge().op(op)  socketClient.ts
  → ProtocolBridge.op → postMessage to runtime iframe
  → protocolHost.handle → model.apply → reconciler → renderer.setProp (Pixi)
```

The gate is **not** Enter/blur. It is an **80 ms trailing-edge debounce** wrapping
the commit (`EditableValue.tsx`: `DEBOUNCE_MS = 80`, `makeDebounced` at line 20,
called from `onChange` at line 59). Trailing-edge debounce coalesces rapid
changes: while the user is actively changing the value, intermediate values are
dropped and only the final settled value is emitted. That settling reads to the
user as "only updates once I've committed."

For contrast, the boolean checkbox in the same component already commits
immediately with no debounce (`EditableValue.tsx:36`).

## Decision

Remove the debounce. Each change that parses to a valid value emits the full
socket round-trip immediately — exactly mirroring the existing boolean path.
This is acceptable for Bloom Studio's single-user model; per-change socket /
backend write traffic is not a concern at this scale.

Explicitly **out of scope**: throttling / rate-limiting, optimistic local apply
(pushing to the bridge before the echo), and op batching. This is a pure
debounce removal.

## Changes

### `studio/frontend/src/plugins/property-inspector/EditableValue.tsx`

- Remove `DEBOUNCE_MS` and the `makeDebounced` import.
- Remove the `const commit = useMemo(() => makeDebounced(...), [nodeId, path])`
  wrapper and the accompanying stale-closure comment block (lines ~16–20). A
  direct call always closes over the current `nodeId`/`path`, so the
  cancel-on-remount hazard the comment describes no longer exists.
- In the number/text `onChange`, call `commitSetProp(nodeId, path, parsed.value)`
  directly when `parsed.ok`, instead of the debounced `commit(...)`.
- Leave unchanged:
  - `setText(next)` on every change (instant local field echo).
  - The focus-guarded reconciliation effect (lines ~26–28) — still prevents the
    incoming echo from fighting the caret mid-edit.
  - The boolean checkbox branch (already immediate).
  - `onBlur` / `onKeyDown` (Escape revert, Enter blur) behavior.

### `studio/frontend/src/plugins/property-inspector/edit.ts`

- Remove `makeDebounced` (verified used only by `EditableValue.tsx`; the
  `makeDebouncedSaver` in `state/persistence.ts` is a separate, unrelated
  function and stays). Keep `parseEditInput` and `toInputText`.

## Behavioral nuance (explicit, tested)

Because `onChange` commits whenever the current string parses, typing `100`
streams three commits — `1`, `10`, `100` — and the game renders each in turn.
This is the intended consequence of "update on every change," not a defect.

Non-emitting inputs are preserved by the existing parse gate: an empty string or
a lone `-` fail `parseEditInput` (`ok: false`) and emit nothing, so no garbage
writes occur while a number is mid-typed.

## Testing

TDD — encode the new contract first, watch it fail, then implement.

**Unit (`studio/frontend/src/plugins/property-inspector/`):**

- `EditableValue.spec.tsx`: replace the debounce-timing cases with assertions
  that each `onChange` triggers an **immediate** `commitSetProp`, and add a case
  proving N successive changes produce N emits (no coalescing). Keep the
  parse-gate cases (empty / lone `-` emit nothing) and the focus-guarded
  reconciliation case.
- `edit.spec.ts`: remove the `makeDebounced` tests along with the function.
- `commit.spec.ts`: unaffected — the emitted op shape is unchanged.

**End-to-end (`studio/frontend/e2e/`):**

- `inspector-mutation-roundtrip.spec.ts` and `mutable-inspector.spec.ts` remain
  valid as-is.
- Add an assertion that a multi-step edit produces **multiple** `scene_apply_op`
  emits (e.g. via the existing `window.__gameLastApplyOp` dev hook, or a count of
  emitted ops), confirming per-change emission rather than a single settled one.
- Run `just e2e` against the replay backend before opening the PR (start
  `just backend-serve-replay` first), per repo policy. Browser e2e is not gated
  in CI.

## Risks / trade-offs

- **More wire / write traffic** — one socket round-trip + backend persist per
  change instead of per settle. Accepted for single-user studio scale.
- **Intermediate-value rendering** — the game briefly shows partial values
  (`1`, `10`) while typing `100`. Accepted and documented above as intended.

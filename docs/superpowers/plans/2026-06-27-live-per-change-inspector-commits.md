# Live per-change Property Inspector commits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Property Inspector's numeric/text edits update the live game on every change instead of only after the input settles.

**Architecture:** The mutation path (`onChange → commitSetProp → socket → backend echo → runtime iframe → Pixi`) is already live; an 80 ms trailing-edge debounce on the commit is what coalesces in-progress edits down to a single settled value. We remove that debounce so each parsed change emits immediately — mirroring the boolean checkbox in the same component, which already commits with no debounce. Pure removal; no throttle, no optimistic local apply, no batching.

**Tech Stack:** TypeScript + React (studio/frontend), Vitest (unit), Playwright (e2e, replay backend), nx.

## Global Constraints

- TypeScript interfaces use an `I` prefix (`IEditableValueProps`).
- Frontend CI gates, all run from the **worktree root** after `just bootstrap`: `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. Vitest passing alone does **not** prove types/build — run all four.
- Prettier must match the pinned version (~3.6.2). If `npx prettier` resolves a newer version that reformats markdown, run `./node_modules/.bin/prettier --check .` instead.
- This worktree is `feat/live-inspector-commits`, `BLOOM_PORT_OFFSET=1` → backend :8001, studio :4201, runtime :4301. Browser e2e is **never** in CI — run it locally.
- Do not change the emitted op shape (`{ kind: 'setProp', id, path, value }`) — `commit.spec.ts` and the backend depend on it.

---

### Task 1: Remove the debounce so every parsed change commits immediately

**Files:**

- Modify: `studio/frontend/src/plugins/property-inspector/EditableValue.tsx`
- Modify: `studio/frontend/src/plugins/property-inspector/edit.ts` (remove `makeDebounced`)
- Test: `studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx`
- Test: `studio/frontend/src/plugins/property-inspector/edit.spec.ts` (remove `makeDebounced` block)

**Interfaces:**

- Consumes: `commitSetProp(nodeId: string, path: string, value: JsonValue): void` (from `./commit`), `parseEditInput(type: ScalarType, text: string): IParseResult`, `toInputText(type: ScalarType, raw: JsonValue): string` (from `./edit`).
- Produces: no API changes. `EditableValue` keeps the same props. `makeDebounced` is **deleted** from `edit.ts` (was exported, used only by this widget + its own test).

- [ ] **Step 1: Rewrite the unit tests to assert immediate, per-change commits**

Replace the entire contents of `studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as commit from './commit';
import { EditableValue } from './EditableValue';

beforeEach(() => {
  vi.spyOn(commit, 'commitSetProp').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('EditableValue', () => {
  it('renders the raw number and commits a parsed edit immediately', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    expect(input.value).toBe('120');

    fireEvent.change(input, { target: { value: '130' } });
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'x', 130);
  });

  it('commits every change with no coalescing', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={1} />);
    const input = screen.getByTestId('inspector-edit-x');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.change(input, { target: { value: '100' } });
    expect(commit.commitSetProp).toHaveBeenCalledTimes(3);
    expect(commit.commitSetProp).toHaveBeenNthCalledWith(1, 's1', 'x', 1);
    expect(commit.commitSetProp).toHaveBeenNthCalledWith(2, 's1', 'x', 10);
    expect(commit.commitSetProp).toHaveBeenNthCalledWith(3, 's1', 'x', 100);
  });

  it('does not commit an empty/NaN number', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x');
    fireEvent.change(input, { target: { value: '' } });
    expect(commit.commitSetProp).not.toHaveBeenCalled();
  });

  it('commits a boolean immediately on toggle', () => {
    render(<EditableValue nodeId="s1" path="visible" valueType="boolean" raw={true} />);
    const box = screen.getByTestId('inspector-edit-visible') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'visible', false);
  });

  it('reverts to raw on Escape', () => {
    render(<EditableValue nodeId="s1" path="name" valueType="string" raw="hero" />);
    const input = screen.getByTestId('inspector-edit-name') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'villain' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('hero');
  });

  it('syncs from a new raw value when not focused', () => {
    const { rerender } = render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    rerender(<EditableValue nodeId="s1" path="x" valueType="number" raw={200} />);
    expect((screen.getByTestId('inspector-edit-x') as HTMLInputElement).value).toBe('200');
  });

  it('does NOT clobber the field from a raw change while focused', () => {
    const { rerender } = render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '155' } });
    rerender(<EditableValue nodeId="s1" path="x" valueType="number" raw={999} />); // echo arrives mid-edit
    expect(input.value).toBe('155');
  });
});
```

What changed vs. the old file: the first test no longer expects a debounce gap (asserts the commit fired synchronously); a new "commits every change with no coalescing" test proves N changes → N emits; the empty/NaN test drops the fake-timer advance; fake timers are removed entirely (nothing is timer-based anymore).

- [ ] **Step 2: Run the unit test, watch it fail (RED)**

Run: `npx nx test frontend` (from worktree root), or scoped: `cd studio/frontend && npx vitest run src/plugins/property-inspector/EditableValue.spec.tsx`
Expected: FAIL — the current implementation debounces, so "commits a parsed edit immediately" and "commits every change with no coalescing" fail (`commitSetProp` not called synchronously / called fewer than 3 times).

- [ ] **Step 3: Remove the debounce in `EditableValue.tsx`**

Replace the entire contents of `studio/frontend/src/plugins/property-inspector/EditableValue.tsx` with:

```tsx
import { useState, useRef, useEffect } from 'react';
import type { JsonValue } from '../../scene/types';
import { type ScalarType, parseEditInput, toInputText } from './edit';
import { commitSetProp } from './commit';

interface IEditableValueProps {
  nodeId: string;
  path: string;
  valueType: ScalarType;
  raw: JsonValue;
}

export function EditableValue({ nodeId, path, valueType, raw }: IEditableValueProps) {
  const [text, setText] = useState(() => toInputText(valueType, raw));
  const focused = useRef(false);

  // Reconcile from the authoritative echo — but never while the user is editing
  // this field (that would fight the cursor).
  useEffect(() => {
    if (!focused.current) setText(toInputText(valueType, raw));
  }, [raw, valueType]);

  if (valueType === 'boolean') {
    return (
      <input
        type="checkbox"
        data-testid={`inspector-edit-${path}`}
        checked={raw === true}
        onChange={(e) => commitSetProp(nodeId, path, e.currentTarget.checked)}
      />
    );
  }

  return (
    <input
      data-testid={`inspector-edit-${path}`}
      className="w-full bg-transparent text-foreground outline-none focus:bg-elevated"
      type={valueType === 'number' ? 'number' : 'text'}
      value={text}
      placeholder={valueType === 'null' ? 'null' : undefined}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setText(toInputText(valueType, raw));
      }}
      onChange={(e) => {
        const next = e.currentTarget.value;
        setText(next);
        const parsed = parseEditInput(valueType, next);
        if (parsed.ok) commitSetProp(nodeId, path, parsed.value as JsonValue);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          setText(toInputText(valueType, raw));
          e.currentTarget.blur();
        } else if (e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
```

What changed: dropped the `useMemo`/`makeDebounced` import and the `DEBOUNCE_MS` constant; removed the `commit` memo and its stale-closure comment block; `onChange` now calls `commitSetProp(nodeId, path, parsed.value)` directly. Everything else (focus guard, reconcile effect, boolean branch, Escape/Enter) is unchanged.

- [ ] **Step 4: Run the unit test, watch it pass (GREEN)**

Run: `cd studio/frontend && npx vitest run src/plugins/property-inspector/EditableValue.spec.tsx`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Delete the now-unused `makeDebounced` from `edit.ts`**

In `studio/frontend/src/plugins/property-inspector/edit.ts`, delete the trailing block (lines ~42–49):

```ts
// Trailing-edge debounce; mirrors makeDebouncedSaver in state/persistence.ts.
export function makeDebounced<A extends unknown[]>(fn: (...args: A) => void, delayMs: number): (...args: A) => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), delayMs);
  };
}
```

Then in `studio/frontend/src/plugins/property-inspector/edit.spec.ts`: remove `makeDebounced` from the import on line 2 (leaving `valueTypeOf, toInputText, parseEditInput`), and delete the entire `describe('makeDebounced', ...)` block (lines ~42–57). Leave the `valueTypeOf`, `toInputText`, and `parseEditInput` describes intact.

Note: `state/persistence.ts` exports a different, unrelated `makeDebouncedSaver` used by layout/persistence — do **not** touch it.

- [ ] **Step 6: Run the full property-inspector unit suite (GREEN)**

Run: `npx nx test frontend` (from worktree root)
Expected: PASS — `EditableValue.spec.tsx`, `edit.spec.ts`, `commit.spec.ts`, `inspect.spec.ts`, `InspectorPane.spec.tsx` all green, no reference to `makeDebounced` remaining.

- [ ] **Step 7: Run the remaining CI gates**

Run, from the worktree root:

- `npx nx typecheck frontend` — Expected: PASS (no unused-import/type errors from the removed `useMemo`/`makeDebounced`).
- `npx nx build frontend` — Expected: PASS.
- `npx prettier --check .` — Expected: "All matched files use Prettier code style!". If it flags markdown due to a newer prettier, rerun `./node_modules/.bin/prettier --check .`.

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/property-inspector/EditableValue.tsx \
        studio/frontend/src/plugins/property-inspector/EditableValue.spec.tsx \
        studio/frontend/src/plugins/property-inspector/edit.ts \
        studio/frontend/src/plugins/property-inspector/edit.spec.ts
git commit -m "feat(inspector): commit every property change live (drop debounce)"
```

---

### Task 2: Prove per-change emission end-to-end

**Files:**

- Modify: `studio/frontend/e2e/mutable-inspector.spec.ts`

**Interfaces:**

- Consumes: the dev hooks already exposed by the studio — `window.__gameApplyInbound`, `window.__gameActiveId`, `window.__gameLastApplyOp` (each assignment is the latest emitted `{ gameId, op }`). The new test installs a setter trap on `window.__gameLastApplyOp` to record every assignment into `window.__opLog`.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Add an "emits one op per change" e2e test**

Append this test to `studio/frontend/e2e/mutable-inspector.spec.ts` (after the existing test, before EOF). It reuses the existing `openRoom` helper and the same seed pattern:

```ts
test('typing a multi-digit value emits one scene_apply_op per change', async ({ page }) => {
  await openRoom(page);

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game/preview').click();
  await expect(page.getByTestId('game-engine-frame')).toBeVisible({ timeout: 15000 });
  const gameId = await page.evaluate(() => (window as any).__gameActiveId as string | null);
  expect(gameId).toBeTruthy();

  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's1', type: 'Sprite', props: { x: 5, visible: true } } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e.child', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's1', port: 'parent' } },
    });
  }, gameId);

  // Record EVERY emitted op (not just the last) by trapping assignments.
  await page.evaluate(() => {
    const w = window as any;
    w.__opLog = [];
    let last: unknown;
    Object.defineProperty(w, '__gameLastApplyOp', {
      configurable: true,
      get: () => last,
      set: (v) => {
        last = v;
        w.__opLog.push(v);
      },
    });
  });

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-scene-graph/tree').click();
  await expect(page.getByTestId('scene-row-s1')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('scene-row-s1').click();

  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-property-inspector/panel').click();
  const xInput = page.getByTestId('inspector-edit-x');
  await expect(xInput).toHaveValue('5');

  // Clear, then type each digit. With no debounce, every keystroke that parses
  // emits its own setProp — 1, then 10, then 100.
  await xInput.fill('');
  await xInput.pressSequentially('100', { delay: 30 });

  await expect
    .poll(
      () => page.evaluate(() => ((window as any).__opLog ?? []).filter((o: any) => o?.op?.id === 's1' && o?.op?.path === 'x').map((o: any) => o.op.value)),
      { timeout: 5000 },
    )
    .toEqual([1, 10, 100]);
});
```

This asserts the exact per-change sequence `[1, 10, 100]` — proving no coalescing. The original "editing a scalar … emits a setProp scene_apply_op" test stays as-is (it uses `fill()`, a single change, and still passes).

- [ ] **Step 2: Bring up the replay backend (separate terminal)**

Run: `just backend-serve-replay`
Expected: uvicorn boots on :8001 (offset 1), `/health` reports replay mode. Leave it running.

- [ ] **Step 3: Run the e2e suite against replay (GREEN)**

Run, from the worktree root: `BLOOM_PORT_OFFSET=1 npx playwright test --config=studio/frontend/playwright.config.ts mutable-inspector`
Expected: both tests in `mutable-inspector.spec.ts` PASS, including the new `[1, 10, 100]` assertion. (Export `BLOOM_PORT_OFFSET=1` so Playwright targets this worktree's :4201/:8001 stack, not a default-port session.)

- [ ] **Step 4: Run the inspector round-trip regression too**

Run: `BLOOM_PORT_OFFSET=1 npx playwright test --config=studio/frontend/playwright.config.ts inspector-mutation-roundtrip`
Expected: PASS — confirms the debounce removal didn't break the persist-and-reconcile round-trip.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/mutable-inspector.spec.ts
git commit -m "test(inspector): e2e asserts one scene_apply_op per change"
```

---

## Self-Review

**Spec coverage:**

- "Remove the debounce; each parsed change emits immediately" → Task 1, Steps 3.
- "Mirror the boolean checkbox path" → Task 1, Step 3 (number `onChange` now calls `commitSetProp` directly like the checkbox).
- "Remove `makeDebounced` (verified only used here)" → Task 1, Step 5.
- "Behavioral nuance: `100` streams `1`/`10`/`100`; empty/lone-`-` emit nothing" → Task 1 unit tests (Step 1: "commits every change", "does not commit an empty/NaN number") + Task 2 e2e (`[1, 10, 100]`).
- "Unit: per-change emit + N→N, keep parse-gate + focus-reconcile cases" → Task 1, Step 1.
- "edit.spec.ts: remove makeDebounced tests" → Task 1, Step 5.
- "commit.spec.ts unaffected" → not modified; verified green in Step 6.
- "e2e: assert multiple scene_apply_op emits; run `just e2e` on replay first" → Task 2.
- "Out of scope: throttle / optimistic apply / batching" → none added.

**Placeholder scan:** none — every step has full file contents or exact commands.

**Type consistency:** `commitSetProp(nodeId, path, value)` signature matches `commit.ts`; `parseEditInput`/`toInputText`/`ScalarType` imports match `edit.ts`; the dev hooks (`__gameApplyInbound`, `__gameActiveId`, `__gameLastApplyOp`) match the existing `mutable-inspector.spec.ts` usage. `IEditableValueProps` keeps its `I` prefix. No dangling references to the deleted `makeDebounced`/`DEBOUNCE_MS`.

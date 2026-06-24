# llm-chat Scroll & Tool-Line Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Studio chat feed stick to the bottom while streaming (with a "jump to latest" affordance), and collapse the two bordered tool cards into one subtle, borderless line with a clear running indicator.

**Architecture:** Two independent, view-layer-only changes in `studio/frontend/src/plugins/llm-chat`. Feature A adds a `MessageScroller` wrapper owning scroll behaviour + a jump button, backed by a pure `isAtBottom` helper. Feature B adds a pure `foldToolSteps` transform that pairs `tool_call`/`tool_result` steps, plus a borderless restyle of the tool line in `RunTurnBlock`. Nothing touches the socket wire protocol, reducers, plugin state, or the backend.

**Tech Stack:** React 19 + TypeScript, Hookstate, Tailwind v4 (token utilities), Vitest + Testing Library (unit), Playwright (e2e), lucide-react icons.

## Global Constraints

- **TDD is mandatory** — write the failing test, watch it fail, then implement.
- **TypeScript interfaces use an `I` prefix** (`IScrollMetrics`, `IRenderStep`).
- **No raw colours outside `studio/frontend/src/styles.css`** — the
  `design-language.guard.spec.ts` guard scans `src` for hex/`rgba()` literals and
  must return zero hits. Use token utility classes (`bg-raised`, `text-accent-text`,
  `text-destructive`, …) in components; only `styles.css` may reference colours, and
  there only via `var(--token)`.
- **Design language:** 4 surfaces / 2 hairlines / 3 text tiers / 1 rationed accent.
  The done-state tick is calm muted (`text-muted-foreground`), NOT green — `--success`
  stays rationed.
- **Render-count discipline:** a streaming token must re-render only the streaming
  bubble/run block, never the `MessageList`/`ChatRoomPane` shell or sibling bubbles.
  The `ChatRoomPane.spec.tsx` render-count tests enforce this — do not regress them.
- **Conventional Commits** for every commit (`feat:`, `test:`, `refactor:`…).
- **Spec:** `docs/superpowers/specs/2026-06-23-chat-scroll-and-tool-lines-design.md`.
- Work happens in the worktree `C:\code\bloom.wt\chat-polish` on branch
  `feat/chat-polish`. Frontend root: `studio/frontend`. Run unit tests from there.

---

## File Structure

- **Create** `studio/frontend/src/plugins/llm-chat/scroll.ts` — pure `isAtBottom` helper (Feature A).
- **Create** `studio/frontend/src/plugins/llm-chat/scroll.spec.ts` — its unit tests.
- **Create** `studio/frontend/src/plugins/llm-chat/MessageScroller.tsx` — scroll-owning wrapper + jump button (Feature A).
- **Create** `studio/frontend/src/plugins/llm-chat/toolFold.ts` — pure `foldToolSteps` transform (Feature B).
- **Create** `studio/frontend/src/plugins/llm-chat/toolFold.spec.ts` — its unit tests.
- **Modify** `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` — `MessageList` renders children inside `MessageScroller` (Feature A).
- **Modify** `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` — render the folded steps; borderless collapsed tool line (Feature B).
- **Modify** `studio/frontend/src/styles.css` — token-only shimmer keyframe + reduced-motion fallback (Feature B).
- **Modify** `studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx` — assertions for the collapsed line (Feature B).
- **Modify** `studio/frontend/e2e/llm-chat.spec.ts` — sticky-scroll + jump-button e2e (Feature A).

Tasks 1–2 deliver Feature A; Tasks 3–4 deliver Feature B. The two features share no code and can land in either order.

---

## Task 1: `isAtBottom` scroll helper

Pure, layout-free predicate that decides whether the feed viewport is pinned to the bottom. Foundation for Feature A; no React, fully unit-testable.

**Files:**
- Create: `studio/frontend/src/plugins/llm-chat/scroll.ts`
- Test: `studio/frontend/src/plugins/llm-chat/scroll.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface IScrollMetrics { scrollTop: number; clientHeight: number; scrollHeight: number }`
  - `function isAtBottom(m: IScrollMetrics, threshold?: number): boolean` — `threshold` defaults to `48`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/scroll.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isAtBottom } from './scroll';

describe('isAtBottom', () => {
  it('is true exactly at the bottom', () => {
    expect(isAtBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });

  it('is true within the default 48px threshold', () => {
    expect(isAtBottom({ scrollTop: 570, clientHeight: 400, scrollHeight: 1000 })).toBe(true); // 30px from bottom
  });

  it('is false above the threshold', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 })).toBe(false); // 100px from bottom
  });

  it('treats a zero-size container as pinned (fresh/unlaid-out feed)', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 })).toBe(true);
  });

  it('honours a custom threshold', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }, 150)).toBe(true); // 100px gap, 150 threshold
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/scroll.spec.ts`
Expected: FAIL — `Failed to resolve import "./scroll"` / `isAtBottom is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/scroll.ts`:

```ts
export interface IScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

/**
 * True when the viewport is at (or within `threshold` px of) the bottom of the
 * scroll container. Used to decide whether streaming content should keep the
 * feed pinned. A zero-size container (jsdom / not yet laid out) reports as
 * pinned — the safe default for a fresh feed.
 */
export function isAtBottom(m: IScrollMetrics, threshold = 48): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/scroll.spec.ts`
Expected: PASS (5 passing).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/scroll.ts studio/frontend/src/plugins/llm-chat/scroll.spec.ts
git commit -m "feat(llm-chat): add isAtBottom scroll helper"
```

---

## Task 2: `MessageScroller` — sticky-bottom feed + jump button

Wrap the message `<ul>` in a component that follows content while pinned, leaves the user alone when scrolled up, and shows a floating "jump to latest" button. Bubbles are passed as `children`, so the scroller's own `showJump` state never re-renders them.

**Files:**
- Create: `studio/frontend/src/plugins/llm-chat/MessageScroller.tsx`
- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` (the `MessageList` function, around lines 64–87)
- Test (unit, render-count safety): `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx` (existing suite must still pass; add one jump-button test)
- Test (e2e, authoritative): `studio/frontend/e2e/llm-chat.spec.ts`

**Interfaces:**
- Consumes: `isAtBottom`, `IScrollMetrics` from `./scroll` (Task 1).
- Produces: `function MessageScroller({ children }: { children: ReactNode }): JSX.Element` — renders `<ul data-testid="chat-messages">` (the scroll container, direct parent of the feed children) plus a `data-testid="chat-jump-latest"` button as an absolutely-positioned sibling (NOT a child of the `<ul>`, so feed child-ordering tests are unaffected).

- [ ] **Step 1: Write the failing unit test (jump button hidden by default)**

Add to `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`, inside the existing top-level `describe('ChatRoomPane', …)` block (after the "drops the caret" test, before the closing `});` of that describe):

```ts
  it('does not show the jump-to-latest button when freshly rendered (pinned)', () => {
    chatSlice().messages.set([msg({ id: 'j1', content: 'hi', status: 'complete' })]);
    render(<ChatRoomPane />);
    // jsdom reports a zero-size container → isAtBottom true → pinned → no button.
    expect(screen.queryByTestId('chat-jump-latest')).toBeNull();
    // The scroll container is still present and is the parent of the feed item.
    expect(screen.getByTestId('chat-messages')).toContainElement(screen.getByTestId('chat-msg-j1'));
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx -t "jump-to-latest"`
Expected: FAIL — `chat-jump-latest` query path differs / `MessageScroller` not yet wired (the test asserts the new structure). It is acceptable if it fails on the new containment assertion before the refactor.

- [ ] **Step 3: Create the `MessageScroller` component**

Create `studio/frontend/src/plugins/llm-chat/MessageScroller.tsx`:

```tsx
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown } from 'lucide-react';
import { isAtBottom } from './scroll';

/**
 * Owns the scrollable message viewport. Keeps the feed pinned to the bottom
 * while the user is already at the bottom (so streaming replies follow), but
 * leaves them alone once they scroll up — surfacing a "jump to latest" button
 * instead. Bubbles are passed as `children`, so this component's own `showJump`
 * state never re-renders them (render-count discipline preserved).
 */
export function MessageScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = () => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  // Follow content growth — new entries AND streaming token text. A
  // MutationObserver catches characterData mutations that never re-render this
  // shell; it is natively available in jsdom, so unit tests need no polyfill.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      if (pinnedRef.current) scrollToBottom();
    });
    obs.observe(el, { childList: true, subtree: true, characterData: true });
    return () => obs.disconnect();
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const pinned = isAtBottom({ scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight });
    pinnedRef.current = pinned;
    // Only flip state when the boolean actually changes — no per-event churn.
    setShowJump((prev) => (prev === !pinned ? prev : !pinned));
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <ul ref={ref} data-testid="chat-messages" onScroll={onScroll} className="m-0 flex h-full list-none flex-col gap-1.5 overflow-auto p-0">
        {children}
      </ul>
      {showJump && (
        <button
          type="button"
          data-testid="chat-jump-latest"
          aria-label="Jump to latest"
          onClick={() => {
            scrollToBottom();
            pinnedRef.current = true;
            setShowJump(false);
          }}
          className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-full border border-border bg-raised text-muted-foreground shadow-md hover:bg-raised-hover hover:text-foreground"
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire `MessageScroller` into `MessageList`**

In `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`, add the import near the other local imports (after the `buildFeed` import on line 10):

```tsx
import { MessageScroller } from './MessageScroller';
```

Then replace the `return (...)` block of the `MessageList` function (currently the `<ul data-testid="chat-messages" …>…</ul>`, lines ~80–85) with:

```tsx
  return (
    <MessageScroller>
      {feed.map((entry) =>
        entry.kind === 'message' ? <ChatMessageBubble key={`m:${entry.id}`} index={entry.index} /> : <RunTurnBlock key={`r:${entry.id}`} index={entry.index} />,
      )}
    </MessageScroller>
  );
```

(The `<ul data-testid="chat-messages">` now lives inside `MessageScroller`; `MessageList` no longer renders it directly.)

- [ ] **Step 5: Run the unit suite to verify it passes (and render-count tests still green)**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: PASS — all existing tests (including "appending a token re-renders only that bubble", "a run-step token re-renders only the run block", and the unified-feed child-order test `['chat-msg-u1','run-turn-run1','chat-msg-u2']`) plus the new jump-button test. If the child-order test fails, confirm the jump button is a sibling of the `<ul>`, not a child.

- [ ] **Step 6: Add the authoritative e2e for sticky scroll + jump button**

Add to `studio/frontend/e2e/llm-chat.spec.ts` (append a new `test` at the end of the file, before EOF). It uses the existing `openChat`/`createRoom` helpers defined at the top of that file:

```ts
test('feed sticks to the bottom while pinned, and offers jump-to-latest when scrolled up', async ({ page }) => {
  await openChat(page, 'alice');
  await createRoom(page, `Scroll ${Date.now()}`);

  const feed = page.getByTestId('chat-messages');

  // Fill the feed past one viewport so it becomes scrollable.
  for (let i = 0; i < 12; i++) {
    await page.getByTestId('chat-composer').fill(`message number ${i}`);
    await page.getByTestId('chat-send').click();
    await expect(feed).toContainText(`message number ${i}`);
  }

  // Pinned: the latest message is at/near the bottom and no jump button shows.
  await expect(page.getByTestId('chat-jump-latest')).toHaveCount(0);
  const atBottom = await feed.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
  expect(atBottom).toBe(true);

  // Scroll up → the jump button appears.
  await feed.evaluate((el) => (el.scrollTop = 0));
  await expect(page.getByTestId('chat-jump-latest')).toBeVisible();

  // Click it → feed returns to the bottom and the button hides again.
  await page.getByTestId('chat-jump-latest').click();
  await expect(page.getByTestId('chat-jump-latest')).toHaveCount(0);
  const backAtBottom = await feed.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
  expect(backAtBottom).toBe(true);
});
```

- [ ] **Step 7: Run the e2e spec (requires a replay backend on :8000)**

Confirm no other session holds the stack (`git worktree list`; check :8000/:4200). Start the replay backend (`just backend-serve-replay`) if not already running, then:

Run: `cd studio/frontend && npx playwright test e2e/llm-chat.spec.ts -g "sticks to the bottom"`
Expected: PASS. (If the stack is busy in another session, defer this step and note it; do not start a second stack.)

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/MessageScroller.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx studio/frontend/e2e/llm-chat.spec.ts
git commit -m "feat(llm-chat): sticky-bottom feed with jump-to-latest"
```

---

## Task 3: `foldToolSteps` — pair tool_call/tool_result into one render step

Pure transform that folds each `tool_call` (+ its later `tool_result`) into a single merged tool entry, passing every other step type through untouched. Foundation for Feature B; no React.

**Files:**
- Create: `studio/frontend/src/plugins/llm-chat/toolFold.ts`
- Test: `studio/frontend/src/plugins/llm-chat/toolFold.spec.ts`

**Interfaces:**
- Consumes: `IRunStep` from `./state`.
- Produces:
  - `type IRenderStep = { kind: 'passthrough'; step: IRunStep } | { kind: 'tool'; callIndex: number; toolName: string | null; status: IRunStep['status'] }`
  - `function foldToolSteps(steps: IRunStep[]): IRenderStep[]`
  - Merged tool `status`: `error` if the call **or** result errored; `complete` once a paired result with status `complete` arrives; otherwise `running` (a call with no result yet). `callIndex` is the source index of the `tool_call` step (used as the React key and `data-testid` suffix). A `tool_result` with no matching preceding `tool_call` becomes its own `tool` entry keyed by the result's index.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/toolFold.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { foldToolSteps } from './toolFold';
import type { IRunStep } from './state';

const step = (over: Partial<IRunStep>): IRunStep => ({
  index: 0,
  type: 'tool_call',
  toolName: null,
  content: '',
  status: 'complete',
  ...over,
});

describe('foldToolSteps', () => {
  it('pairs an adjacent tool_call + tool_result into one complete tool entry', () => {
    const out = foldToolSteps([
      step({ index: 0, type: 'tool_call', toolName: 'generate_asset', status: 'complete' }),
      step({ index: 1, type: 'tool_result', toolName: 'generate_asset', status: 'complete' }),
    ]);
    expect(out).toEqual([{ kind: 'tool', callIndex: 0, toolName: 'generate_asset', status: 'complete' }]);
  });

  it('treats a lone tool_call (no result yet) as running', () => {
    const out = foldToolSteps([step({ index: 0, type: 'tool_call', toolName: 'generate_asset', status: 'complete' })]);
    expect(out).toEqual([{ kind: 'tool', callIndex: 0, toolName: 'generate_asset', status: 'running' }]);
  });

  it('propagates error from the result', () => {
    const out = foldToolSteps([
      step({ index: 0, type: 'tool_call', toolName: 'delete_asset', status: 'complete' }),
      step({ index: 1, type: 'tool_result', toolName: 'delete_asset', status: 'error' }),
    ]);
    expect(out[0]).toMatchObject({ kind: 'tool', status: 'error' });
  });

  it('propagates error from the call even before a result', () => {
    const out = foldToolSteps([step({ index: 0, type: 'tool_call', toolName: 'x', status: 'error' })]);
    expect(out[0]).toMatchObject({ kind: 'tool', status: 'error' });
  });

  it('passes thinking/final steps through untouched, in order', () => {
    const thinking = step({ index: 0, type: 'thinking', toolName: null, content: 'hmm', status: 'complete' });
    const final = step({ index: 1, type: 'final', toolName: null, content: 'done', status: 'complete' });
    const out = foldToolSteps([thinking, final]);
    expect(out).toEqual([
      { kind: 'passthrough', step: thinking },
      { kind: 'passthrough', step: final },
    ]);
  });

  it('folds two separate same-named call/result pairs into two tool entries', () => {
    const out = foldToolSteps([
      step({ index: 0, type: 'tool_call', toolName: 'gen', status: 'complete' }),
      step({ index: 1, type: 'tool_result', toolName: 'gen', status: 'complete' }),
      step({ index: 2, type: 'tool_call', toolName: 'gen', status: 'complete' }),
      step({ index: 3, type: 'tool_result', toolName: 'gen', status: 'complete' }),
    ]);
    expect(out).toEqual([
      { kind: 'tool', callIndex: 0, toolName: 'gen', status: 'complete' },
      { kind: 'tool', callIndex: 2, toolName: 'gen', status: 'complete' },
    ]);
  });

  it('renders an orphan tool_result defensively as its own entry', () => {
    const out = foldToolSteps([step({ index: 5, type: 'tool_result', toolName: 'gen', status: 'complete' })]);
    expect(out).toEqual([{ kind: 'tool', callIndex: 5, toolName: 'gen', status: 'complete' }]);
  });

  it('keeps a tool entry interleaved with passthrough steps in source order', () => {
    const thinking = step({ index: 0, type: 'thinking', toolName: null, content: 'plan', status: 'complete' });
    const out = foldToolSteps([
      thinking,
      step({ index: 1, type: 'tool_call', toolName: 'gen', status: 'complete' }),
      step({ index: 2, type: 'tool_result', toolName: 'gen', status: 'complete' }),
      step({ index: 3, type: 'final', toolName: null, content: 'ok', status: 'complete' }),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['passthrough', 'tool', 'passthrough']);
    expect(out[1]).toMatchObject({ kind: 'tool', callIndex: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/toolFold.spec.ts`
Expected: FAIL — `Failed to resolve import "./toolFold"`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/toolFold.ts`:

```ts
import type { IRunStep } from './state';

export type IRenderStep =
  | { kind: 'passthrough'; step: IRunStep }
  | { kind: 'tool'; callIndex: number; toolName: string | null; status: IRunStep['status'] };

type IToolEntry = Extract<IRenderStep, { kind: 'tool' }>;

/**
 * Fold each tool_call (+ its later tool_result) into one merged tool entry, so a
 * tool renders as a single line instead of two cards. Non-tool steps pass
 * through untouched in source order. Pairing matches a tool_result to the
 * earliest still-unmatched tool_call with the same name (in this sequential
 * runner there is only ever one open call, so ordering is unambiguous).
 */
export function foldToolSteps(steps: IRunStep[]): IRenderStep[] {
  const out: IRenderStep[] = [];
  const openCalls: IToolEntry[] = []; // unmatched tool_call entries already pushed to `out`

  for (const step of steps) {
    if (step.type === 'tool_call') {
      const entry: IToolEntry = {
        kind: 'tool',
        callIndex: step.index,
        toolName: step.toolName,
        status: step.status === 'error' ? 'error' : 'running',
      };
      out.push(entry);
      openCalls.push(entry);
    } else if (step.type === 'tool_result') {
      const matchAt = openCalls.findIndex((c) => c.toolName === step.toolName);
      if (matchAt === -1) {
        out.push({ kind: 'tool', callIndex: step.index, toolName: step.toolName, status: step.status });
      } else {
        const entry = openCalls[matchAt];
        openCalls.splice(matchAt, 1);
        entry.status = entry.status === 'error' || step.status === 'error' ? 'error' : step.status;
      }
    } else {
      out.push({ kind: 'passthrough', step });
    }
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/toolFold.spec.ts`
Expected: PASS (8 passing).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/toolFold.ts studio/frontend/src/plugins/llm-chat/toolFold.spec.ts
git commit -m "feat(llm-chat): add foldToolSteps tool-pairing transform"
```

---

## Task 4: Borderless collapsed tool line in `RunTurnBlock`

Render the folded steps. Replace the two bordered tool cards with one subtle, borderless line: spinner + shimmering name while running, calm `✓` + muted name when done, `✕` + danger text on error. Add the token-only shimmer keyframe to `styles.css`.

**Files:**
- Modify: `studio/frontend/src/styles.css` (append after the scrollbar block, ~line 144)
- Modify: `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` (`RunStepCard` tool branch, lines ~17–34; `RunTurnBlock` step mapping, lines ~68–72)
- Test: `studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx`

**Interfaces:**
- Consumes: `foldToolSteps`, `IRenderStep` from `./toolFold` (Task 3); `Loader2`, `Check`, `X` from `lucide-react`.
- Produces: the merged tool line renders as `<div data-testid="run-step-${callIndex}" data-state="running|complete|error">` with no border/background. Approval/question/thinking/final rendering is unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the first test in `studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx` (the `it('renders tool and final steps inside a grouped assistant turn', …)` block, lines ~22–38) with these three tests (keep the other two tests in the file unchanged):

```ts
  it('renders a completed tool as one borderless line with data-state=complete', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'generate_asset', content: 'ok', status: 'complete' },
          { index: 2, type: 'final', toolName: null, content: 'Done.', status: 'running' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    // The two tool steps collapse into ONE line keyed by the call index.
    const tool = screen.getByTestId('run-step-0');
    expect(tool.getAttribute('data-state')).toBe('complete');
    expect(tool.textContent).toContain('generate_asset');
    expect(tool.className).not.toContain('border'); // borderless
    // No separate tool-result line is rendered.
    expect(screen.queryByTestId('run-step-1')).toBeNull();
    // The final step still renders as text.
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });

  it('marks a tool with no result yet as data-state=running', () => {
    chatSlice().runs.set([
      run({ steps: [{ index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' }] }),
    ]);
    render(<RunTurnBlock index={0} />);
    expect(screen.getByTestId('run-step-0').getAttribute('data-state')).toBe('running');
  });

  it('marks an errored tool as data-state=error', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'delete_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'tool_result', toolName: 'delete_asset', content: 'boom', status: 'error' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const tool = screen.getByTestId('run-step-0');
    expect(tool.getAttribute('data-state')).toBe('error');
    expect(tool.className).toContain('text-destructive');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/RunTurnBlock.spec.tsx`
Expected: FAIL — current code renders `data-testid="run-step-0"` as a bordered card with no `data-state`, and still renders `run-step-1`; the new assertions fail.

- [ ] **Step 3: Add the token-only shimmer keyframe to `styles.css`**

In `studio/frontend/src/styles.css`, append after the `*::-webkit-scrollbar-track { … }` block (around line 144), before the `/* === Dockview … === */` block:

```css
/* Tool-line "running" shimmer — token-only (no raw colours leave this file). */
@keyframes bloom-tool-shimmer {
  0% {
    background-position: 200% 0;
  }
  100% {
    background-position: -200% 0;
  }
}
.tool-shimmer {
  background: linear-gradient(90deg, var(--text-3) 0%, var(--text-1) 50%, var(--text-3) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: bloom-tool-shimmer 1.6s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .tool-shimmer {
    animation: none;
    background: none;
    color: var(--text-2);
    -webkit-background-clip: border-box;
    background-clip: border-box;
  }
}
```

- [ ] **Step 4: Rewrite the tool branch of `RunStepCard` and the step mapping in `RunTurnBlock.tsx`**

Update the imports at the top of `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx`:

```tsx
import { memo } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { llmChatHooks } from './state';
import type { IRunStep } from './state';
import { ApprovalCard } from './ApprovalCard';
import { QuestionCard } from './QuestionCard';
import { bumpRenderCount } from '../../app/renderCount';
import { foldToolSteps, type IRenderStep } from './toolFold';
```

Replace the `isToolStep` block of `RunStepCard` (the `if (isToolStep) { return ( … ); }` at lines ~21–34) with a dedicated `ToolLine` component. Add this component just above `RunStepCard`:

```tsx
function ToolLine({ callIndex, toolName, status }: { callIndex: number; toolName: string | null; status: IRunStep['status'] }) {
  const isRunning = status === 'running';
  const isError = status === 'error';
  return (
    <div
      data-testid={`run-step-${callIndex}`}
      data-state={status}
      className={`flex items-center gap-1.5 text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
    >
      {isRunning ? (
        <Loader2 aria-label="running" className="h-3 w-3 flex-none animate-spin text-accent-text" />
      ) : isError ? (
        <X aria-hidden className="h-3 w-3 flex-none" />
      ) : (
        <Check aria-hidden className="h-3 w-3 flex-none" />
      )}
      <span className={isRunning ? 'tool-shimmer' : undefined}>{toolName ?? 'tool'}</span>
    </div>
  );
}
```

Now `RunStepCard` only handles approval/question/passthrough steps. Replace the whole `RunStepCard` function so its signature takes an `IRunStep` for non-tool steps (tools are rendered by `ToolLine` from the parent). Replace lines ~10–45 with:

```tsx
function RunStepCard({ step, index, runId }: { step: IReadonlyRunStep; index: number; runId: string }) {
  if (step.type === 'approval') {
    return <ApprovalCard runId={runId} step={step as IRunStep} />;
  }
  if (step.type === 'question') {
    return <QuestionCard runId={runId} step={step as IRunStep} />;
  }
  const isRunning = step.status === 'running';
  // thinking | final — render as streamed text (assistant-bubble typography)
  return (
    <div data-testid={`run-step-${index}`} className="text-[13px] leading-snug text-foreground">
      {step.content}
      {isRunning && (
        <span data-testid={`run-step-caret-${index}`} className="ml-0.5 inline-block h-3 w-1.5 translate-y-0.5 rounded-sm bg-primary align-baseline" />
      )}
    </div>
  );
}
```

Finally, update the `RunTurnBlock` body to fold the steps and dispatch each render entry. Replace the steps `.map(...)` (lines ~68–72) with:

```tsx
      <div className="flex min-w-0 flex-col gap-2">
        {foldToolSteps(steps).map((entry: IRenderStep) =>
          entry.kind === 'tool' ? (
            <ToolLine key={`t:${entry.callIndex}`} callIndex={entry.callIndex} toolName={entry.toolName} status={entry.status} />
          ) : (
            <RunStepCard key={`s:${entry.step.index}`} step={entry.step} index={entry.step.index} runId={id} />
          ),
        )}
      </div>
```

(`steps` is already read via `r.steps.get()` earlier in `RunTurnBlock`; `foldToolSteps` runs on every render of this block, which is exactly when steps change.)

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/RunTurnBlock.spec.tsx`
Expected: PASS — the three new tests plus the unchanged approval-card and avatar-chip tests.

- [ ] **Step 6: Run the no-raw-color guard + the llm-chat unit suite**

Run: `cd studio/frontend && npx vitest run src/design-language.guard.spec.ts src/plugins/llm-chat`
Expected: PASS — guard returns zero hits (shimmer colours live only in `styles.css` via `var(--token)`), and all llm-chat unit tests are green.

- [ ] **Step 7: Verify the happy-path e2e still passes (tool name still shown once)**

Requires a replay backend on :8000 (coordinate the stack as in Task 2, Step 7).

Run: `cd studio/frontend && npx playwright test e2e/skill-run.spec.ts -g "shows the tool call and final text"`
Expected: PASS — `chat-messages` still `toContainText('generate_asset')` (now once, on the collapsed line). If the stack is busy elsewhere, defer and note it.

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx studio/frontend/src/styles.css
git commit -m "feat(llm-chat): collapse tool steps into one borderless line"
```

---

## Final verification (before PR)

- [ ] **Frontend CI gates** (all four — vitest green alone is not enough):
  Run from `studio/frontend`:
  - `npx prettier --check .`
  - `npx nx typecheck frontend` (or the repo's typecheck script)
  - `npx vitest run`
  - `npx nx build frontend` (or the repo's build script)
  Expected: all pass. Fix any prettier/type errors before pushing.

- [ ] **Full e2e** (authoritative; replay backend on :8000, coordinate the singleton stack):
  Run: `just e2e`
  Expected: green, including the new scroll spec and the unchanged skill-run specs.

- [ ] **Open the PR** (do not present a menu — push + PR directly, per AGENTS.md):

```bash
git push -u origin feat/chat-polish
gh pr create --fill
```

---

## Self-Review notes (author)

- **Spec coverage:** Feature A.pinned-tracking → Task 1 (`isAtBottom`) + Task 2 (`onScroll`/`pinnedRef`); A.following-content → Task 2 (`MutationObserver`); A.jump-button → Task 2; A.render-count-preservation → Task 2 Step 5 (existing render-count tests). Feature B.fold → Task 3 (`foldToolSteps`); B.line-appearance (spinner/shimmer/check/✕) → Task 4 (`ToolLine` + shimmer CSS); B.error-no-card → Task 4 error test; B.stable-hooks (`data-testid`/`data-state`) → Task 4; B.reduced-motion → Task 4 Step 3. Out-of-scope items are not implemented. All spec sections map to a task.
- **Placeholder scan:** none — every code/CSS/test block is concrete.
- **Type consistency:** `isAtBottom(IScrollMetrics, threshold?)`, `foldToolSteps(IRunStep[]): IRenderStep[]`, and the `IRenderStep` union are referenced identically across Tasks 1–4. `ToolLine` consumes exactly the `{ callIndex, toolName, status }` produced by the `tool` variant.

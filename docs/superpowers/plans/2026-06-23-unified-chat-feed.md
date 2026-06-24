# Unified Chronological Chat Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold skill-run steps into the chat message feed as grouped assistant-turn blocks, retiring the separate `RunTimeline` so there is one unified, chronologically-correct chat feed.

**Architecture:** Keep the backend run model and `run_*` socket wire as-is (frontend-fold). The frontend keeps two source collections — `messages[]` and `runs[]` — and a pure `buildFeed` selector merges them into one timestamp-ordered feed. Each feed entry renders by kind: a chat bubble or a grouped `RunTurnBlock`. A new `GET /rooms/:id/runs` endpoint plus a runs fetch on room open makes the feed correct after reload.

**Tech Stack:** React + hookstate (frontend), Vitest (unit), Playwright (e2e); FastAPI + Motor/MongoDB + Pydantic (backend), pytest (backend unit).

## Global Constraints

- TypeScript interfaces always use an `I` prefix (`IFeedEntry`, `IRun`).
- Studio UI follows `docs/design-language.md`; raw colors outside `styles.css` are blocked by a guard test — reuse existing Tailwind tokens (`bg-surface`, `border-primary/50`, `text-accent-text`, etc.).
- Conventional Commits for every commit; imperative mood.
- TDD is mandatory: failing test → minimal code → pass → commit.
- Render-count discipline: a streaming token must re-render only the streaming entry, never sibling entries or the list shell (`window.__renderCounts` via `bumpRenderCount`).
- Wire models camelCase via `_WireModel` (`to_camel`); `run_wire` already emits `createdAt`, `roomId`, `skillName`, steps with `toolName`.
- Playwright e2e is the authoritative behavioral contract; it is NOT run in CI — run locally before the PR.

---

## File Structure

**Backend**

- `studio/backend/app/runs.py` — add `RunStore.list_runs(room_id)`.
- `studio/backend/app/rest.py` — add `GET /rooms/{room_id}/runs`.
- `studio/backend/app/main.py` — attach `fastapi_app.state.run_store = run_store`.

**Frontend**

- `studio/frontend/src/plugins/llm-chat/state.ts` — add `createdAt` to `IRun`.
- `studio/frontend/src/plugins/llm-chat/feed.ts` — NEW: `IFeedEntry` + `buildFeed`.
- `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` — NEW: grouped assistant turn (absorbs `RunStepCard` rendering).
- `studio/frontend/src/plugins/llm-chat/restClient.ts` — add `getRuns`.
- `studio/frontend/src/plugins/llm-chat/actions.ts` — `openRoom` fetch+reset runs; `closeRoom` reset runs; `IRestDeps` gains `getRuns`.
- `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` — `MessageList` renders the unified feed; drop `<RunTimeline />`.
- `studio/frontend/src/plugins/llm-chat/RunTimeline.tsx` + `RunTimeline.spec.tsx` — DELETED.

**Tests**

- `studio/backend/tests/test_run_store.py`, `studio/backend/tests/test_rest.py`
- `studio/frontend/src/plugins/llm-chat/feed.spec.ts` (NEW), `RunTurnBlock.spec.tsx` (NEW), `restClient.spec.ts`, `actions.spec.ts`, `reducers.spec.ts`, `ChatRoomPane.spec.tsx`
- `studio/frontend/e2e/skill-run.spec.ts`

---

## Task 1: Backend — list runs endpoint

**Files:**

- Modify: `studio/backend/app/runs.py` (add `list_runs` to `RunStore`)
- Modify: `studio/backend/app/main.py:64` area (attach `run_store` to app state)
- Modify: `studio/backend/app/rest.py:94-101` area (new route after `/messages`)
- Test: `studio/backend/tests/test_run_store.py`, `studio/backend/tests/test_rest.py`

**Interfaces:**

- Produces: `RunStore.list_runs(room_id: str) -> list[Run]` (sorted by `created_at` ascending); `GET /rooms/{room_id}/runs -> list[dict]` (each `run_wire(run)`), 404 when the room does not exist.

- [ ] **Step 1: Write the failing store test**

In `studio/backend/tests/test_run_store.py`, append:

```python
async def test_list_runs_returns_room_runs_in_creation_order(store):
    a = await store.create_run("r1", "skill-a", {})
    b = await store.create_run("r1", "skill-b", {})
    await store.create_run("other", "skill-c", {})
    runs = await store.list_runs("r1")
    assert [r.id for r in runs] == [a.id, b.id]
    assert all(r.room_id == "r1" for r in runs)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_run_store.py -k list_runs -v`
Expected: FAIL — `AttributeError: 'RunStore' object has no attribute 'list_runs'`.

- [ ] **Step 3: Implement `list_runs`**

In `studio/backend/app/runs.py`, add to `RunStore` (after `complete_run`):

```python
    async def list_runs(self, room_id: str) -> list[Run]:
        cursor = self._runs.find({"room_id": room_id}).sort("created_at", 1)
        return [_from_doc(doc) async for doc in cursor]
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_run_store.py -k list_runs -v`
Expected: PASS.

- [ ] **Step 5: Write the failing endpoint test**

In `studio/backend/tests/test_rest.py`, append (mirrors `test_history_endpoint_and_404`):

```python
@pytest.mark.asyncio
async def test_runs_endpoint_and_404(ctx, mongo_db):
    from app.runs import RunStore

    async with _client(ctx) as client:
        created = await client.post("/rooms", json={"name": "R", "model": "m:free"})
        room_id = created.json()["id"]
        run_store = RunStore(mongo_db)
        await run_store.create_run(room_id, "generate-sprite", {"description": "knight"})

        listed = await client.get(f"/rooms/{room_id}/runs")
        assert listed.status_code == 200
        body = listed.json()
        assert len(body) == 1
        assert body[0]["skillName"] == "generate-sprite"
        assert "createdAt" in body[0]

        missing = await client.get("/rooms/nope/runs")
        assert missing.status_code == 404
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd studio/backend && uv run pytest tests/test_rest.py -k runs_endpoint -v`
Expected: FAIL — 404 for the valid room (route missing) or 500 (`run_store` not on app state).

- [ ] **Step 7: Attach `run_store` to app state**

In `studio/backend/app/main.py`, in the `fastapi_app.state.*` block (alongside `fastapi_app.state.store = store`, ~line 64; `run_store` is created lower at ~line 77, so add this line AFTER `run_store = RunStore(...)`):

```python
    fastapi_app.state.run_store = run_store
```

- [ ] **Step 8: Add the route**

In `studio/backend/app/rest.py`, after `list_messages` (the `/rooms/{room_id}/messages` handler), add:

```python
@router.get("/rooms/{room_id}/runs")
async def list_runs(room_id: str, request: Request) -> list[dict]:
    store = request.app.state.store
    room = await store.get_room(room_id)
    if room is None:
        raise HTTPException(status_code=404, detail="room not found")
    run_store = request.app.state.run_store
    runs = await run_store.list_runs(room_id)
    from app.runs import run_wire

    return [run_wire(r) for r in runs]
```

- [ ] **Step 9: Run the endpoint test to verify it passes**

Run: `cd studio/backend && uv run pytest tests/test_rest.py -k runs_endpoint -v`
Expected: PASS.

- [ ] **Step 10: Run the full backend unit suite**

Run: `cd studio/backend && uv run pytest -m "not e2e" -q`
Expected: PASS (no regressions).

- [ ] **Step 11: Commit**

```bash
git add studio/backend/app/runs.py studio/backend/app/main.py studio/backend/app/rest.py studio/backend/tests/test_run_store.py studio/backend/tests/test_rest.py
git commit -m "feat(studio): GET /rooms/:id/runs + RunStore.list_runs"
```

---

## Task 2: Frontend — `IRun.createdAt`

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/state.ts:72-78` (`IRun`)
- Test: `studio/frontend/src/plugins/llm-chat/reducers.spec.ts`

**Interfaces:**

- Produces: `IRun.createdAt: string`. The `run_started` / `run_snapshot` wire already carries `createdAt`; `startRun` / `applyRunSnapshot` store the whole run object, so the field flows through unchanged — this task only types it and locks it with a test.

- [ ] **Step 1: Write the failing reducer test**

In `studio/frontend/src/plugins/llm-chat/reducers.spec.ts`, add a test (place it with the other `startRun` tests; if none import `startRun`, add the import from `./reducers`):

```ts
it('startRun preserves createdAt on the stored run', () => {
  const run = { id: 'run1', roomId: 'r1', skillName: 's', status: 'running', steps: [], createdAt: '2026-06-23T00:00:01Z' } as IRun;
  const out = startRun([], run);
  expect(out[0].createdAt).toBe('2026-06-23T00:00:01Z');
});
```

If `IRun` / `startRun` are not already imported in this file, add:
`import { startRun } from './reducers';` and `import type { IRun } from './state';`

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/reducers.spec.ts`
Expected: FAIL — TypeScript error: `createdAt` does not exist on type `IRun`.

- [ ] **Step 3: Add the field**

In `studio/frontend/src/plugins/llm-chat/state.ts`, extend `IRun`:

```ts
export interface IRun {
  id: string;
  roomId: string;
  skillName: string;
  status: 'running' | 'completed' | 'error';
  steps: IRunStep[];
  createdAt: string;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/reducers.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/reducers.spec.ts
git commit -m "feat(studio): add createdAt to IRun"
```

---

## Task 3: Frontend — `buildFeed` selector

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/feed.ts`
- Test: `studio/frontend/src/plugins/llm-chat/feed.spec.ts`

**Interfaces:**

- Consumes: nothing (pure function over light descriptors).
- Produces:

  ```ts
  export interface IFeedEntry {
    kind: 'message' | 'run';
    id: string;
    createdAt: string;
    index: number;
  }
  export function buildFeed(messages: { id: string; createdAt: string }[], runs: { id: string; createdAt: string }[]): IFeedEntry[];
  ```

  `index` is the entry's position in its OWN source array (so renderers can subscribe to `s.messages[index]` / `s.runs[index]`). Sorted ascending by `createdAt`; equal timestamps keep message-before-run, then source order.

- [ ] **Step 1: Write the failing tests**

Create `studio/frontend/src/plugins/llm-chat/feed.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildFeed } from './feed';

const m = (id: string, createdAt: string) => ({ id, createdAt });

describe('buildFeed', () => {
  it('interleaves messages and runs by createdAt', () => {
    const messages = [m('u1', '2026-06-23T00:00:00Z'), m('u2', '2026-06-23T00:00:05Z'), m('a3', '2026-06-23T00:00:09Z')];
    const runs = [m('run1', '2026-06-23T00:00:02Z')];
    const feed = buildFeed(messages, runs);
    expect(feed.map((e) => e.id)).toEqual(['u1', 'run1', 'u2', 'a3']);
    expect(feed.map((e) => e.kind)).toEqual(['message', 'run', 'message', 'message']);
  });

  it('carries the source-array index for each kind', () => {
    const messages = [m('u1', '2026-06-23T00:00:00Z'), m('u2', '2026-06-23T00:00:05Z')];
    const runs = [m('run1', '2026-06-23T00:00:02Z')];
    const feed = buildFeed(messages, runs);
    expect(feed.find((e) => e.id === 'u2')).toMatchObject({ kind: 'message', index: 1 });
    expect(feed.find((e) => e.id === 'run1')).toMatchObject({ kind: 'run', index: 0 });
  });

  it('orders a message before a run when timestamps are equal', () => {
    const feed = buildFeed([m('u1', '2026-06-23T00:00:02Z')], [m('run1', '2026-06-23T00:00:02Z')]);
    expect(feed.map((e) => e.id)).toEqual(['u1', 'run1']);
  });

  it('handles empty inputs', () => {
    expect(buildFeed([], [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/feed.spec.ts`
Expected: FAIL — cannot find module `./feed`.

- [ ] **Step 3: Implement the selector**

Create `studio/frontend/src/plugins/llm-chat/feed.ts`:

```ts
export interface IFeedEntry {
  kind: 'message' | 'run';
  id: string;
  createdAt: string;
  index: number;
}

/**
 * Merge the two source collections into one chronologically-ordered feed.
 * `index` is each entry's position in its OWN source array, so renderers can
 * subscribe to the matching hookstate node (`s.messages[index]` / `s.runs[index]`).
 * Stable: equal timestamps keep message-before-run, then source order.
 */
export function buildFeed(messages: { id: string; createdAt: string }[], runs: { id: string; createdAt: string }[]): IFeedEntry[] {
  const entries: IFeedEntry[] = [
    ...messages.map((m, index): IFeedEntry => ({ kind: 'message', id: m.id, createdAt: m.createdAt, index })),
    ...runs.map((r, index): IFeedEntry => ({ kind: 'run', id: r.id, createdAt: r.createdAt, index })),
  ];
  return entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.createdAt < b.e.createdAt ? -1 : a.e.createdAt > b.e.createdAt ? 1 : a.i - b.i))
    .map(({ e }) => e);
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/feed.spec.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/feed.ts studio/frontend/src/plugins/llm-chat/feed.spec.ts
git commit -m "feat(studio): buildFeed selector merging messages + runs by timestamp"
```

---

## Task 4: Frontend — `RunTurnBlock` component

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx`

**Interfaces:**

- Consumes: `IRun.createdAt` (Task 2); `chatSlice().runs[index]` hookstate node; `ApprovalCard`, `parseApprovalAction`.
- Produces: `RunTurnBlock({ index }: { index: number })` — a grouped assistant-turn `<li>` (`data-testid="run-turn-${id}"`, `data-role="assistant"`) that reads `s.runs[index]` and renders its steps. Preserves the per-step testids (`run-step-${index}`), the `approval-card`, and the tool-name text. Calls `bumpRenderCount('RunTurnBlock')`.

- [ ] **Step 1: Write the failing tests**

Create `studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID, type IRun } from './state';
import { RunTurnBlock } from './RunTurnBlock';

const run = (over: Partial<IRun>): IRun => ({
  id: 'run1',
  roomId: 'r1',
  skillName: 'generate-sprite',
  status: 'running',
  steps: [],
  createdAt: 't',
  ...over,
});

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', 'r1') });
});

describe('RunTurnBlock', () => {
  it('renders tool and final steps inside a grouped assistant turn', () => {
    chatSlice().runs.set([
      run({
        steps: [
          { index: 0, type: 'tool_call', toolName: 'generate_asset', content: '{}', status: 'complete' },
          { index: 1, type: 'final', toolName: null, content: 'Done.', status: 'running' },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    const block = screen.getByTestId('run-turn-run1');
    expect(block.getAttribute('data-role')).toBe('assistant');
    expect(screen.getByText(/generate_asset/)).toBeInTheDocument();
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.getByTestId('run-step-0')).toBeInTheDocument();
    expect(screen.getByTestId('run-step-1')).toBeInTheDocument();
  });

  it('renders an approval step as the approval card', () => {
    chatSlice().runs.set([
      run({
        steps: [
          {
            index: 0,
            type: 'approval',
            toolName: null,
            content: JSON.stringify({ tool: 'delete_asset', args: {}, label: "This can't be undone" }),
            status: 'running',
          },
        ],
      }),
    ]);
    render(<RunTurnBlock index={0} />);
    expect(screen.getByTestId('approval-card')).toBeInTheDocument();
  });

  it('shows an "ai" avatar chip for the turn', () => {
    chatSlice().runs.set([run({ steps: [{ index: 0, type: 'final', toolName: null, content: 'Hi', status: 'complete' }] })]);
    render(<RunTurnBlock index={0} />);
    const chip = screen.getByTestId('run-turn-run1').querySelector('[aria-hidden]') as HTMLElement;
    expect(chip.textContent).toBe('ai');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/RunTurnBlock.spec.tsx`
Expected: FAIL — cannot find module `./RunTurnBlock`.

- [ ] **Step 3: Implement the component**

Create `studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx` (the `RunStepCard` body is copied verbatim from the old `RunTimeline.tsx` so step rendering and testids are unchanged):

```tsx
import { llmChatHooks } from './state';
import type { IRunStep } from './state';
import { ApprovalCard } from './ApprovalCard';
import { bumpRenderCount } from '../../app/renderCount';

type IReadonlyRunStep = Readonly<IRunStep>;

function RunStepCard({ step, index, runId }: { step: IReadonlyRunStep; index: number; runId: string }) {
  if (step.type === 'approval') {
    return <ApprovalCard runId={runId} step={step as IRunStep} />;
  }
  const isToolStep = step.type === 'tool_call' || step.type === 'tool_result';
  const isError = step.status === 'error';
  const isRunning = step.status === 'running';

  if (isToolStep) {
    return (
      <div
        data-testid={`run-step-${index}`}
        className={`rounded-md border p-2 ${isError ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border bg-surface'}`}
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase">{step.type === 'tool_call' ? 'tool call' : 'tool result'}</span>
          {isRunning && <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" aria-label="running" />}
        </div>
        <div className="mt-1 text-sm text-foreground">{step.toolName}</div>
      </div>
    );
  }

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

// A skill run renders as ONE assistant turn: AI avatar + accent rail (mirroring
// the assistant chat bubble) wrapping the run's steps. Subscribes only to its own
// run node, so a run_step_token re-renders this block alone.
export function RunTurnBlock({ index }: { index: number }) {
  const s = llmChatHooks.usePluginState();
  const r = s.runs[index];
  bumpRenderCount('RunTurnBlock');

  const id = r.id.get();
  const steps = r.steps.get();

  return (
    <li data-testid={`run-turn-${id}`} data-role="assistant" className="flex gap-2 rounded-r border-l-2 border-primary/50 bg-primary/[0.04] pl-2">
      <div
        aria-hidden
        className="mt-px flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border border-primary/30 bg-raised font-mono text-[9px] text-accent-text"
      >
        ai
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        {steps.map((step) => (
          <RunStepCard key={step.index} step={step} index={step.index} runId={id} />
        ))}
      </div>
    </li>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/RunTurnBlock.spec.tsx`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/RunTurnBlock.tsx studio/frontend/src/plugins/llm-chat/RunTurnBlock.spec.tsx
git commit -m "feat(studio): RunTurnBlock — grouped assistant-turn for a skill run"
```

---

## Task 5: Frontend — render the unified feed; retire `RunTimeline`

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` (`MessageList`, imports, drop `<RunTimeline />`)
- Delete: `studio/frontend/src/plugins/llm-chat/RunTimeline.tsx`, `studio/frontend/src/plugins/llm-chat/RunTimeline.spec.tsx`
- Test: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`

**Interfaces:**

- Consumes: `buildFeed` (Task 3), `RunTurnBlock` (Task 4), `ChatMessageBubble` (existing, index-based).
- Produces: `MessageList` renders one `<ul data-testid="chat-messages">` whose children are `ChatMessageBubble` (message entries) and `RunTurnBlock` (run entries), ordered by `buildFeed`. `RunTimeline` no longer exists.

- [ ] **Step 1: Write the failing tests**

In `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`, add a `describe` block (top of file already imports `chatSlice`, `makeInitialState`, etc.; add `appendStepToken` to the `./reducers` import and `IRun` to the `./state` import):

```ts
describe('ChatRoomPane unified feed', () => {
  const run = (over: Partial<IRun>): IRun => ({
    id: 'run1', roomId: 'r1', skillName: 's', status: 'running', steps: [], createdAt: '2026-06-23T00:00:02Z', ...over,
  });

  it('interleaves a run block between chat bubbles by timestamp', () => {
    chatSlice().messages.set([
      msg({ id: 'u1', role: 'user', author: 'alice', content: 'before', status: 'complete', createdAt: '2026-06-23T00:00:00Z' }),
      msg({ id: 'u2', role: 'user', author: 'alice', content: 'after', status: 'complete', createdAt: '2026-06-23T00:00:05Z' }),
    ]);
    chatSlice().runs.set([run({ steps: [{ index: 0, type: 'final', toolName: null, content: 'mid', status: 'complete' }] })]);
    render(<ChatRoomPane />);
    const ids = Array.from(screen.getByTestId('chat-messages').children).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['chat-msg-u1', 'run-turn-run1', 'chat-msg-u2']);
  });

  it('a run-step token re-renders only the run block, not sibling bubbles', () => {
    chatSlice().messages.set([msg({ id: 'u1', role: 'user', content: 'hi', status: 'complete', createdAt: '2026-06-23T00:00:00Z' })]);
    chatSlice().runs.set([run({ steps: [{ index: 0, type: 'final', toolName: null, content: 'He', status: 'running' }] })]);
    render(<ChatRoomPane />);
    window.__renderCounts = {};
    act(() => {
      const cur = chatSlice().runs.get({ noproxy: true }) as IRun[];
      chatSlice().runs.set(appendStepToken(cur, 'run1', 0, 'llo'));
    });
    expect(screen.getByTestId('run-turn-run1').textContent).toContain('Hello');
    expect(window.__renderCounts['RunTurnBlock'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(window.__renderCounts['ChatMessageBubble'] ?? 0).toBe(0);
    expect(window.__renderCounts['ChatRoomPane'] ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: FAIL — run entries not rendered in `chat-messages` (no `run-turn-run1` child); render-count assertions fail.

- [ ] **Step 3: Update `ChatMessageBubble` to read its id from state for the key**

No change needed — `ChatMessageBubble` already takes `index` and reads `s.messages[index]`. Leave it as-is.

- [ ] **Step 4: Rewrite `MessageList` to render the feed**

In `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`, replace the `MessageList` function (lines ~61-73) with:

```tsx
function MessageList() {
  const s = llmChatHooks.usePluginState();
  // Subscribe to additions (lengths) and the immutable id/createdAt leaves used
  // for ordering. Content/steps leaves are read by the child entries, NOT here,
  // so a streaming token never re-renders the list shell.
  const msgCount = s.messages.length;
  const runCount = s.runs.length;
  const msgs = Array.from({ length: msgCount }, (_, i) => ({ id: s.messages[i].id.get(), createdAt: s.messages[i].createdAt.get() }));
  const runs = Array.from({ length: runCount }, (_, i) => ({ id: s.runs[i].id.get(), createdAt: s.runs[i].createdAt.get() }));
  const feed = buildFeed(msgs, runs);
  return (
    <ul data-testid="chat-messages" className="m-0 flex flex-1 list-none flex-col gap-1.5 overflow-auto p-0">
      {feed.map((entry) =>
        entry.kind === 'message' ? <ChatMessageBubble key={`m:${entry.id}`} index={entry.index} /> : <RunTurnBlock key={`r:${entry.id}`} index={entry.index} />,
      )}
    </ul>
  );
}
```

- [ ] **Step 5: Update imports and drop the standalone `<RunTimeline />`**

In `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`:

- Remove `import { RunTimeline } from './RunTimeline';`
- Add `import { RunTurnBlock } from './RunTurnBlock';` and `import { buildFeed } from './feed';`
- Remove the `<RunTimeline />` line (~285) from the returned JSX.

- [ ] **Step 6: Delete the retired files**

```bash
git rm studio/frontend/src/plugins/llm-chat/RunTimeline.tsx studio/frontend/src/plugins/llm-chat/RunTimeline.spec.tsx
```

- [ ] **Step 7: Run the pane tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: PASS (existing tests + the two new feed tests).

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git commit -m "feat(studio): render unified chat feed; retire RunTimeline"
```

---

## Task 6: Frontend — fetch runs on room open; reset on switch

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/restClient.ts` (add `getRuns`)
- Modify: `studio/frontend/src/plugins/llm-chat/actions.ts` (`IRestDeps`, `openRoom`, `closeRoom`)
- Test: `studio/frontend/src/plugins/llm-chat/restClient.spec.ts`, `studio/frontend/src/plugins/llm-chat/actions.spec.ts`

**Interfaces:**

- Consumes: `IRun` (Task 2), `GET /rooms/:id/runs` (Task 1).
- Produces: `getRuns(roomId: string): Promise<IRun[]>`; `openRoom` clears `runs`/`activeRunId`, fetches messages AND runs in parallel, and sets both (guarding on latest `activeRoomId`); `closeRoom` clears `runs`/`activeRunId`. `IRestDeps` gains `getRuns`.

- [ ] **Step 1: Write the failing restClient test**

In `studio/frontend/src/plugins/llm-chat/restClient.spec.ts`, add (and add `getRuns` to the top import):

```ts
it('getRuns GETs /rooms/:id/runs', async () => {
  const fetchMock = mockFetch([]);
  vi.stubGlobal('fetch', fetchMock);
  await getRuns('r1');
  expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms/r1/runs`);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/restClient.spec.ts`
Expected: FAIL — `getRuns` is not exported.

- [ ] **Step 3: Implement `getRuns`**

In `studio/frontend/src/plugins/llm-chat/restClient.ts`, add `IRun` to the type import from `./state` and add after `getMessages`:

```ts
export async function getRuns(roomId: string): Promise<IRun[]> {
  return okJson<IRun[]>(await fetch(`${BACKEND_URL}/rooms/${roomId}/runs`));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/restClient.spec.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing actions tests**

In `studio/frontend/src/plugins/llm-chat/actions.spec.ts`:

- Add `getRuns: vi.fn(),` to the `rest` mock object.
- Add these tests inside `describe('actions', …)`:

```ts
it('openRoom fetches runs and stores them in the feed', async () => {
  rest.getMessages.mockResolvedValue([]);
  rest.getRuns.mockResolvedValue([{ id: 'run1', roomId: 'r1', skillName: 's', status: 'completed', steps: [], createdAt: 't' }]);
  await actions.openRoom('r1');
  expect(rest.getRuns).toHaveBeenCalledWith('r1');
  expect(chatSlice().runs.get()).toHaveLength(1);
});

it('openRoom clears the previous room runs before loading', async () => {
  chatSlice().runs.set([{ id: 'stale', roomId: 'old', skillName: 's', status: 'completed', steps: [], createdAt: 't' }]);
  chatSlice().activeRunId.set('stale');
  rest.getMessages.mockResolvedValue([]);
  rest.getRuns.mockResolvedValue([]);
  await actions.openRoom('r1');
  expect(chatSlice().runs.get()).toHaveLength(0);
  expect(chatSlice().activeRunId.get()).toBeNull();
});

it('closeRoom clears runs and activeRunId', () => {
  chatSlice().activeRoomId.set('r1');
  chatSlice().runs.set([{ id: 'run1', roomId: 'r1', skillName: 's', status: 'completed', steps: [], createdAt: 't' }]);
  chatSlice().activeRunId.set('run1');
  actions.closeRoom();
  expect(chatSlice().runs.get()).toHaveLength(0);
  expect(chatSlice().activeRunId.get()).toBeNull();
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/actions.spec.ts`
Expected: FAIL — `rest.getRuns` not called / runs not cleared.

- [ ] **Step 7: Wire runs into `openRoom` / `closeRoom`**

In `studio/frontend/src/plugins/llm-chat/actions.ts`:

Add `getRuns` to `IRestDeps`:

```ts
interface IRestDeps {
  getRooms: typeof realRest.getRooms;
  createRoom: typeof realRest.createRoom;
  getMessages: typeof realRest.getMessages;
  getRuns: typeof realRest.getRuns;
  getSkills: typeof realRest.getSkills;
}
```

In `openRoom`, add the resets alongside the existing `s.messages.set([])` block, and fetch runs in parallel with messages:

```ts
s.activeRoomId.set(roomId);
s.messages.set([]);
s.runs.set([]);
s.activeRunId.set(null);
s.members.set([]);
s.typing.set([]);
s.aiStatus.set({ state: 'idle', queueDepth: 0 });
s.roomLoadStatus.set('loading');
persist();

try {
  const [history, runs] = await Promise.all([rest.getMessages(roomId), rest.getRuns(roomId)]);
  if (chatSlice().activeRoomId.get() !== roomId) return; // a newer openRoom won
  s.messages.set(history);
  s.runs.set(runs);
  s.roomLoadStatus.set('idle');
} catch {
  if (chatSlice().activeRoomId.get() !== roomId) return;
  s.roomLoadStatus.set('error');
}
sock().joinRoom(roomId);
```

In `closeRoom`, add the resets:

```ts
s.activeRoomId.set(null);
s.messages.set([]);
s.runs.set([]);
s.activeRunId.set(null);
s.members.set([]);
s.typing.set([]);
persist();
```

- [ ] **Step 8: Run the actions tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/llm-chat/actions.spec.ts`
Expected: PASS (new tests + existing `openRoom`/`createRoom` tests — those mock `getMessages`; ensure `getRuns` resolves: the existing `createRoom` test sets `rest.getMessages.mockResolvedValue([])` — add `rest.getRuns.mockResolvedValue([])` there too if it throws).

- [ ] **Step 9: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/restClient.ts studio/frontend/src/plugins/llm-chat/restClient.spec.ts studio/frontend/src/plugins/llm-chat/actions.ts studio/frontend/src/plugins/llm-chat/actions.spec.ts
git commit -m "feat(studio): load runs on room open; clear runs on room switch/close"
```

---

## Task 7: Frontend CI gates (whole-plugin green)

**Files:** none (verification only).

- [ ] **Step 1: Prettier**

Run (repo root): `npx prettier --check .`
Expected: PASS. If it fails, run `npx prettier --write .` and re-check, then `git commit -am "style: prettier"`.

- [ ] **Step 2: Typecheck**

Run (repo root): `npx nx typecheck frontend`
Expected: PASS — no `IRun`/`createdAt`/import errors.

- [ ] **Step 3: Full frontend unit suite**

Run (repo root): `npx nx test frontend`
Expected: PASS — no references to the deleted `RunTimeline` remain.

- [ ] **Step 4: Build**

Run (repo root): `npx nx build frontend`
Expected: PASS.

- [ ] **Step 5: Commit any formatting fixes** (only if Step 1 changed files; otherwise skip).

---

## Task 8: e2e — update the behavioral contract

**Files:**

- Modify: `studio/frontend/e2e/skill-run.spec.ts`

**Interfaces:**

- Consumes: the unified feed (`chat-messages`), `RunTurnBlock` (`run-turn-*`), preserved tool-name text + final text. `manage-assets-approval.spec.ts` uses `approval-card` (preserved) and needs NO change.

- [ ] **Step 1: Repoint `skill-run.spec.ts` assertions from `run-timeline` to the feed**

In `studio/frontend/e2e/skill-run.spec.ts`, replace each `page.getByTestId('run-timeline')` (and the `a`/`b` variants in the two-client test) with `page.getByTestId('chat-messages')`. The `toContainText('generate_asset')` / `toContainText('Asset Board')` assertions stay — they now match inside the feed's run block.

- [ ] **Step 2: Add an interleave spec**

In `studio/frontend/e2e/skill-run.spec.ts`, inside the `describe`, add:

```ts
test('a run block appears between chat bubbles in chronological order', async ({ page }) => {
  const roomName = `Interleave ${Date.now()}`;
  await openApp(page, 'alice');
  await createRoom(page, roomName);

  await page.getByTestId('chat-composer').fill('first plain message');
  await page.getByTestId('chat-composer').press('Enter');
  await expect(page.getByTestId('chat-messages')).toContainText('first plain message');

  await page.getByTestId('chat-composer').fill('/generate-sprite a knight');
  await page.getByTestId('chat-composer').press('Enter');
  await expect(page.getByTestId('chat-messages')).toContainText('generate_asset', { timeout: 20_000 });

  await page.getByTestId('chat-composer').fill('third plain message');
  await page.getByTestId('chat-composer').press('Enter');
  await expect(page.getByTestId('chat-messages')).toContainText('third plain message');

  // DOM order: the run-turn block sits before the last plain message.
  const order = await page.getByTestId('chat-messages').evaluate((ul) => Array.from(ul.children).map((c) => c.getAttribute('data-testid') ?? ''));
  const runIdx = order.findIndex((t) => t.startsWith('run-turn-'));
  const lastMsgIdx = order.length - 1;
  expect(runIdx).toBeGreaterThan(0);
  expect(runIdx).toBeLessThan(lastMsgIdx);
});
```

- [ ] **Step 3: Add a reload-persistence spec**

In `studio/frontend/e2e/skill-run.spec.ts`, inside the `describe`, add:

```ts
test('run steps persist in the feed after a page reload', async ({ page }) => {
  const roomName = `Reload ${Date.now()}`;
  await openApp(page, 'alice');
  await createRoom(page, roomName);

  await page.getByTestId('chat-composer').fill('/generate-sprite a knight');
  await page.getByTestId('chat-composer').press('Enter');
  await expect(page.getByTestId('chat-messages')).toContainText('Asset Board', { timeout: 30_000 });

  await page.reload();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  // After reload, openRoom re-fetches runs and the feed re-renders the run block.
  await expect(page.getByTestId('chat-messages')).toContainText('generate_asset', { timeout: 15_000 });
  await expect(page.getByTestId('chat-messages')).toContainText('Asset Board', { timeout: 15_000 });
});
```

- [ ] **Step 4: Start a replay backend (Windows / PowerShell — `just` cannot find `sh`)**

In a separate PowerShell window, run the backend in replay mode in the background:

```powershell
cd studio/backend
$env:PROVIDER_MODE='replay'
uv run uvicorn app.main:app --port 8000
```

Verify health (use `127.0.0.1`, not `localhost`): `curl http://127.0.0.1:8000/health` → JSON with `"mode":"replay"`.

- [ ] **Step 5: Run the e2e specs against the replay backend**

From the repo root (so `theme.spec`'s screenshot overwrites the tracked copy):

```powershell
cd studio/frontend
$env:VITE_BLOOM_BACKEND_URL='http://127.0.0.1:8000'
npx playwright test --config=playwright.config.ts skill-run.spec.ts manage-assets-approval.spec.ts
```

Expected: PASS — repointed assertions, the interleave spec, the reload spec, and the unchanged approval specs all green.

- [ ] **Step 6: Run the full e2e suite once**

```powershell
cd studio/frontend
$env:VITE_BLOOM_BACKEND_URL='http://127.0.0.1:8000'
npx playwright test --config=playwright.config.ts
```

Expected: PASS (no regressions from the feed change).

- [ ] **Step 7: Restore the backend to live mode**

Stop the replay backend (Ctrl-C in its window). Live is the default; the next `just preflight` must pass. (If you keep a backend running for development, restart it without `PROVIDER_MODE=replay`.)

- [ ] **Step 8: Commit**

```bash
git add studio/frontend/e2e/skill-run.spec.ts
git commit -m "test(studio): e2e — unified feed interleave + reload persistence"
```

---

## Task 9: Open the PR

- [ ] **Step 1: Push and open the PR**

```bash
git push -u origin feat/unified-chat-feed
gh pr create --fill
```

- [ ] **Step 2: Self-merge once checks pass**

```bash
gh pr merge --squash --delete-branch
```

(0 approvals required; `main` is protected so PR is the only path.)

---

## Self-Review (author checklist — completed during planning)

**Spec coverage:**

- Frontend-fold, keep run model → Tasks 3-6 (selector + render, no backend model change). ✓
- Reload gap in scope → Task 1 (endpoint) + Task 6 (fetch on open). ✓
- Grouped assistant turn → Task 4 (`RunTurnBlock`). ✓
- Feed container reuses `chat-messages` → Task 5. ✓
- Cross-room leak fix → Task 6 (`openRoom`/`closeRoom` reset). ✓
- Render-count discipline → Task 5 Step 1 (token re-renders only `RunTurnBlock`). ✓
- e2e updates (repoint, interleave, reload) → Task 8. ✓
- Unit coverage (buildFeed, IRun.createdAt, RunTurnBlock, openRoom) → Tasks 2-6. ✓

**Placeholder scan:** no TBD/TODO; every code step shows full code. ✓

**Type consistency:** `IFeedEntry { kind, id, createdAt, index }` and `buildFeed(messages, runs)` are identical across Tasks 3 and 5; `getRuns(roomId): Promise<IRun[]>` identical across Tasks 1, 6; `RunTurnBlock({ index })` identical across Tasks 4, 5; `IRun.createdAt: string` (Task 2) used by Tasks 3-6. ✓

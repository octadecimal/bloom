# LLM Chat Frontend Plugin (Plan B, subsystem 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `studio/frontend` `llm-chat` plugin — a Room List splash, a single active-room Chat Room pane, and a Settings pane — wired to the existing backend over one Socket.IO connection plus REST, with a reusable shell-level toast service.

**Architecture:** A hookstate-backed `IPlugin` whose transient server state lives in an un-persisted slice (only `displayName` + `activeRoomId` are saved separately). Module-scoped REST (`fetch`) and Socket.IO singletons feed the slice through pure reducers; panes subscribe to the narrowest leaves so a streamed token re-renders only its own message bubble. Toasts are a shell-level `notify` seam over `sonner`, kept out of the `IPlugin` contract.

**Tech Stack:** React 18, hookstate v4, dockview, socket.io-client, sonner, vitest + @testing-library/react (unit, CI), Playwright (browser e2e, local-only).

**Design spec:** [`docs/superpowers/specs/2026-06-19-llm-chat-frontend-plugin-design.md`](../specs/2026-06-19-llm-chat-frontend-plugin-design.md)
**Parent spec:** [`docs/superpowers/specs/2026-06-19-llm-chat-design.md`](../specs/2026-06-19-llm-chat-design.md)

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IPlugin`, `IRoom`, `IMessage`, `ILlmChatState`) — repo coding standard.
- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, refactor.
- **Prefer proven libraries over hand-rolling** — `sonner` for toasts, `socket.io-client` for transport, native `fetch` for REST. Keep each behind a thin seam.
- **Frontend unit tests run:** `npx nx test frontend <fileOrPattern>` (from repo root; runs `vitest run` with cwd `studio/frontend`).
- **Browser e2e is NOT run in CI** (cost policy) — runs locally only.
- **Conventional Commits** for every commit (`feat(frontend): …`).
- **Backend wire contract (already built, do not change):** base URL `http://localhost:8000`, CORS `*`, Socket.IO at default `/socket.io`. Connect with `auth: { displayName }`. Wire shapes are camelCase: `IRoom = {id,name,model,gameId,createdAt}`, `IMessage = {id,roomId,author,role,content,status,createdAt}`, `role ∈ {user,assistant}`, `status ∈ {streaming,complete}`.
- **Display-name default** is `guest-NNNN` (four digits). **Persistence key** for prefs is `bloom.studio.llm-chat.prefs` (the `bloom.studio.` prefix is added by the persistence helpers; pass `llm-chat.prefs`).
- **Module-scoped singletons** created in the plugin's `init()`; components stay thin and call `actions`.
- Run `npx prettier --write <changed files>` before each commit (repo format gate).

---

## File structure

```
studio/frontend/src/
  lib/notify.ts                         (new) shell-level toast seam over sonner
  components/ui/sonner.tsx              (new) shadcn Toaster wrapper
  app/Workbench.tsx                     (modify) mount <Toaster/> once
  plugins/index.ts                      (modify) register llmChat plugin
  app/workbenchSetup.ts                 (modify) add Room List to DEFAULT_LAYOUT
  plugins/llm-chat/
    config.ts        backend base URL
    state.ts         IRoom/IMessage/ILlmChatState, initial state, hooks, chatSlice()
    reducers.ts      PURE message/typing transforms (find-or-create token/snapshot)
    prefs.ts         load/save {displayName, activeRoomId}; guest-NNNN generator
    restClient.ts    fetch wrappers: getModels/getRooms/createRoom/getMessages
    socketClient.ts  socket.io singleton; outbound emits + inbound event wiring
    actions.ts       orchestration: init/loadRooms/openRoom/createRoom/sendPrompt/setTyping/setDisplayName
    index.ts         IPlugin manifest (panes, commands, init)
    RoomListPane.tsx
    ChatRoomPane.tsx
    SettingsPane.tsx
studio/frontend/e2e/llm-chat.spec.ts    (new) browser e2e, local-only
justfile                                 (modify) add e2e-chat target
package.json                             (modify) add socket.io-client + sonner
```

---

## Task 1: Shell notifications service (`notify` seam + Toaster)

Adds the `sonner` dependency and a thin, mockable seam so plugins never import the toast library directly. Mount the toaster once in the shell.

**Files:**

- Modify: `package.json` (add `sonner`)
- Create: `studio/frontend/src/lib/notify.ts`
- Create: `studio/frontend/src/lib/notify.spec.ts`
- Create: `studio/frontend/src/components/ui/sonner.tsx`
- Modify: `studio/frontend/src/app/Workbench.tsx` (mount `<Toaster/>`)

**Interfaces:**

- Produces: `notify.error(message: string): void`, `notify.info(message: string): void` (from `src/lib/notify.ts`); `<Toaster/>` React component (from `src/components/ui/sonner.tsx`).

- [ ] **Step 1: Add the dependency**

Run (repo root):

```bash
npm install sonner
```

Expected: `sonner` added to `package.json` `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `studio/frontend/src/lib/notify.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (m: string) => toastError(m), info: (m: string) => toastInfo(m) },
}));

import { notify } from './notify';

describe('notify seam', () => {
  beforeEach(() => {
    toastError.mockClear();
    toastInfo.mockClear();
  });

  it('delegates error() to sonner toast.error', () => {
    notify.error('boom');
    expect(toastError).toHaveBeenCalledWith('boom');
  });

  it('delegates info() to sonner toast.info', () => {
    notify.info('hello');
    expect(toastInfo).toHaveBeenCalledWith('hello');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx nx test frontend src/lib/notify.spec.ts`
Expected: FAIL — cannot resolve `./notify`.

- [ ] **Step 4: Write minimal implementation**

Create `studio/frontend/src/lib/notify.ts`:

```ts
import { toast } from 'sonner';

// Thin seam over the toast library so plugins depend on `notify`, never `sonner`
// directly. Swappable and trivially mockable in tests.
export const notify = {
  error(message: string): void {
    toast.error(message);
  },
  info(message: string): void {
    toast.info(message);
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx nx test frontend src/lib/notify.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Create the Toaster component and mount it**

Create `studio/frontend/src/components/ui/sonner.tsx`:

```tsx
import { Toaster as Sonner } from 'sonner';

// Single app-wide toaster. richColors gives error/info distinct styling without
// extra config; closeButton lets users dismiss. Theme follows the OS for now.
export function Toaster() {
  return <Sonner data-testid="toaster" richColors closeButton position="bottom-right" />;
}
```

Modify `studio/frontend/src/app/Workbench.tsx` — add the import and render it once. Add near the top with the other imports:

```tsx
import { Toaster } from '@/components/ui/sonner';
```

And inside the returned tree, immediately after `<CommandPalette />`:

```tsx
{
  /* App-wide toast outlet — single instance for all plugins via the notify seam */
}
<Toaster />;
```

- [ ] **Step 7: Run the full frontend suite to verify nothing broke**

Run: `npx nx test frontend`
Expected: PASS (existing tests + the 2 new notify tests).

- [ ] **Step 8: Commit**

```bash
npx prettier --write studio/frontend/src/lib/notify.ts studio/frontend/src/lib/notify.spec.ts studio/frontend/src/components/ui/sonner.tsx studio/frontend/src/app/Workbench.tsx package.json
git add studio/frontend/src/lib/notify.ts studio/frontend/src/lib/notify.spec.ts studio/frontend/src/components/ui/sonner.tsx studio/frontend/src/app/Workbench.tsx package.json package-lock.json
git commit -m "feat(frontend): shell-level notify seam + sonner toaster"
```

---

## Task 2: State types, initial state, hooks, and slice accessor

Defines the wire types and slice shape every later task consumes.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/state.ts`
- Create: `studio/frontend/src/plugins/llm-chat/state.spec.ts`

**Interfaces:**

- Produces:
  - `IRoom = { id: string; name: string; model: string; gameId: string | null; createdAt: string }`
  - `IMessage = { id: string; roomId: string; author: string; role: 'user' | 'assistant'; content: string; status: 'streaming' | 'complete'; createdAt: string }`
  - `type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'`
  - `IAiStatus = { state: 'idle' | 'generating' | 'queued'; queueDepth: number }`
  - `ILlmChatState` (full slice)
  - `makeInitialState(displayName: string, activeRoomId: string | null): ILlmChatState`
  - `llmChatHooks` (from `makePluginHooks<ILlmChatState>('llm-chat')`)
  - `chatSlice(): State<ILlmChatState>` — module accessor for non-React code
  - `LLM_CHAT_PLUGIN_ID = 'llm-chat'`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/state.spec.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';

describe('llm-chat state', () => {
  afterEach(() => {
    rootStore.plugins.set({});
  });

  it('makeInitialState seeds prefs and empty server state', () => {
    const s = makeInitialState('guest-1234', null);
    expect(s.displayName).toBe('guest-1234');
    expect(s.activeRoomId).toBeNull();
    expect(s.connection).toBe('connecting');
    expect(s.rooms).toEqual([]);
    expect(s.roomsStatus).toBe('idle');
    expect(s.messages).toEqual([]);
    expect(s.members).toEqual([]);
    expect(s.typing).toEqual([]);
    expect(s.aiStatus).toEqual({ state: 'idle', queueDepth: 0 });
    expect(s.roomLoadStatus).toBe('idle');
  });

  it('chatSlice() reads and writes the llm-chat plugin slice', () => {
    rootStore.plugins.merge({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
    chatSlice().displayName.set('renamed');
    expect((rootStore.plugins.get() as Record<string, ILlmChatStateLike>)[LLM_CHAT_PLUGIN_ID].displayName).toBe('renamed');
  });
});

// local structural alias for the assertion above
interface ILlmChatStateLike {
  displayName: string;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/state.spec.ts`
Expected: FAIL — cannot resolve `./state`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/state.ts`:

```ts
import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const LLM_CHAT_PLUGIN_ID = 'llm-chat';

export interface IRoom {
  id: string;
  name: string;
  model: string;
  gameId: string | null;
  createdAt: string;
}

export interface IMessage {
  id: string;
  roomId: string;
  author: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete';
  createdAt: string;
}

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface IAiStatus {
  state: 'idle' | 'generating' | 'queued';
  queueDepth: number;
}

export interface ILlmChatState {
  // durable prefs (persisted separately via prefs.ts, NOT via persist:true)
  displayName: string;
  activeRoomId: string | null;

  connection: ConnState;

  rooms: IRoom[];
  roomsStatus: 'idle' | 'loading' | 'error';

  // the ACTIVE room's live view; socket handlers guard on roomId === activeRoomId
  messages: IMessage[];
  members: string[];
  typing: string[];
  aiStatus: IAiStatus;
  roomLoadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(displayName: string, activeRoomId: string | null): ILlmChatState {
  return {
    displayName,
    activeRoomId,
    connection: 'connecting',
    rooms: [],
    roomsStatus: 'idle',
    messages: [],
    members: [],
    typing: [],
    aiStatus: { state: 'idle', queueDepth: 0 },
    roomLoadStatus: 'idle',
  };
}

export const llmChatHooks = makePluginHooks<ILlmChatState>(LLM_CHAT_PLUGIN_ID);

// Accessor for non-React modules (actions, socketClient). Mirrors the cast used
// by demo-counter's command. The single contained type seam.
export function chatSlice(): State<ILlmChatState> {
  return rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID) as unknown as State<ILlmChatState>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/state.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/state.spec.ts
git add studio/frontend/src/plugins/llm-chat/state.ts studio/frontend/src/plugins/llm-chat/state.spec.ts
git commit -m "feat(frontend): llm-chat state slice, types, and accessor"
```

---

## Task 3: Pure reducers (message + typing transforms)

The streaming core, as pure array functions — trivially unit-testable. Applied to the slice by `socketClient`/`actions` in later tasks.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/reducers.ts`
- Create: `studio/frontend/src/plugins/llm-chat/reducers.spec.ts`

**Interfaces:**

- Consumes: `IMessage` (Task 2).
- Produces (all pure, return new arrays — never mutate input):
  - `upsertMessage(messages: IMessage[], message: IMessage): IMessage[]`
  - `appendToken(messages: IMessage[], roomId: string, messageId: string, delta: string): IMessage[]`
  - `applySnapshot(messages: IMessage[], roomId: string, messageId: string, content: string): IMessage[]`
  - `completeMessage(messages: IMessage[], messageId: string): IMessage[]`
  - `addTyping(typing: string[], author: string): string[]`
  - `removeTyping(typing: string[], author: string): string[]`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/reducers.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { IMessage } from './state';
import { upsertMessage, appendToken, applySnapshot, completeMessage, addTyping, removeTyping } from './reducers';

const msg = (over: Partial<IMessage>): IMessage => ({
  id: 'm1',
  roomId: 'r1',
  author: 'assistant',
  role: 'assistant',
  content: '',
  status: 'streaming',
  createdAt: '2026-06-19T00:00:00Z',
  ...over,
});

describe('reducers', () => {
  it('upsertMessage appends a new message', () => {
    const out = upsertMessage([], msg({ id: 'a' }));
    expect(out.map((m) => m.id)).toEqual(['a']);
  });

  it('upsertMessage replaces an existing message by id (idempotent)', () => {
    const out = upsertMessage([msg({ id: 'a', content: 'old' })], msg({ id: 'a', content: 'new' }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('new');
  });

  it('appendToken appends a delta to an existing assistant message', () => {
    const out = appendToken([msg({ id: 'a', content: 'He' })], 'r1', 'a', 'llo');
    expect(out[0].content).toBe('Hello');
  });

  it('appendToken find-or-creates a streaming stub when the message is unknown', () => {
    const out = appendToken([], 'r1', 'a', 'Hi');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', roomId: 'r1', role: 'assistant', content: 'Hi', status: 'streaming' });
  });

  it('appendToken does not mutate its input array', () => {
    const input = [msg({ id: 'a', content: 'x' })];
    appendToken(input, 'r1', 'a', 'y');
    expect(input[0].content).toBe('x');
  });

  it('applySnapshot SETS content (find-or-create) for join mid-stream', () => {
    const out = applySnapshot([msg({ id: 'a', content: '' })], 'r1', 'a', 'caught up');
    expect(out[0].content).toBe('caught up');
  });

  it('applySnapshot creates a streaming stub when message unknown', () => {
    const out = applySnapshot([], 'r1', 'a', 'partial');
    expect(out[0]).toMatchObject({ id: 'a', roomId: 'r1', content: 'partial', status: 'streaming' });
  });

  it('completeMessage flips status to complete', () => {
    const out = completeMessage([msg({ id: 'a', status: 'streaming' })], 'a');
    expect(out[0].status).toBe('complete');
  });

  it('addTyping adds an author once; removeTyping removes it', () => {
    expect(addTyping([], 'bob')).toEqual(['bob']);
    expect(addTyping(['bob'], 'bob')).toEqual(['bob']);
    expect(removeTyping(['bob', 'amy'], 'bob')).toEqual(['amy']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/reducers.spec.ts`
Expected: FAIL — cannot resolve `./reducers`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/reducers.ts`:

```ts
import type { IMessage } from './state';

// Minimal streaming assistant stub used as a safety net when a token or snapshot
// arrives before its message_created (rare — message_created normally precedes).
function streamingStub(roomId: string, messageId: string, content: string): IMessage {
  return {
    id: messageId,
    roomId,
    author: 'assistant',
    role: 'assistant',
    content,
    status: 'streaming',
    createdAt: '',
  };
}

export function upsertMessage(messages: IMessage[], message: IMessage): IMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx === -1) return [...messages, message];
  const next = messages.slice();
  next[idx] = message;
  return next;
}

export function appendToken(messages: IMessage[], roomId: string, messageId: string, delta: string): IMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return [...messages, streamingStub(roomId, messageId, delta)];
  const next = messages.slice();
  next[idx] = { ...next[idx], content: next[idx].content + delta };
  return next;
}

export function applySnapshot(messages: IMessage[], roomId: string, messageId: string, content: string): IMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return [...messages, streamingStub(roomId, messageId, content)];
  const next = messages.slice();
  next[idx] = { ...next[idx], content };
  return next;
}

export function completeMessage(messages: IMessage[], messageId: string): IMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return messages;
  const next = messages.slice();
  next[idx] = { ...next[idx], status: 'complete' };
  return next;
}

export function addTyping(typing: string[], author: string): string[] {
  return typing.includes(author) ? typing : [...typing, author];
}

export function removeTyping(typing: string[], author: string): string[] {
  return typing.filter((a) => a !== author);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/reducers.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/reducers.ts studio/frontend/src/plugins/llm-chat/reducers.spec.ts
git add studio/frontend/src/plugins/llm-chat/reducers.ts studio/frontend/src/plugins/llm-chat/reducers.spec.ts
git commit -m "feat(frontend): pure llm-chat reducers (token/snapshot find-or-create)"
```

---

## Task 4: Prefs (display-name generator + load/save)

Self-managed persistence of the two durable prefs, using the existing envelope helpers.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/prefs.ts`
- Create: `studio/frontend/src/plugins/llm-chat/prefs.spec.ts`

**Interfaces:**

- Consumes: `savePersisted`/`loadPersisted` from `../../state/persistence`.
- Produces:
  - `IChatPrefs = { displayName: string; activeRoomId: string | null }`
  - `generateGuestName(): string` — matches `/^guest-\d{4}$/`
  - `loadPrefs(): IChatPrefs` — generates a guest name on first run
  - `savePrefs(prefs: IChatPrefs): void`
  - `PREFS_KEY = 'llm-chat.prefs'`, `PREFS_VERSION = 1`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/prefs.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { generateGuestName, loadPrefs, savePrefs } from './prefs';

describe('llm-chat prefs', () => {
  beforeEach(() => localStorage.clear());

  it('generateGuestName matches guest-NNNN', () => {
    expect(generateGuestName()).toMatch(/^guest-\d{4}$/);
  });

  it('loadPrefs generates a guest name and null room on first run', () => {
    const p = loadPrefs();
    expect(p.displayName).toMatch(/^guest-\d{4}$/);
    expect(p.activeRoomId).toBeNull();
  });

  it('savePrefs round-trips through loadPrefs', () => {
    savePrefs({ displayName: 'alice', activeRoomId: 'r9' });
    const p = loadPrefs();
    expect(p).toEqual({ displayName: 'alice', activeRoomId: 'r9' });
  });

  it('persists under the bloom.studio.llm-chat.prefs key', () => {
    savePrefs({ displayName: 'bob', activeRoomId: null });
    expect(localStorage.getItem('bloom.studio.llm-chat.prefs')).toContain('bob');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/prefs.spec.ts`
Expected: FAIL — cannot resolve `./prefs`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/prefs.ts`:

```ts
import { savePersisted, loadPersisted } from '../../state/persistence';

export const PREFS_KEY = 'llm-chat.prefs';
export const PREFS_VERSION = 1;

export interface IChatPrefs {
  displayName: string;
  activeRoomId: string | null;
}

export function generateGuestName(): string {
  const n = Math.floor(1000 + Math.random() * 9000); // 1000–9999
  return `guest-${n}`;
}

export function loadPrefs(): IChatPrefs {
  const fallback: IChatPrefs = { displayName: generateGuestName(), activeRoomId: null };
  return loadPersisted<IChatPrefs>(PREFS_KEY, PREFS_VERSION, fallback);
}

export function savePrefs(prefs: IChatPrefs): void {
  savePersisted(PREFS_KEY, PREFS_VERSION, prefs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/prefs.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/prefs.ts studio/frontend/src/plugins/llm-chat/prefs.spec.ts
git add studio/frontend/src/plugins/llm-chat/prefs.ts studio/frontend/src/plugins/llm-chat/prefs.spec.ts
git commit -m "feat(frontend): llm-chat prefs (guest name + load/save)"
```

---

## Task 5: Config + REST client

`fetch` wrappers for the four REST endpoints.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/config.ts`
- Create: `studio/frontend/src/plugins/llm-chat/restClient.ts`
- Create: `studio/frontend/src/plugins/llm-chat/restClient.spec.ts`

**Interfaces:**

- Consumes: `IRoom`, `IMessage` (Task 2).
- Produces:
  - `BACKEND_URL: string` (from `config.ts`)
  - `IModelOption = { id: string; label: string; free: boolean }`
  - `getModels(): Promise<IModelOption[]>`
  - `getRooms(): Promise<IRoom[]>`
  - `createRoom(name: string, model?: string): Promise<IRoom>`
  - `getMessages(roomId: string): Promise<IMessage[]>`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/restClient.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getModels, getRooms, createRoom, getMessages } from './restClient';
import { BACKEND_URL } from './config';

function mockFetch(json: unknown, status = 200) {
  return vi.fn().mockResolvedValue({ ok: status < 400, status, json: async () => json } as Response);
}

describe('restClient', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('getModels GETs /models', async () => {
    const fetchMock = mockFetch([{ id: 'm', label: 'M', free: true }]);
    vi.stubGlobal('fetch', fetchMock);
    const out = await getModels();
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/models`);
    expect(out).toEqual([{ id: 'm', label: 'M', free: true }]);
  });

  it('getRooms GETs /rooms', async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    await getRooms();
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms`);
  });

  it('createRoom POSTs name + model as JSON', async () => {
    const room = { id: 'r1', name: 'General', model: 'm', gameId: null, createdAt: 't' };
    const fetchMock = mockFetch(room, 201);
    vi.stubGlobal('fetch', fetchMock);
    const out = await createRoom('General', 'm');
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'General', model: 'm' }),
    });
    expect(out).toEqual(room);
  });

  it('getMessages GETs /rooms/:id/messages', async () => {
    const fetchMock = mockFetch([]);
    vi.stubGlobal('fetch', fetchMock);
    await getMessages('r1');
    expect(fetchMock).toHaveBeenCalledWith(`${BACKEND_URL}/rooms/r1/messages`);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal('fetch', mockFetch({ detail: 'nope' }, 500));
    await expect(getRooms()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/restClient.spec.ts`
Expected: FAIL — cannot resolve `./restClient` / `./config`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/config.ts`:

```ts
// Backend base URL. Override with VITE_BLOOM_BACKEND_URL at build/dev time.
export const BACKEND_URL: string = (import.meta.env.VITE_BLOOM_BACKEND_URL as string | undefined) ?? 'http://localhost:8000';
```

Create `studio/frontend/src/plugins/llm-chat/restClient.ts`:

```ts
import type { IRoom, IMessage } from './state';
import { BACKEND_URL } from './config';

export interface IModelOption {
  id: string;
  label: string;
  free: boolean;
}

async function okJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return (await res.json()) as T;
}

export async function getModels(): Promise<IModelOption[]> {
  return okJson<IModelOption[]>(await fetch(`${BACKEND_URL}/models`));
}

export async function getRooms(): Promise<IRoom[]> {
  return okJson<IRoom[]>(await fetch(`${BACKEND_URL}/rooms`));
}

export async function createRoom(name: string, model?: string): Promise<IRoom> {
  const res = await fetch(`${BACKEND_URL}/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, model }),
  });
  return okJson<IRoom>(res);
}

export async function getMessages(roomId: string): Promise<IMessage[]> {
  return okJson<IMessage[]>(await fetch(`${BACKEND_URL}/rooms/${roomId}/messages`));
}
```

Note: when `model` is `undefined`, `JSON.stringify({ name, model })` omits the key — matching the backend's optional `model`. The `createRoom('General', 'm')` test passes an explicit model; a separate no-model call would serialize `{"name":"General"}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/restClient.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/config.ts studio/frontend/src/plugins/llm-chat/restClient.ts studio/frontend/src/plugins/llm-chat/restClient.spec.ts
git add studio/frontend/src/plugins/llm-chat/config.ts studio/frontend/src/plugins/llm-chat/restClient.ts studio/frontend/src/plugins/llm-chat/restClient.spec.ts
git commit -m "feat(frontend): llm-chat REST client + backend URL config"
```

---

## Task 6: Socket client — construction, outbound emits, connection state

A module-scoped Socket.IO singleton built via an injectable factory (so tests pass a fake socket). This task covers connect/auth, the outbound emitters, and connection-state transitions. Task 7 adds inbound event wiring.

**Files:**

- Modify: `package.json` (add `socket.io-client`)
- Create: `studio/frontend/src/plugins/llm-chat/socketClient.ts`
- Create: `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts`

**Interfaces:**

- Consumes: `chatSlice` (Task 2).
- Produces:
  - `ISocketLike` — `{ on(event, cb), emit(event, payload?), connect(), disconnect(), readonly connected: boolean, auth: Record<string, unknown> }`
  - `createSocketClient(makeSocket: (url: string, auth: { displayName: string }) => ISocketLike)` → object with: `connect(displayName)`, `reconnectWith(displayName)`, `disconnect()`, `joinRoom(roomId)`, `leaveRoom(roomId)`, `sendPrompt(roomId, text)`, `setTyping(roomId, isTyping)`.
  - `getSocketClient()` / `initSocketClient()` — module singleton accessors (real `io` from `socket.io-client`).

- [ ] **Step 1: Add the dependency**

Run (repo root):

```bash
npm install socket.io-client
```

Expected: `socket.io-client` added to `package.json` `dependencies`.

- [ ] **Step 2: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import { createSocketClient, type ISocketLike } from './socketClient';

// Minimal fake socket: records handlers + emits, drives connected flag.
function makeFakeSocket() {
  const handlers: Record<string, (p: unknown) => void> = {};
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const sock: ISocketLike & { fire(e: string, p?: unknown): void } = {
    auth: {},
    connected: false,
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
    },
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
    },
    connect: () => {
      sock.connected = true;
    },
    disconnect: () => {
      sock.connected = false;
    },
    fire: (e: string, p?: unknown) => handlers[e]?.(p),
  };
  return { sock, emitted };
}

function seed() {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
}

describe('socketClient outbound', () => {
  beforeEach(seed);

  it('connect() builds a socket with displayName auth', () => {
    const { sock } = makeFakeSocket();
    const make = vi.fn().mockReturnValue(sock);
    const client = createSocketClient(make);
    client.connect('alice');
    expect(make).toHaveBeenCalledWith(expect.any(String), { displayName: 'alice' });
  });

  it('connect event sets connection=connected', () => {
    const { sock } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    sock.fire('connect');
    expect(chatSlice().connection.get()).toBe('connected');
  });

  it('disconnect event sets connection=reconnecting', () => {
    const { sock } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    sock.fire('disconnect');
    expect(chatSlice().connection.get()).toBe('reconnecting');
  });

  it('on (re)connect, re-joins the active room', () => {
    const { sock, emitted } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    chatSlice().activeRoomId.set('r1');
    client.connect('alice');
    sock.fire('connect');
    expect(emitted).toContainEqual({ event: 'join_room', payload: { roomId: 'r1' } });
  });

  it('joinRoom/leaveRoom/sendPrompt/setTyping emit the right events', () => {
    const { sock, emitted } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    client.joinRoom('r1');
    client.leaveRoom('r1');
    client.sendPrompt('r1', 'hi');
    client.setTyping('r1', true);
    expect(emitted).toContainEqual({ event: 'join_room', payload: { roomId: 'r1' } });
    expect(emitted).toContainEqual({ event: 'leave_room', payload: { roomId: 'r1' } });
    expect(emitted).toContainEqual({ event: 'send_prompt', payload: { roomId: 'r1', text: 'hi' } });
    expect(emitted).toContainEqual({ event: 'typing', payload: { roomId: 'r1', isTyping: true } });
  });

  it('reconnectWith disconnects and reconnects with the new name', () => {
    const { sock } = makeFakeSocket();
    const make = vi.fn().mockReturnValue(sock);
    const client = createSocketClient(make);
    client.connect('alice');
    client.reconnectWith('bob');
    expect(make).toHaveBeenLastCalledWith(expect.any(String), { displayName: 'bob' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/socketClient.spec.ts`
Expected: FAIL — cannot resolve `./socketClient`.

- [ ] **Step 4: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/socketClient.ts`:

```ts
import { io } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { chatSlice } from './state';

export interface ISocketLike {
  auth: Record<string, unknown>;
  readonly connected: boolean;
  on(event: string, cb: (payload: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
  connect(): void;
  disconnect(): void;
}

type MakeSocket = (url: string, auth: { displayName: string }) => ISocketLike;

export function createSocketClient(makeSocket: MakeSocket) {
  let sock: ISocketLike | null = null;

  function wire(s: ISocketLike): void {
    s.on('connect', () => {
      chatSlice().connection.set('connected');
      const active = chatSlice().activeRoomId.get();
      if (active) s.emit('join_room', { roomId: active });
    });
    s.on('disconnect', () => {
      chatSlice().connection.set('reconnecting');
    });
    // Inbound domain events are wired in Task 7's registerInboundHandlers().
  }

  function connect(displayName: string): void {
    chatSlice().connection.set('connecting');
    sock = makeSocket(BACKEND_URL, { displayName });
    wire(sock);
  }

  function disconnect(): void {
    sock?.disconnect();
    chatSlice().connection.set('disconnected');
  }

  function reconnectWith(displayName: string): void {
    sock?.disconnect();
    connect(displayName);
  }

  const emit = (event: string, payload: unknown) => sock?.emit(event, payload);

  return {
    connect,
    disconnect,
    reconnectWith,
    getSocket: () => sock,
    joinRoom: (roomId: string) => emit('join_room', { roomId }),
    leaveRoom: (roomId: string) => emit('leave_room', { roomId }),
    sendPrompt: (roomId: string, text: string) => emit('send_prompt', { roomId, text }),
    setTyping: (roomId: string, isTyping: boolean) => emit('typing', { roomId, isTyping }),
  };
}

export type SocketClient = ReturnType<typeof createSocketClient>;

// Module singleton over the real socket.io-client.
let singleton: SocketClient | null = null;

export function initSocketClient(): SocketClient {
  singleton = createSocketClient((url, auth) => io(url, { auth, autoConnect: true }) as unknown as ISocketLike);
  return singleton;
}

export function getSocketClient(): SocketClient {
  if (!singleton) throw new Error('socket client not initialised');
  return singleton;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/socketClient.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/socketClient.spec.ts package.json
git add studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/socketClient.spec.ts package.json package-lock.json
git commit -m "feat(frontend): llm-chat socket client (outbound + connection state)"
```

---

## Task 7: Socket client — inbound event wiring

Apply server events to the slice through the pure reducers, guarded by `roomId === activeRoomId`, with `error` surfaced via `notify`.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.ts` (add `registerInboundHandlers`, call from `wire`)
- Modify: `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts` (add an inbound `describe` block)

**Interfaces:**

- Consumes: reducers (Task 3), `notify` (Task 1), `IMessage`/`IAiStatus` (Task 2).
- Produces: inbound handlers for `message_created`, `token`, `stream_snapshot`, `message_completed`, `presence`, `typing`, `ai_status`, `error` — applied to `chatSlice()`.

- [ ] **Step 1: Write the failing test (append to socketClient.spec.ts)**

Add this block at the end of `studio/frontend/src/plugins/llm-chat/socketClient.spec.ts`, and add the `notify` mock at the top of the file (below the existing imports):

```ts
// add near the top, after imports:
const notifyError = vi.fn();
vi.mock('../../lib/notify', () => ({ notify: { error: (m: string) => notifyError(m), info: vi.fn() } }));
```

```ts
// add at the end of the file:
describe('socketClient inbound', () => {
  beforeEach(() => {
    rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
    notifyError.mockClear();
    chatSlice().activeRoomId.set('r1');
  });

  function connected() {
    const { sock, emitted } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    sock.fire('connect');
    return { sock, emitted, client };
  }

  const message = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    roomId: 'r1',
    author: 'assistant',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: 't',
    ...over,
  });

  it('message_created upserts into messages', () => {
    const { sock } = connected();
    sock.fire('message_created', { message: message({ id: 'u1', role: 'user', content: 'hi', status: 'complete' }) });
    expect(chatSlice().messages.get()).toHaveLength(1);
  });

  it('token appends to the streaming message', () => {
    const { sock } = connected();
    sock.fire('message_created', { message: message({ id: 'a1' }) });
    sock.fire('token', { roomId: 'r1', messageId: 'a1', delta: 'Hel' });
    sock.fire('token', { roomId: 'r1', messageId: 'a1', delta: 'lo' });
    expect(chatSlice().messages.get()[0].content).toBe('Hello');
  });

  it('ignores events for a non-active room', () => {
    const { sock } = connected();
    sock.fire('token', { roomId: 'OTHER', messageId: 'x', delta: 'nope' });
    expect(chatSlice().messages.get()).toHaveLength(0);
  });

  it('stream_snapshot sets accumulated content (join mid-stream)', () => {
    const { sock } = connected();
    sock.fire('stream_snapshot', { roomId: 'r1', messageId: 'a1', content: 'caught up', state: 'generating' });
    expect(chatSlice().messages.get()[0].content).toBe('caught up');
  });

  it('message_completed flips status to complete', () => {
    const { sock } = connected();
    sock.fire('message_created', { message: message({ id: 'a1' }) });
    sock.fire('message_completed', { roomId: 'r1', messageId: 'a1' });
    expect(chatSlice().messages.get()[0].status).toBe('complete');
  });

  it('presence/typing/ai_status update the slice', () => {
    const { sock } = connected();
    sock.fire('presence', { roomId: 'r1', members: ['alice', 'bob'] });
    sock.fire('typing', { roomId: 'r1', author: 'bob', isTyping: true });
    sock.fire('ai_status', { roomId: 'r1', state: 'generating', queueDepth: 2 });
    expect(chatSlice().members.get()).toEqual(['alice', 'bob']);
    expect(chatSlice().typing.get()).toEqual(['bob']);
    expect(chatSlice().aiStatus.get()).toEqual({ state: 'generating', queueDepth: 2 });
    sock.fire('typing', { roomId: 'r1', author: 'bob', isTyping: false });
    expect(chatSlice().typing.get()).toEqual([]);
  });

  it('error event raises a toast', () => {
    const { sock } = connected();
    sock.fire('error', { roomId: 'r1', message: 'generation failed' });
    expect(notifyError).toHaveBeenCalledWith('generation failed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/socketClient.spec.ts`
Expected: FAIL — new inbound assertions fail (handlers not registered yet).

- [ ] **Step 3: Write minimal implementation**

In `studio/frontend/src/plugins/llm-chat/socketClient.ts`, add imports at the top:

```ts
import type { IMessage, IAiStatus } from './state';
import { upsertMessage, appendToken, applySnapshot, completeMessage, addTyping, removeTyping } from './reducers';
import { notify } from '../../lib/notify';
```

Add this helper function above `createSocketClient`:

```ts
function registerInboundHandlers(s: ISocketLike): void {
  const slice = chatSlice;
  const isActive = (roomId: string) => slice().activeRoomId.get() === roomId;
  const read = () => slice().messages.get({ noproxy: true }) as IMessage[];

  s.on('message_created', (p) => {
    const { message } = p as { message: IMessage };
    if (!isActive(message.roomId)) return;
    slice().messages.set(upsertMessage(read(), message));
  });
  s.on('token', (p) => {
    const { roomId, messageId, delta } = p as { roomId: string; messageId: string; delta: string };
    if (!isActive(roomId)) return;
    slice().messages.set(appendToken(read(), roomId, messageId, delta));
  });
  s.on('stream_snapshot', (p) => {
    const { roomId, messageId, content } = p as { roomId: string; messageId: string; content: string };
    if (!isActive(roomId)) return;
    slice().messages.set(applySnapshot(read(), roomId, messageId, content));
  });
  s.on('message_completed', (p) => {
    const { roomId, messageId } = p as { roomId: string; messageId: string };
    if (!isActive(roomId)) return;
    slice().messages.set(completeMessage(read(), messageId));
  });
  s.on('presence', (p) => {
    const { roomId, members } = p as { roomId: string; members: string[] };
    if (!isActive(roomId)) return;
    slice().members.set(members);
  });
  s.on('typing', (p) => {
    const { roomId, author, isTyping } = p as { roomId: string; author: string; isTyping: boolean };
    if (!isActive(roomId)) return;
    const cur = slice().typing.get({ noproxy: true }) as string[];
    slice().typing.set(isTyping ? addTyping(cur, author) : removeTyping(cur, author));
  });
  s.on('ai_status', (p) => {
    const { roomId, state, queueDepth } = p as { roomId: string } & IAiStatus;
    if (!isActive(roomId)) return;
    slice().aiStatus.set({ state, queueDepth });
  });
  s.on('error', (p) => {
    const { message } = p as { message: string };
    notify.error(message ?? 'chat error');
  });
}
```

Then call it from `wire`, after the connect/disconnect handlers:

```ts
function wire(s: ISocketLike): void {
  s.on('connect', () => {
    chatSlice().connection.set('connected');
    const active = chatSlice().activeRoomId.get();
    if (active) s.emit('join_room', { roomId: active });
  });
  s.on('disconnect', () => {
    chatSlice().connection.set('reconnecting');
  });
  registerInboundHandlers(s);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/socketClient.spec.ts`
Expected: PASS (6 outbound + 7 inbound tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/socketClient.spec.ts
git add studio/frontend/src/plugins/llm-chat/socketClient.ts studio/frontend/src/plugins/llm-chat/socketClient.spec.ts
git commit -m "feat(frontend): llm-chat socket inbound event wiring"
```

---

## Task 8: Actions (orchestration)

Coordinates REST + socket + slice + prefs. Components call these; tests inject fakes.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/actions.ts`
- Create: `studio/frontend/src/plugins/llm-chat/actions.spec.ts`

**Interfaces:**

- Consumes: `restClient`, `socketClient` (via `getSocketClient`), `prefs`, `chatSlice` (earlier tasks).
- Produces (all operate on `chatSlice()`):
  - `loadRooms(): Promise<void>`
  - `openRoom(roomId: string): Promise<void>`
  - `createRoom(name: string, model?: string): Promise<void>`
  - `sendPrompt(text: string): void`
  - `setTyping(isTyping: boolean): void`
  - `setDisplayName(name: string): void`
  - `initChat(): void` — seed prefs into slice, init + connect socket, loadRooms, reopen saved room
- To keep actions unit-testable without the module singletons, the REST functions and a `SocketClient` are injected via a settable `__setDeps` seam (default wires the real modules).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/actions.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';

const rest = {
  getRooms: vi.fn(),
  createRoom: vi.fn(),
  getMessages: vi.fn(),
};
const socket = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  reconnectWith: vi.fn(),
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  sendPrompt: vi.fn(),
  setTyping: vi.fn(),
};
const savePrefs = vi.fn();

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
  Object.values(rest).forEach((f) => f.mockReset());
  Object.values(socket).forEach((f) => f.mockReset());
  savePrefs.mockReset();
  actions.__setDeps({ rest, socket, savePrefs });
});

describe('actions', () => {
  it('loadRooms populates rooms and sets status idle', async () => {
    rest.getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    await actions.loadRooms();
    expect(chatSlice().rooms.get()).toHaveLength(1);
    expect(chatSlice().roomsStatus.get()).toBe('idle');
  });

  it('loadRooms sets status error on failure', async () => {
    rest.getRooms.mockRejectedValue(new Error('down'));
    await actions.loadRooms();
    expect(chatSlice().roomsStatus.get()).toBe('error');
  });

  it('openRoom leaves previous, clears, fetches history, joins, and persists', async () => {
    chatSlice().activeRoomId.set('old');
    rest.getMessages.mockResolvedValue([{ id: 'm1', roomId: 'r1', author: 'a', role: 'user', content: 'h', status: 'complete', createdAt: 't' }]);
    await actions.openRoom('r1');
    expect(socket.leaveRoom).toHaveBeenCalledWith('old');
    expect(chatSlice().activeRoomId.get()).toBe('r1');
    expect(chatSlice().messages.get()).toHaveLength(1);
    expect(socket.joinRoom).toHaveBeenCalledWith('r1');
    expect(savePrefs).toHaveBeenCalledWith({ displayName: 'guest-0001', activeRoomId: 'r1' });
  });

  it('openRoom is a no-op when the room is already active', async () => {
    chatSlice().activeRoomId.set('r1');
    await actions.openRoom('r1');
    expect(socket.joinRoom).not.toHaveBeenCalled();
  });

  it('createRoom posts then opens the new room', async () => {
    rest.createRoom.mockResolvedValue({ id: 'r9', name: 'New', model: 'm', gameId: null, createdAt: 't' });
    rest.getMessages.mockResolvedValue([]);
    await actions.createRoom('New');
    expect(rest.createRoom).toHaveBeenCalledWith('New', undefined);
    expect(chatSlice().activeRoomId.get()).toBe('r9');
  });

  it('sendPrompt/setTyping forward to the socket for the active room', () => {
    chatSlice().activeRoomId.set('r1');
    actions.sendPrompt('hello');
    actions.setTyping(true);
    expect(socket.sendPrompt).toHaveBeenCalledWith('r1', 'hello');
    expect(socket.setTyping).toHaveBeenCalledWith('r1', true);
  });

  it('setDisplayName updates slice, persists, and reconnects', () => {
    actions.setDisplayName('alice');
    expect(chatSlice().displayName.get()).toBe('alice');
    expect(savePrefs).toHaveBeenCalledWith({ displayName: 'alice', activeRoomId: null });
    expect(socket.reconnectWith).toHaveBeenCalledWith('alice');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/actions.spec.ts`
Expected: FAIL — cannot resolve `./actions`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/llm-chat/actions.ts`:

```ts
import { chatSlice } from './state';
import * as realRest from './restClient';
import { getSocketClient, initSocketClient, type SocketClient } from './socketClient';
import { loadPrefs, savePrefs as realSavePrefs } from './prefs';

interface IRestDeps {
  getRooms: typeof realRest.getRooms;
  createRoom: typeof realRest.createRoom;
  getMessages: typeof realRest.getMessages;
}

// Injectable deps so actions are unit-testable without the module singletons.
let rest: IRestDeps = realRest;
let socket: Pick<SocketClient, 'connect' | 'disconnect' | 'reconnectWith' | 'joinRoom' | 'leaveRoom' | 'sendPrompt' | 'setTyping'> | null = null;
let savePrefs = realSavePrefs;

export function __setDeps(deps: { rest?: IRestDeps; socket?: typeof socket; savePrefs?: typeof savePrefs }): void {
  if (deps.rest) rest = deps.rest;
  if (deps.socket) socket = deps.socket;
  if (deps.savePrefs) savePrefs = deps.savePrefs;
}

function sock() {
  return socket ?? getSocketClient();
}

function persist(): void {
  const s = chatSlice();
  savePrefs({ displayName: s.displayName.get(), activeRoomId: s.activeRoomId.get() });
}

export async function loadRooms(): Promise<void> {
  chatSlice().roomsStatus.set('loading');
  try {
    const rooms = await rest.getRooms();
    chatSlice().rooms.set(rooms);
    chatSlice().roomsStatus.set('idle');
  } catch {
    chatSlice().roomsStatus.set('error');
  }
}

export async function openRoom(roomId: string): Promise<void> {
  const s = chatSlice();
  if (s.activeRoomId.get() === roomId) return;

  const prev = s.activeRoomId.get();
  if (prev) sock().leaveRoom(prev);

  s.activeRoomId.set(roomId);
  s.messages.set([]);
  s.members.set([]);
  s.typing.set([]);
  s.aiStatus.set({ state: 'idle', queueDepth: 0 });
  s.roomLoadStatus.set('loading');
  persist();

  try {
    const history = await rest.getMessages(roomId);
    s.messages.set(history);
    s.roomLoadStatus.set('idle');
  } catch {
    s.roomLoadStatus.set('error');
  }
  sock().joinRoom(roomId);
}

export async function createRoom(name: string, model?: string): Promise<void> {
  const room = await rest.createRoom(name, model);
  chatSlice().rooms.merge([room]);
  await openRoom(room.id);
}

export function sendPrompt(text: string): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().sendPrompt(roomId, text);
}

export function setTyping(isTyping: boolean): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().setTyping(roomId, isTyping);
}

export function setDisplayName(name: string): void {
  chatSlice().displayName.set(name);
  persist();
  sock().reconnectWith(name);
}

export function initChat(): void {
  const prefs = loadPrefs();
  const s = chatSlice();
  s.displayName.set(prefs.displayName);
  initSocketClient();
  getSocketClient().connect(prefs.displayName);
  void loadRooms();
  if (prefs.activeRoomId) void openRoom(prefs.activeRoomId);
}
```

Note: `initChat` uses the real singletons; the unit tests exercise the other actions with injected deps and do not call `initChat`. `createRoom`’s history fetch resolves to `[]` in its test because `openRoom` calls `getMessages`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/actions.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/actions.ts studio/frontend/src/plugins/llm-chat/actions.spec.ts
git add studio/frontend/src/plugins/llm-chat/actions.ts studio/frontend/src/plugins/llm-chat/actions.spec.ts
git commit -m "feat(frontend): llm-chat actions (orchestration)"
```

---

## Task 9: Plugin manifest + registration + default layout

Wire the plugin into the workbench. Panes/commands are stubbed minimally here so the manifest is testable; full pane UI lands in Tasks 10–12.

**Files:**

- Create: `studio/frontend/src/plugins/llm-chat/index.ts`
- Create: `studio/frontend/src/plugins/llm-chat/RoomListPane.tsx` (minimal stub)
- Create: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx` (minimal stub)
- Create: `studio/frontend/src/plugins/llm-chat/SettingsPane.tsx` (minimal stub)
- Modify: `studio/frontend/src/plugins/index.ts` (add `llmChat`)
- Modify: `studio/frontend/src/app/workbenchSetup.ts` (add Room List to `DEFAULT_LAYOUT`)
- Create: `studio/frontend/src/plugins/llm-chat/index.spec.ts`

**Interfaces:**

- Consumes: `IPlugin` (host), `initChat` (Task 8), `makeInitialState`/`LLM_CHAT_PLUGIN_ID` (Task 2).
- Produces: `llmChat: IPlugin<ILlmChatState>` with pane ids `llm-chat/rooms`, `llm-chat/room`, `llm-chat/settings` and command ids `llm-chat/open-rooms`, `llm-chat/open-room`, `llm-chat/open-settings`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/index.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { llmChat } from './index';

describe('llmChat plugin manifest', () => {
  it('declares id, persist:false, and three panes', () => {
    expect(llmChat.id).toBe('llm-chat');
    expect(llmChat.persist).toBe(false);
    expect(llmChat.panes.map((p) => p.id)).toEqual(['llm-chat/rooms', 'llm-chat/room', 'llm-chat/settings']);
  });

  it('declares three commands', () => {
    expect(llmChat.commands?.map((c) => c.id)).toEqual(['llm-chat/open-rooms', 'llm-chat/open-room', 'llm-chat/open-settings']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/index.spec.ts`
Expected: FAIL — cannot resolve `./index`.

- [ ] **Step 3: Create minimal pane stubs**

Create `studio/frontend/src/plugins/llm-chat/RoomListPane.tsx`:

```tsx
export function RoomListPane() {
  return <div data-testid="room-list-pane" style={{ padding: 12 }} />;
}
```

Create `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`:

```tsx
export function ChatRoomPane() {
  return <div data-testid="chat-room-pane" style={{ padding: 12 }} />;
}
```

Create `studio/frontend/src/plugins/llm-chat/SettingsPane.tsx`:

```tsx
export function SettingsPane() {
  return <div data-testid="chat-settings-pane" style={{ padding: 12 }} />;
}
```

- [ ] **Step 4: Write the manifest**

Create `studio/frontend/src/plugins/llm-chat/index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import type { ILlmChatState } from './state';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import { generateGuestName } from './prefs';
import { initChat } from './actions';
import { RoomListPane } from './RoomListPane';
import { ChatRoomPane } from './ChatRoomPane';
import { SettingsPane } from './SettingsPane';

export const llmChat: IPlugin<ILlmChatState> = {
  id: LLM_CHAT_PLUGIN_ID,
  title: 'LLM Chat',
  persist: false,
  // Real prefs are loaded in initChat(); this seed keeps the slice well-typed pre-init.
  initialState: makeInitialState(generateGuestName(), null),
  panes: [
    { id: 'llm-chat/rooms', title: 'Rooms', component: RoomListPane as never },
    { id: 'llm-chat/room', title: 'Chat Room', component: ChatRoomPane as never },
    { id: 'llm-chat/settings', title: 'Chat Settings', component: SettingsPane as never },
  ],
  commands: [
    { id: 'llm-chat/open-rooms', title: 'Open Room List', run: (host) => host.openPane('llm-chat/rooms') },
    { id: 'llm-chat/open-room', title: 'Open Chat Room', run: (host) => host.openPane('llm-chat/room') },
    { id: 'llm-chat/open-settings', title: 'Open Chat Settings', run: (host) => host.openPane('llm-chat/settings') },
  ],
  init: () => initChat(),
};
```

- [ ] **Step 5: Register the plugin and add Room List to the default layout**

Modify `studio/frontend/src/plugins/index.ts`:

```ts
import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat];
```

Modify `studio/frontend/src/app/workbenchSetup.ts` — in `DEFAULT_LAYOUT`, add the Room List pane below the scratch pane (demos kept for now):

```ts
add('demo-scratch/main', {
  direction: 'below',
  referencePanel: 'demo-counter/editor',
});
add('llm-chat/rooms', {
  direction: 'right',
  referencePanel: 'demo-scratch/main',
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx nx test frontend src/plugins/llm-chat/index.spec.ts`
Expected: PASS (2 tests).

Then the full suite:

Run: `npx nx test frontend`
Expected: PASS. Note: no unit test boots the real `PLUGINS` array (`boot.spec.ts` uses synthetic dummy plugins; nothing imports `setupWorkbench`/`PLUGINS` in a spec), so `initChat()` — and the real `io()` socket — is **not** exercised by vitest. `initChat` runs only in the browser e2e (Task 13). Should a future test boot real `PLUGINS`, `boot.ts` already wraps each `init()` in try/catch, so a socket-construction error would be isolated, not fatal.

- [ ] **Step 7: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/index.ts studio/frontend/src/plugins/llm-chat/index.spec.ts studio/frontend/src/plugins/llm-chat/RoomListPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/SettingsPane.tsx studio/frontend/src/plugins/index.ts studio/frontend/src/app/workbenchSetup.ts
git add studio/frontend/src/plugins/llm-chat/index.ts studio/frontend/src/plugins/llm-chat/index.spec.ts studio/frontend/src/plugins/llm-chat/RoomListPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/SettingsPane.tsx studio/frontend/src/plugins/index.ts studio/frontend/src/app/workbenchSetup.ts
git commit -m "feat(frontend): register llm-chat plugin + default layout slot"
```

---

## Task 10: Room List pane

Lists rooms, creates rooms, opens a room. Subscribes only to `rooms`/`roomsStatus`.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/RoomListPane.tsx`
- Create: `studio/frontend/src/plugins/llm-chat/RoomListPane.spec.tsx`

**Interfaces:**

- Consumes: `llmChatHooks` (Task 2), `actions.createRoom`/`actions.openRoom` (Task 8), `bumpRenderCount`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/RoomListPane.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';
import { RoomListPane } from './RoomListPane';

vi.spyOn(actions, 'createRoom').mockResolvedValue(undefined);
vi.spyOn(actions, 'openRoom').mockResolvedValue(undefined);

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
  vi.clearAllMocks();
});

describe('RoomListPane', () => {
  it('renders rooms from the slice', () => {
    rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID).merge({
      rooms: [{ id: 'r1', name: 'General', model: 'm', gameId: null, createdAt: 't' }],
    } as never);
    render(<RoomListPane />);
    expect(screen.getByText('General')).toBeTruthy();
  });

  it('clicking a room calls openRoom', () => {
    rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID).merge({
      rooms: [{ id: 'r1', name: 'General', model: 'm', gameId: null, createdAt: 't' }],
    } as never);
    render(<RoomListPane />);
    fireEvent.click(screen.getByTestId('room-open-r1'));
    expect(actions.openRoom).toHaveBeenCalledWith('r1');
  });

  it('submitting the new-room form calls createRoom', () => {
    render(<RoomListPane />);
    fireEvent.change(screen.getByTestId('new-room-input'), { target: { value: 'Brainstorm' } });
    fireEvent.click(screen.getByTestId('new-room-create'));
    expect(actions.createRoom).toHaveBeenCalledWith('Brainstorm');
  });

  it('shows a retry affordance when roomsStatus is error', () => {
    rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID).merge({ roomsStatus: 'error' } as never);
    render(<RoomListPane />);
    expect(screen.getByTestId('rooms-error')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/RoomListPane.spec.tsx`
Expected: FAIL — stub renders nothing matching the queries.

- [ ] **Step 3: Write the implementation**

Replace `studio/frontend/src/plugins/llm-chat/RoomListPane.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { llmChatHooks } from './state';
import { createRoom, openRoom, loadRooms } from './actions';
import { bumpRenderCount } from '../../app/renderCount';

export function RoomListPane() {
  const s = llmChatHooks.usePluginState();
  const [name, setName] = useState('');
  bumpRenderCount('RoomListPane');

  const rooms = s.rooms.get();
  const status = s.roomsStatus.get();

  return (
    <div data-testid="room-list-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 4 }}>
        <input data-testid="new-room-input" value={name} placeholder="New room name" onChange={(e) => setName(e.target.value)} />
        <Button
          data-testid="new-room-create"
          onClick={() => {
            if (name.trim()) {
              void createRoom(name.trim());
              setName('');
            }
          }}
        >
          Create
        </Button>
      </div>

      {status === 'error' && (
        <div data-testid="rooms-error">
          Couldn’t load rooms.{' '}
          <Button data-testid="rooms-retry" onClick={() => void loadRooms()}>
            Retry
          </Button>
        </div>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {rooms.map((r) => (
          <li key={r.id}>
            <Button data-testid={`room-open-${r.id}`} onClick={() => void openRoom(r.id)}>
              {r.name}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/RoomListPane.spec.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/RoomListPane.tsx studio/frontend/src/plugins/llm-chat/RoomListPane.spec.tsx
git add studio/frontend/src/plugins/llm-chat/RoomListPane.tsx studio/frontend/src/plugins/llm-chat/RoomListPane.spec.tsx
git commit -m "feat(frontend): llm-chat Room List pane"
```

---

## Task 11: Chat Room pane (with per-message scoped subscription)

Renders the active room: message list (each bubble its own subscriber), composer, typing line, presence, AI status, connection indicator, empty state. The render-count test proves a token append re-renders only the streaming bubble.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Create: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`

**Interfaces:**

- Consumes: `llmChatHooks` (Task 2), `actions.sendPrompt`/`actions.setTyping` (Task 8), `appendToken` (Task 3, used by the render-count test to mutate the slice), `bumpRenderCount`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID, type IMessage } from './state';
import { appendToken } from './reducers';
import * as actions from './actions';
import { ChatRoomPane } from './ChatRoomPane';

vi.spyOn(actions, 'sendPrompt').mockReturnValue(undefined);
vi.spyOn(actions, 'setTyping').mockReturnValue(undefined);

const msg = (over: Partial<IMessage>): IMessage => ({
  id: 'm1',
  roomId: 'r1',
  author: 'assistant',
  role: 'assistant',
  content: '',
  status: 'streaming',
  createdAt: 't',
  ...over,
});

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', 'r1') });
  vi.clearAllMocks();
  window.__renderCounts = {};
});

describe('ChatRoomPane', () => {
  it('shows an empty state when no room is active', () => {
    chatSlice().activeRoomId.set(null);
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-empty')).toBeTruthy();
  });

  it('renders messages and reflects their content', () => {
    chatSlice().messages.set([msg({ id: 'a1', content: 'Hello' })]);
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-msg-a1').textContent).toContain('Hello');
  });

  it('sending the composer calls sendPrompt', () => {
    render(<ChatRoomPane />);
    fireEvent.change(screen.getByTestId('chat-composer'), { target: { value: 'hi there' } });
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(actions.sendPrompt).toHaveBeenCalledWith('hi there');
  });

  it('shows the connection indicator', () => {
    chatSlice().connection.set('reconnecting');
    render(<ChatRoomPane />);
    expect(screen.getByTestId('chat-connection').getAttribute('data-state')).toBe('reconnecting');
  });

  it('appending a token re-renders only that bubble, not the whole pane', () => {
    chatSlice().messages.set([msg({ id: 'a1', content: 'He' })]);
    render(<ChatRoomPane />);
    window.__renderCounts = {}; // reset after mount
    act(() => {
      const cur = chatSlice().messages.get({ noproxy: true }) as IMessage[];
      chatSlice().messages.set(appendToken(cur, 'r1', 'a1', 'llo'));
    });
    expect(screen.getByTestId('chat-msg-a1').textContent).toContain('Hello');
    // The bubble re-rendered; the pane shell did not.
    expect(window.__renderCounts['ChatMessageBubble'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(window.__renderCounts['ChatRoomPane'] ?? 0).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: FAIL — stub renders nothing matching the queries.

- [ ] **Step 3: Write the implementation**

Replace `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`:

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { llmChatHooks } from './state';
import { sendPrompt, setTyping } from './actions';
import { bumpRenderCount } from '../../app/renderCount';

// Each bubble subscribes to ITS OWN message node, so a token append re-renders
// only the streaming bubble — not the list container, not the pane shell.
function ChatMessageBubble({ index }: { index: number }) {
  const s = llmChatHooks.usePluginState();
  const m = s.messages[index];
  bumpRenderCount('ChatMessageBubble');
  return (
    <li data-testid={`chat-msg-${m.id.get()}`} data-role={m.role.get()} data-status={m.status.get()}>
      <strong>{m.author.get()}:</strong> {m.content.get()}
    </li>
  );
}

function MessageList() {
  const s = llmChatHooks.usePluginState();
  // Subscribe only to the LENGTH so appends (length change) re-render the list,
  // but content edits (token) do not touch this component.
  const count = s.messages.length;
  return (
    <ul data-testid="chat-messages" style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1, overflow: 'auto' }}>
      {Array.from({ length: count }, (_, i) => (
        <ChatMessageBubble key={i} index={i} />
      ))}
    </ul>
  );
}

function ConnectionIndicator() {
  const s = llmChatHooks.usePluginState();
  const state = s.connection.get();
  return (
    <span data-testid="chat-connection" data-state={state} style={{ fontSize: '0.8rem', opacity: 0.7 }}>
      {state === 'connected' ? '● connected' : `○ ${state}…`}
    </span>
  );
}

function TypingLine() {
  const s = llmChatHooks.usePluginState();
  const who = s.typing.get();
  if (who.length === 0) return null;
  return (
    <div data-testid="chat-typing" style={{ fontStyle: 'italic', opacity: 0.7 }}>
      {who.join(', ')} typing…
    </div>
  );
}

function PresenceLine() {
  const s = llmChatHooks.usePluginState();
  const members = s.members.get();
  return (
    <div data-testid="chat-presence" style={{ fontSize: '0.8rem', opacity: 0.7 }}>
      In room: {members.join(', ')}
    </div>
  );
}

function AiStatusLine() {
  const s = llmChatHooks.usePluginState();
  const st = s.aiStatus.get();
  return (
    <span data-testid="chat-ai-status" data-state={st.state} style={{ fontSize: '0.8rem', opacity: 0.7 }}>
      AI: {st.state}
      {st.queueDepth > 0 ? ` (${st.queueDepth} queued)` : ''}
    </span>
  );
}

export function ChatRoomPane() {
  const s = llmChatHooks.usePluginState();
  const [draft, setDraft] = useState('');
  bumpRenderCount('ChatRoomPane');

  if (s.activeRoomId.get() === null) {
    return (
      <div data-testid="chat-empty" style={{ padding: 12 }}>
        Pick or create a room in the Rooms pane to start chatting.
      </div>
    );
  }

  const submit = () => {
    if (draft.trim()) {
      sendPrompt(draft.trim());
      setDraft('');
      setTyping(false);
    }
  };

  return (
    <div data-testid="chat-room-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <ConnectionIndicator />
        <AiStatusLine />
      </div>
      <PresenceLine />
      <MessageList />
      <TypingLine />
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          data-testid="chat-composer"
          value={draft}
          placeholder="Message…"
          onChange={(e) => {
            setDraft(e.target.value);
            setTyping(e.target.value.length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          style={{ flex: 1 }}
        />
        <Button data-testid="chat-send" onClick={submit}>
          Send
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/ChatRoomPane.spec.tsx`
Expected: PASS (5 tests) — including the render-count discipline test.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
git commit -m "feat(frontend): llm-chat Chat Room pane (scoped per-message render)"
```

---

## Task 12: Settings pane

Editable display name (commits → `setDisplayName`) and a per-room model picker populated from `GET /models`.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/SettingsPane.tsx`
- Create: `studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx`

**Interfaces:**

- Consumes: `llmChatHooks` (Task 2), `actions.setDisplayName` (Task 8), `getModels` (Task 5), `bumpRenderCount`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';
import * as rest from './restClient';
import { SettingsPane } from './SettingsPane';

vi.spyOn(actions, 'setDisplayName').mockReturnValue(undefined);
vi.spyOn(rest, 'getModels').mockResolvedValue([
  { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', free: false },
  { id: 'meta-llama/llama-3.2-3b-instruct:free', label: 'Llama 3.2 3B (free)', free: true },
]);

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
  vi.clearAllMocks();
});

describe('SettingsPane', () => {
  it('shows the current display name and commits edits', () => {
    render(<SettingsPane />);
    const input = screen.getByTestId('settings-displayname') as HTMLInputElement;
    expect(input.value).toBe('guest-0001');
    fireEvent.change(input, { target: { value: 'alice' } });
    fireEvent.blur(input);
    expect(actions.setDisplayName).toHaveBeenCalledWith('alice');
  });

  it('loads and lists models from GET /models', async () => {
    render(<SettingsPane />);
    await waitFor(() => expect(screen.getByTestId('settings-model')).toBeTruthy());
    expect(screen.getByText('GPT-4o mini')).toBeTruthy();
    expect(screen.getByText('Llama 3.2 3B (free)')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend src/plugins/llm-chat/SettingsPane.spec.tsx`
Expected: FAIL — stub renders nothing matching the queries.

- [ ] **Step 3: Write the implementation**

Replace `studio/frontend/src/plugins/llm-chat/SettingsPane.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { llmChatHooks } from './state';
import { setDisplayName } from './actions';
import { getModels, type IModelOption } from './restClient';
import { bumpRenderCount } from '../../app/renderCount';

export function SettingsPane() {
  const s = llmChatHooks.usePluginState();
  const [name, setName] = useState(s.displayName.get());
  const [models, setModels] = useState<IModelOption[]>([]);
  bumpRenderCount('SettingsPane');

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {
        /* surfaced elsewhere; picker simply stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="chat-settings-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Display name
        <input
          data-testid="settings-displayname"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (next && next !== s.displayName.get()) setDisplayName(next);
          }}
        />
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        Model (active room)
        <select data-testid="settings-model" defaultValue="">
          <option value="" disabled>
            Select a model…
          </option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
```

Note: the model picker reads the catalogue now; wiring a model **change** to the room (a `PATCH /rooms/{id}` route) is out of scope for this subsystem — the backend has no room-update route yet, and the parent spec only requires the catalogue to be served and selectable. Leave the `<select>` presentational here; a follow-up adds the persist-on-change once a room-update endpoint exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx nx test frontend src/plugins/llm-chat/SettingsPane.spec.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full unit suite**

Run: `npx nx test frontend`
Expected: PASS (all llm-chat specs + existing suite).

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/SettingsPane.tsx studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx
git add studio/frontend/src/plugins/llm-chat/SettingsPane.tsx studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx
git commit -m "feat(frontend): llm-chat Settings pane (display name + model catalogue)"
```

---

## Task 13: Browser e2e (local-only) + justfile target

The authoritative client-behavior suite. Runs against the live backend with the **fake** provider. NOT in CI.

**Files:**

- Create: `studio/frontend/e2e/llm-chat.spec.ts`
- Modify: `justfile` (add `e2e-chat` target)

**Interfaces:**

- Consumes: the running app at `http://localhost:4200` and backend at `http://localhost:8000` (fake provider).

- [ ] **Step 1: Add a justfile target to run the backend (fake) for e2e**

Modify `justfile` — add:

```make
# Run the backend with the fake LLM provider for browser e2e (no API key needed).
backend-serve-fake:
    cd studio/backend && LLM_BACKEND=fake uv run uvicorn app.main:app --port 8000

# Browser e2e for the chat plugin. Start `just backend-serve-fake` in another
# terminal first (Playwright starts only the frontend). Local-only; not in CI.
e2e-chat:
    npx playwright test --config=studio/frontend/playwright.config.ts llm-chat
```

- [ ] **Step 2: Write the e2e spec**

Create `studio/frontend/e2e/llm-chat.spec.ts`:

```ts
import { test, expect, type Page } from '@playwright/test';

// Requires: `just backend-serve-fake` running on :8000 (fake provider streams
// deterministic tokens) and the frontend dev server (Playwright starts it).

async function openChat(page: Page, displayName: string) {
  // Seed the display name so connect uses it deterministically.
  await page.addInitScript(
    ([k, v]) => localStorage.setItem(k, v),
    ['bloom.studio.llm-chat.prefs', JSON.stringify({ version: 1, data: { displayName, activeRoomId: null } })],
  );
  await page.goto('/');
  await expect(page.getByTestId('room-list-pane')).toBeVisible();
}

test('create a room, send a prompt, and watch the assistant stream', async ({ page }) => {
  await openChat(page, 'alice');
  await page.getByTestId('new-room-input').fill('E2E Room');
  await page.getByTestId('new-room-create').click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  await page.getByTestId('chat-composer').fill('Hello there');
  await page.getByTestId('chat-send').click();

  // user message appears, then the assistant message streams to non-empty content
  await expect(page.getByTestId('chat-messages')).toContainText('Hello there');
  const assistant = page.locator('[data-role="assistant"]').last();
  await expect(assistant).not.toHaveText('', { timeout: 10_000 });
  await expect(assistant).toHaveAttribute('data-status', 'complete', { timeout: 10_000 });
});

test('two clients in one room both see the stream and each other in presence', async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await openChat(a, 'alice');

  // alice creates + opens a room
  await a.getByTestId('new-room-input').fill('Shared');
  await a.getByTestId('new-room-create').click();
  await expect(a.getByTestId('chat-room-pane')).toBeVisible();

  // bob opens the same room from his Room List
  await openChat(b, 'bob');
  await b.getByTestId('room-open-' + (await firstRoomId(b))).click();
  await expect(b.getByTestId('chat-room-pane')).toBeVisible();

  // presence on alice's side eventually includes bob
  await expect(a.getByTestId('chat-presence')).toContainText('bob', { timeout: 10_000 });

  // alice sends; both see the assistant stream
  await a.getByTestId('chat-composer').fill('Ping');
  await a.getByTestId('chat-send').click();
  await expect(a.locator('[data-role="assistant"]').last()).not.toHaveText('', { timeout: 10_000 });
  await expect(b.locator('[data-role="assistant"]').last()).not.toHaveText('', { timeout: 10_000 });

  await a.close();
  await b.close();
});

// Helper: read the id of the first room from the Room List open button.
async function firstRoomId(page: Page): Promise<string> {
  const btn = page.locator('[data-testid^="room-open-"]').first();
  const testId = await btn.getAttribute('data-testid');
  return testId!.replace('room-open-', '');
}
```

- [ ] **Step 3: Run the e2e suite locally (manual gate — not CI)**

In one terminal: `just backend-serve-fake`
In another: `just e2e-chat`
Expected: both tests PASS — assistant content streams to non-empty + completes; presence shows the second client.

If MongoDB is not running, start it first (see `bloom-backend-toolchain` notes). The fake provider needs no API key.

- [ ] **Step 4: Commit**

```bash
npx prettier --write studio/frontend/e2e/llm-chat.spec.ts
git add studio/frontend/e2e/llm-chat.spec.ts justfile
git commit -m "test(frontend): llm-chat browser e2e (local-only) + just target"
```

---

## Task 14: Final verification + PR

- [ ] **Step 1: Full unit suite + lint/build**

Run:

```bash
npx nx test frontend
npx nx lint frontend
npx nx build frontend
```

Expected: all PASS.

- [ ] **Step 2: Manual smoke (optional but recommended)**

Start `just backend-serve-fake` + `just serve-frontend`, open `http://localhost:4200`, confirm: Room List visible, create a room, send a prompt, watch streaming, edit display name in Settings and confirm reconnect.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feat/llm-chat-frontend-plugin
gh pr create --title "feat(frontend): llm-chat plugin (Plan B subsystem 2)" --base main
```

(Create the branch `feat/llm-chat-frontend-plugin` at the start of execution if not already on it.)

---

## Self-review notes (coverage against the design spec)

- **§3.1 persistence boundary** → Tasks 2 (slice persist:false) + 4 (prefs) + 8 (`persist()` in actions). ✔
- **§3.2 eager socket** → Task 8 `initChat` connects on init; Task 6 reconnect re-joins. ✔
- **§3.3 guest name** → Task 4 generator; Task 12 editable; Task 8 `setDisplayName` reconnect. ✔
- **§3.4 / §10 notifications** → Task 1 seam+Toaster; Task 7 `error` → `notify`. ✔
- **§4 backend contract** → Task 5 (REST), Tasks 6–7 (socket events, auth). ✔
- **§6 slice shape** → Task 2. ✔
- **§7 lifecycle** → Task 8 (openRoom leave→clear→fetch→join→persist; createRoom; reconnect). ✔
- **§8 event table (find-or-create)** → Task 3 (reducers) + Task 7 (wiring + roomId guard). ✔
- **§9 panes/commands/default layout** → Tasks 9 (manifest+layout), 10, 11, 12. ✔
- **§11 testing** → vitest across Tasks 1–12; Playwright Task 13 (two-client + streaming). ✔
- **§12 deps/config** → Task 1 (`sonner`), Task 5 (`config.ts`), Task 6 (`socket.io-client`). ✔
- **Known deferral:** model-change persistence needs a backend room-update route (no such route today) — Task 12 leaves the picker presentational and flags the follow-up. The parent spec only requires the catalogue served + selectable. ✔
- **In-flight resume e2e** (a third client joining mid-stream) is already covered by the authoritative _backend_ three-client suite (subsystem 1); the browser e2e here covers two-client live streaming + presence. Mid-stream UI resume can be added to the browser suite later if desired.

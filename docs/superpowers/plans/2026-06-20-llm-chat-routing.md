# LLM Chat Routing, Room Picker & Lightweight Login — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `studio/frontend` entry point an identity "login" + room-picker flow, and tie the Dockview workbench to a single chat room addressed by a shareable/bookmarkable URL (`/room/:roomId`), by **refactoring the already-merged `llm-chat` plugin** to be route-driven.

**Architecture:** Introduce React Router v7 with two kinds of top-level UI: plain routed screens (`/login`, `/` picker) outside Dockview, and the existing Dockview workbench mounted only at `/room/:roomId`. The **URL is the source of truth for the active room**: `RoomRoute` drives the plugin's existing, tested `openRoom(roomId)` action from the route param, which keeps `slice.activeRoomId` in sync — the socket/streaming core is reused untouched. Plugin registration is hoisted to run once at app mount (lifecycle split); the socket connects with the **logged-in username** instead of an auto-generated guest name.

**Tech Stack:** React 18.3.1, TypeScript, Vite (Nx), `react-router-dom` v7 (declarative mode), `@hookstate/core`, existing `socket.io-client` + `sonner`/`notify` seam, Dockview, vitest + `@testing-library/react` (unit, CI), Playwright (e2e, local-only).

## Context: what already exists on `main` (PR #24)

The `llm-chat` plugin is **built and merged**. Do NOT recreate these — reuse them:

- `src/plugins/llm-chat/restClient.ts` — `getModels`, `getRooms`, `createRoom(name, model?)`, `getMessages(roomId)`. **Use this for the picker** (no new REST client, no `src/rooms/` or `src/config.ts`).
- `src/plugins/llm-chat/config.ts` — `BACKEND_URL`.
- `src/plugins/llm-chat/state.ts` — `IRoom`, `IMessage`, `ILlmChatState`, `chatSlice()`, `llmChatHooks`, `LLM_CHAT_PLUGIN_ID`. `activeRoomId` is a slice field.
- `src/plugins/llm-chat/actions.ts` — `loadRooms`, `openRoom(roomId)` (leave→clear→fetch history→join, persists), `createRoom`, `sendPrompt`, `setTyping`, `setDisplayName`, `initChat()`.
- `src/plugins/llm-chat/socketClient.ts` — module singleton; `connect(displayName)`, `reconnectWith`, `disconnect`, `joinRoom`/`leaveRoom`/`sendPrompt`/`setTyping`; on `connect` it re-joins `activeRoomId`.
- `src/plugins/llm-chat/prefs.ts` — persists `{ displayName, activeRoomId }` under `llm-chat.prefs`; `generateGuestName()` → `guest-NNNN`.
- `RoomListPane.tsx` (splash pane — **to be removed**), `ChatRoomPane.tsx` (reads `slice.activeRoomId`; empty state when null), `SettingsPane.tsx` (display-name field **to be removed** + model picker).
- `src/lib/notify.ts` (`notify.error/info`) + `src/components/ui/sonner.tsx` (`Toaster`) — **exist**; `<Toaster/>` is currently mounted inside `Workbench.tsx`.
- `src/app/workbenchSetup.ts` — `setupWorkbench()` (once-only setup) + `DEFAULT_LAYOUT` (now includes `llm-chat/rooms` + `llm-chat/room`).
- Deps present: `socket.io-client`, `sonner`. **`react-router-dom` is NOT installed.**

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`ISession`) — repo coding standard.
- **Routing:** React Router v7, **declarative/library mode** (`react-router-dom` + `<BrowserRouter>`). No framework/SSR/loaders.
- **Identity is capture-only, not auth.** Username persisted to localStorage; used as the user key + the socket `auth: { displayName }`.
- **Identity persistence key:** `bloom.studio.session` (via `savePersisted`/`loadPersisted`; pass `session` — the helper adds the `bloom.studio.` prefix).
- **URL is the source of truth for the active room.** `RoomRoute` drives `openRoom(roomId)`; `slice.activeRoomId` is a route-driven mirror, never set by a pane click.
- **Toasts:** import the `notify` seam, never `sonner` directly.
- **Bare `/` when logged in → always the picker** (no last-room auto-resume).
- **TDD**; **semantic commits**; work on branch `feat/llm-chat-routing`; `main` is protected (PR + squash-merge).
- **Unit tests run in CI; Playwright is local-only.** Run unit tests with `npx nx test frontend`.

---

## File Structure

**Create:**

- `src/session/session.ts` (+ `.spec.ts`) — `ISession`, `loadSession/saveSession/clearSession`.
- `src/session/SessionContext.tsx` (+ `.spec.tsx`) — `SessionProvider`, `useSession`.
- `src/app/AppContext.tsx` — `AppProvider` (runs app setup once), `useApp`.
- `src/app/setupApp.ts` (+ `.spec.ts`) — once-only setup extracted from `workbenchSetup.ts`.
- `src/app/routes/activeRoom.ts` (+ `.spec.tsx`) — `ActiveRoomProvider`, `useActiveRoomId`.
- `src/app/routes/AppRoutes.tsx` — `<Routes>` table.
- `src/app/routes/RequireSession.tsx` (+ `.spec.tsx`) — guard with return-URL.
- `src/app/routes/LoginScreen.tsx` (+ `.spec.tsx`).
- `src/app/routes/RoomPicker.tsx` (+ `.spec.tsx`) — replaces RoomListPane.
- `src/app/routes/RoomRoute.tsx` (+ `.spec.tsx`) — drives `openRoom`, renders workbench.
- `src/app/SessionSync.tsx` (+ `.spec.tsx`) — connects/disconnects the chat socket on session change.
- `src/app/SwitchUser.tsx` (+ `.spec.tsx`) — log-out affordance.
- `e2e/routing.spec.ts`.

**Modify:**

- `src/app/workbenchSetup.ts` — split: keep `DEFAULT_LAYOUT` (retarget to the chat room), move once-only setup to `setupApp.ts`.
- `src/app/Workbench.tsx` — consume `useApp()`; remove `<Toaster/>` (moves to app root); add `<SwitchUser/>`.
- `src/main.tsx` — render provider/router tree.
- `src/plugins/llm-chat/index.ts` — remove RoomListPane pane + `open-rooms` command.
- `src/plugins/llm-chat/actions.ts` — add `connectChatAs`/`disconnectChat`/`closeRoom`; simplify `initChat` (no eager guest connect, no auto-resume).
- `src/plugins/llm-chat/SettingsPane.tsx` — remove the display-name field.
- root `package.json` — add `react-router-dom`.

**Delete:**

- `src/plugins/llm-chat/RoomListPane.tsx` (+ `.spec.tsx`).

---

### Task 1: Session module (identity persistence)

**Files:** Create `src/session/session.ts`, `src/session/session.spec.ts`.

**Interfaces — Produces:** `interface ISession { username: string }`; `loadSession(): ISession | null`; `saveSession(username: string): void`; `clearSession(): void`. Key `session`, version `1`.

- [ ] **Step 1: Failing test**

```ts
// src/session/session.spec.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSession, saveSession, clearSession } from './session';

beforeEach(() => localStorage.clear());

describe('session', () => {
  it('returns null when nothing stored', () => {
    expect(loadSession()).toBeNull();
  });
  it('round-trips a username', () => {
    saveSession('ada');
    expect(loadSession()).toEqual({ username: 'ada' });
  });
  it('clear removes it', () => {
    saveSession('ada');
    clearSession();
    expect(loadSession()).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`./session` not found): `npx nx test frontend -- src/session/session.spec.ts`

- [ ] **Step 3: Implement**

```ts
// src/session/session.ts
import { savePersisted, loadPersisted } from '../state/persistence';

const SESSION_KEY = 'session';
const SESSION_VERSION = 1;

export interface ISession {
  username: string;
}

export function loadSession(): ISession | null {
  const s = loadPersisted<ISession | null>(SESSION_KEY, SESSION_VERSION, null);
  if (!s || typeof s.username !== 'string' || s.username.length === 0) return null;
  return s;
}

export function saveSession(username: string): void {
  savePersisted<ISession>(SESSION_KEY, SESSION_VERSION, { username });
}

export function clearSession(): void {
  localStorage.removeItem('bloom.studio.' + SESSION_KEY);
}
```

- [ ] **Step 4: Run — expect PASS** (3): `npx nx test frontend -- src/session/session.spec.ts`

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/session/session.ts studio/frontend/src/session/session.spec.ts
git commit -m "feat(studio): session identity persistence (capture-only login)"
```

---

### Task 2: Session context (`SessionProvider` / `useSession`)

**Files:** Create `src/session/SessionContext.tsx`, `src/session/SessionContext.spec.tsx`.

**Interfaces — Consumes:** Task 1. **Produces:** `SessionProvider` (`{ children }`); `useSession(): { username: string | null; login(name: string): void; logout(): void }`.

- [ ] **Step 1: Failing test**

```tsx
// src/session/SessionContext.spec.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { SessionProvider, useSession } from './SessionContext';

beforeEach(() => localStorage.clear());

function Probe() {
  const { username, login, logout } = useSession();
  return (
    <div>
      <span data-testid="name">{username ?? 'anon'}</span>
      <button onClick={() => login('ada')}>login</button>
      <button onClick={logout}>logout</button>
    </div>
  );
}
const renderProbe = () =>
  render(
    <SessionProvider>
      <Probe />
    </SessionProvider>,
  );

describe('SessionContext', () => {
  it('starts anon', () => {
    renderProbe();
    expect(screen.getByTestId('name')).toHaveTextContent('anon');
  });
  it('login sets + persists', () => {
    renderProbe();
    act(() => screen.getByText('login').click());
    expect(screen.getByTestId('name')).toHaveTextContent('ada');
    expect(localStorage.getItem('bloom.studio.session')).toContain('ada');
  });
  it('logout clears', () => {
    renderProbe();
    act(() => screen.getByText('login').click());
    act(() => screen.getByText('logout').click());
    expect(screen.getByTestId('name')).toHaveTextContent('anon');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**: `npx nx test frontend -- src/session/SessionContext.spec.tsx`

- [ ] **Step 3: Implement**

```tsx
// src/session/SessionContext.tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { loadSession, saveSession, clearSession } from './session';

interface ISessionContext {
  username: string | null;
  login(name: string): void;
  logout(): void;
}
const Ctx = createContext<ISessionContext | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | null>(() => loadSession()?.username ?? null);
  const value = useMemo<ISessionContext>(
    () => ({
      username,
      login: (name: string) => {
        const t = name.trim();
        if (!t) return;
        saveSession(t);
        setUsername(t);
      },
      logout: () => {
        clearSession();
        setUsername(null);
      },
    }),
    [username],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): ISessionContext {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession must be used within <SessionProvider>');
  return v;
}
```

- [ ] **Step 4: Run — expect PASS** (3).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/session/SessionContext.tsx studio/frontend/src/session/SessionContext.spec.tsx
git commit -m "feat(studio): SessionProvider + useSession hook"
```

---

### Task 3: Active-room context (`useActiveRoomId`)

**Files:** Create `src/app/routes/activeRoom.ts`, `src/app/routes/activeRoom.spec.tsx`.

**Interfaces — Produces:** `ActiveRoomProvider` (`{ roomId, children }`); `useActiveRoomId(): string` (throws outside a room route). The seam for any component that wants the URL room id directly.

- [ ] **Step 1: Failing test**

```tsx
// src/app/routes/activeRoom.spec.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActiveRoomProvider, useActiveRoomId } from './activeRoom';

function Probe() {
  return <span data-testid="rid">{useActiveRoomId()}</span>;
}

describe('useActiveRoomId', () => {
  it('exposes the provided id', () => {
    render(
      <ActiveRoomProvider roomId="r-42">
        <Probe />
      </ActiveRoomProvider>,
    );
    expect(screen.getByTestId('rid')).toHaveTextContent('r-42');
  });
  it('throws outside a room route', () => {
    expect(() => render(<Probe />)).toThrow(/useActiveRoomId/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Implement**

```tsx
// src/app/routes/activeRoom.ts
import { createContext, useContext, createElement, type ReactNode } from 'react';

const Ctx = createContext<string | null>(null);

export function ActiveRoomProvider({ roomId, children }: { roomId: string; children: ReactNode }) {
  return createElement(Ctx.Provider, { value: roomId }, children);
}

export function useActiveRoomId(): string {
  const v = useContext(Ctx);
  if (v == null) throw new Error('useActiveRoomId must be used within a room route');
  return v;
}
```

- [ ] **Step 4: Run — expect PASS** (2).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/routes/activeRoom.ts studio/frontend/src/app/routes/activeRoom.spec.tsx
git commit -m "feat(studio): useActiveRoomId context (route-derived active room)"
```

---

### Task 4: Lifecycle split — hoist app setup to run once

**Files:** Create `src/app/setupApp.ts`, `src/app/setupApp.spec.ts`, `src/app/AppContext.tsx`. Modify `src/app/workbenchSetup.ts`, `src/app/Workbench.tsx`, `src/main.tsx`.

**Why:** After routing, `Workbench` mounts per room-entry. Plugin boot + persistence registration must happen once at app mount, or each navigation re-seeds state and stacks duplicate persistence subscriptions. This task keeps the app rendering the workbench at root (still no router yet) but via `AppProvider`, so the suite stays green.

**Interfaces — Produces:** `interface IAppSetup { host: IPluginHost; paneRegistry: ReturnType<typeof createPaneRegistry>; components: Record<string, unknown>; attachDockview(api: DockviewApi): void }`; `setupApp(): IAppSetup` (module-memoized singleton); `AppProvider`, `useApp(): IAppSetup`.

- [ ] **Step 1: Failing test**

```ts
// src/app/setupApp.spec.ts
import { describe, it, expect } from 'vitest';
import { setupApp } from './setupApp';

describe('setupApp', () => {
  it('is a memoized singleton', () => {
    expect(setupApp()).toBe(setupApp());
  });
  it('exposes host, paneRegistry, components, attachDockview', () => {
    const a = setupApp();
    expect(a.host).toBeTruthy();
    expect(a.paneRegistry).toBeTruthy();
    expect(a.components).toBeTruthy();
    expect(typeof a.attachDockview).toBe('function');
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Create `setupApp.ts`** (move the body of `setupWorkbench`; import `DEFAULT_LAYOUT` from `workbenchSetup.ts`)

```ts
// src/app/setupApp.ts
import { createPaneRegistry } from '../host/paneRegistry';
import { createCommandRegistry } from '../host/commandRegistry';
import { createHost } from '../host/host';
import { createLayoutService } from '../host/layoutService';
import { boot } from '../host/boot';
import { setHost } from '../state/hostRef';
import { registerSlicePersistence } from '../state/persistSlices';
import { hydrateWorkspace, registerWorkspacePersistence } from '../state/persistWorkspace';
import { PLUGINS } from '../plugins';
import { DEFAULT_LAYOUT } from './workbenchSetup';
import type { IPlugin, IPluginHost } from '../host/types';
import type { DockviewApi } from 'dockview-react';

export interface IAppSetup {
  host: IPluginHost;
  paneRegistry: ReturnType<typeof createPaneRegistry>;
  components: Record<string, unknown>;
  attachDockview(api: DockviewApi): void;
}

let singleton: IAppSetup | null = null;

export function setupApp(): IAppSetup {
  if (singleton) return singleton;

  const paneRegistry = createPaneRegistry();
  const commandRegistry = createCommandRegistry();
  let api: DockviewApi | null = null;

  const layoutService = createLayoutService({
    paneRegistry,
    defaultLayout: (a) => DEFAULT_LAYOUT(a, paneRegistry),
  });

  const host = createHost({
    paneRegistry,
    commandRegistry,
    getApi: () => api,
    resetLayout: () => {
      layoutService.reset();
      if (api) DEFAULT_LAYOUT(api, paneRegistry);
    },
  });

  setHost(host);
  if (!import.meta.env.PROD) (window as unknown as { __host?: unknown }).__host = host;

  let extra: IPlugin[] = [];
  if (!import.meta.env.PROD && (window as unknown as { __injectPlugins?: IPlugin[] }).__injectPlugins) {
    extra = (window as unknown as { __injectPlugins?: IPlugin[] }).__injectPlugins!;
  }
  boot([...PLUGINS, ...extra], host);
  registerSlicePersistence(PLUGINS);
  hydrateWorkspace();
  registerWorkspacePersistence();

  singleton = {
    host,
    paneRegistry,
    components: paneRegistry.asComponentMap(),
    attachDockview: (a: DockviewApi) => {
      api = a;
      layoutService.attach(a);
      if (!import.meta.env.PROD) (window as unknown as { __wbApi?: unknown }).__wbApi = a;
    },
  };
  return singleton;
}
```

- [ ] **Step 4: Reduce `workbenchSetup.ts` to `DEFAULT_LAYOUT`** (retargeted to the chat room — RoomList pane is being removed in Task 9, so do NOT reference `llm-chat/rooms` here; the room workbench shows the Chat Room + Settings):

```ts
// src/app/workbenchSetup.ts
import type { DockviewApi } from 'dockview-react';

export function DEFAULT_LAYOUT(api: DockviewApi, paneRegistry: { get(id: string): { title?: string } | undefined }): void {
  const add = (id: string, ref?: { direction: 'right' | 'below'; referencePanel: string }) => {
    if (!api.getPanel(id))
      api.addPanel({
        id,
        component: id,
        title: paneRegistry.get(id)?.title ?? id,
        params: { paneId: id },
        position: ref,
      });
  };
  add('llm-chat/room');
  add('llm-chat/settings', { direction: 'right', referencePanel: 'llm-chat/room' });
}
```

> The demo panes (`demo-counter`, `demo-scratch`) drop out of the default layout here; they remain registered plugins (retiring them is separate, per the parent spec). This makes the `/room/:id` workbench chat-focused.

- [ ] **Step 5: Add `AppContext.tsx`**

```tsx
// src/app/AppContext.tsx
import { createContext, useContext, type ReactNode } from 'react';
import { setupApp, type IAppSetup } from './setupApp';

const Ctx = createContext<IAppSetup | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  return <Ctx.Provider value={setupApp()}>{children}</Ctx.Provider>;
}

export function useApp(): IAppSetup {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within <AppProvider>');
  return v;
}
```

- [ ] **Step 6: Rewire `Workbench.tsx`** — consume `useApp()`, drop `setupWorkbench`/`useMemo`, remove the `<Toaster/>` line (it moves to the app root in Task 5):

```tsx
// src/app/Workbench.tsx
import { useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { ThemeToggle } from './ThemeToggle';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';

export function Workbench() {
  const app = useApp();
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme(dockEl);

  return (
    <div data-testid="workbench" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0, padding: '0 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <h1 style={{ margin: 0, fontSize: '1rem' }}>Bloom Studio</h1>
          <AppMenubar />
        </div>
        <ThemeToggle />
      </div>
      <CommandPalette />
      <div ref={setDockEl} style={{ flex: 1, overflow: 'hidden' }}>
        <DockviewReact components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Update `main.tsx`** to wrap the workbench in `AppProvider` (router comes in Task 5). Keep `<Toaster/>` here so toasts still render:

```tsx
// src/main.tsx
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './app/AppContext';
import { Workbench } from './app/Workbench';
import { Toaster } from './components/ui/sonner';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <Toaster />
      <Workbench />
    </AppProvider>
  </StrictMode>,
);
```

- [ ] **Step 8: Run the full suite — expect PASS** (setupApp green; `boot.spec.ts`, `layoutService.spec.ts`, `registries.spec.ts`, plugin specs all still green):

Run: `npx nx test frontend`

- [ ] **Step 9: Commit**

```bash
git add studio/frontend/src/app/setupApp.ts studio/frontend/src/app/setupApp.spec.ts studio/frontend/src/app/AppContext.tsx studio/frontend/src/app/workbenchSetup.ts studio/frontend/src/app/Workbench.tsx studio/frontend/src/main.tsx
git commit -m "refactor(studio): hoist app setup to run once (lifecycle split)"
```

---

### Task 5: Router skeleton + `RequireSession` guard

**Files:** Modify root `package.json`, `src/main.tsx`. Create `src/app/routes/AppRoutes.tsx`, `src/app/routes/RequireSession.tsx`, `src/app/routes/RequireSession.spec.tsx`. Add temporary one-line placeholder components for `LoginScreen`/`RoomPicker`/`RoomRoute` (replaced in Tasks 6–8).

**Interfaces — Consumes:** `useSession` (Task 2), `AppProvider` (Task 4). **Produces:** `RequireSession` (renders `<Outlet/>` when logged in, else `<Navigate to="/login" state={{ from }} replace/>`); `AppRoutes`.

- [ ] **Step 1: Add dep** (repo root): `npm install react-router-dom` — expect v7.x in root `package.json`.

- [ ] **Step 2: Failing test**

```tsx
// src/app/routes/RequireSession.spec.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from '../../session/SessionContext';
import { saveSession } from '../../session/session';
import { RequireSession } from './RequireSession';

beforeEach(() => localStorage.clear());

function tree(initial: string) {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<div>LOGIN</div>} />
          <Route element={<RequireSession />}>
            <Route path="/" element={<div>HOME</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe('RequireSession', () => {
  it('redirects to /login when no username', () => {
    render(tree('/'));
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
  });
  it('renders the outlet when logged in', () => {
    saveSession('ada');
    render(tree('/'));
    expect(screen.getByText('HOME')).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run — expect FAIL**.

- [ ] **Step 4: Implement guard + routes + placeholders**

```tsx
// src/app/routes/RequireSession.tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';

export function RequireSession() {
  const { username } = useSession();
  const location = useLocation();
  if (!username) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }
  return <Outlet />;
}
```

```tsx
// src/app/routes/AppRoutes.tsx
import { Routes, Route, Navigate } from 'react-router-dom';
import { RequireSession } from './RequireSession';
import { LoginScreen } from './LoginScreen';
import { RoomPicker } from './RoomPicker';
import { RoomRoute } from './RoomRoute';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginScreen />} />
      <Route element={<RequireSession />}>
        <Route path="/" element={<RoomPicker />} />
        <Route path="/room/:roomId" element={<RoomRoute />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
```

Create placeholders so the module resolves (Tasks 6–8 replace these files):

```tsx
// src/app/routes/LoginScreen.tsx
export function LoginScreen() {
  return <div data-testid="login-screen">login</div>;
}
```

```tsx
// src/app/routes/RoomPicker.tsx
export function RoomPicker() {
  return <div data-testid="room-picker">picker</div>;
}
```

```tsx
// src/app/routes/RoomRoute.tsx
export function RoomRoute() {
  return <div data-testid="room-route">room</div>;
}
```

- [ ] **Step 5: Update `main.tsx`** to the provider/router tree (Toaster moves to app root):

```tsx
// src/main.tsx
import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider } from './app/AppContext';
import { SessionProvider } from './session/SessionContext';
import { AppRoutes } from './app/routes/AppRoutes';
import { Toaster } from './components/ui/sonner';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProvider>
      <SessionProvider>
        <Toaster />
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </SessionProvider>
    </AppProvider>
  </StrictMode>,
);
```

- [ ] **Step 6: Run — expect PASS** (RequireSession 2). Note: `e2e/smoke.spec.ts` and `e2e/llm-chat.spec.ts` will now fail (root is no longer the workbench / RoomList pane is going away) — those are fixed in Task 12; do not run e2e here.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json studio/frontend/src/main.tsx studio/frontend/src/app/routes/AppRoutes.tsx studio/frontend/src/app/routes/RequireSession.tsx studio/frontend/src/app/routes/RequireSession.spec.tsx studio/frontend/src/app/routes/LoginScreen.tsx studio/frontend/src/app/routes/RoomPicker.tsx studio/frontend/src/app/routes/RoomRoute.tsx
git commit -m "feat(studio): React Router skeleton + session guard"
```

---

### Task 6: Login screen

**Files:** Replace `src/app/routes/LoginScreen.tsx`; create `src/app/routes/LoginScreen.spec.tsx`.

**Interfaces — Consumes:** `useSession().login`; RR `useNavigate`, `useLocation`. **Produces:** `LoginScreen` — username form; submit → `login(name)` then navigate to `location.state.from ?? '/'` (`replace`).

- [ ] **Step 1: Failing test**

```tsx
// src/app/routes/LoginScreen.spec.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from '../../session/SessionContext';
import { LoginScreen } from './LoginScreen';

beforeEach(() => localStorage.clear());

function tree(initial: { pathname: string; state?: unknown }) {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/login" element={<LoginScreen />} />
          <Route path="/" element={<div>PICKER</div>} />
          <Route path="/room/:roomId" element={<div>ROOM</div>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe('LoginScreen', () => {
  it('logs in → picker by default', async () => {
    render(tree({ pathname: '/login' }));
    await userEvent.type(screen.getByLabelText(/name/i), 'ada');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('PICKER')).toBeInTheDocument();
    expect(localStorage.getItem('bloom.studio.session')).toContain('ada');
  });
  it('honors the return-url', async () => {
    render(tree({ pathname: '/login', state: { from: '/room/r-9' } }));
    await userEvent.type(screen.getByLabelText(/name/i), 'ada');
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByText('ROOM')).toBeInTheDocument();
  });
  it('does not submit empty', async () => {
    render(tree({ pathname: '/login' }));
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.queryByText('PICKER')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (placeholder has no form).

- [ ] **Step 3: Implement**

```tsx
// src/app/routes/LoginScreen.tsx
import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';

export function LoginScreen() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [name, setName] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const t = name.trim();
    if (!t) return;
    login(t);
    navigate(from, { replace: true });
  }

  return (
    <div data-testid="login-screen" style={{ display: 'grid', placeItems: 'center', height: '100vh' }}>
      <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 280 }}>
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>Bloom Studio</h1>
        <label htmlFor="username">Your name</label>
        <input id="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. ada" />
        <button type="submit">Continue</button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS** (3).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/routes/LoginScreen.tsx studio/frontend/src/app/routes/LoginScreen.spec.tsx
git commit -m "feat(studio): login screen with return-url navigation"
```

---

### Task 7: Room picker screen (replaces RoomListPane)

**Files:** Replace `src/app/routes/RoomPicker.tsx`; create `src/app/routes/RoomPicker.spec.tsx`.

**Interfaces — Consumes:** `getRooms`, `createRoom` from `../../plugins/llm-chat/restClient`; `IRoom` from `../../plugins/llm-chat/state`; `notify`; RR `useNavigate`. **Produces:** `RoomPicker` — fetches rooms on mount, lists them (click → `/room/:id`), "new room" input (create → navigate to new id), inline retry on error. Uses `restClient` directly (NOT the chat `actions`, which touch the slice/socket) so the picker stays decoupled from the active-room machinery.

- [ ] **Step 1: Failing test**

```tsx
// src/app/routes/RoomPicker.spec.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const getRooms = vi.fn();
const createRoom = vi.fn();
vi.mock('../../plugins/llm-chat/restClient', () => ({
  getRooms: () => getRooms(),
  createRoom: (n: string) => createRoom(n),
}));
vi.mock('../../lib/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));

import { RoomPicker } from './RoomPicker';

beforeEach(() => {
  getRooms.mockReset();
  createRoom.mockReset();
});

function tree() {
  return (
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<RoomPicker />} />
        <Route path="/room/:roomId" element={<div>ROOM</div>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('RoomPicker', () => {
  it('lists rooms', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'Alpha', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree());
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
  });
  it('creates + navigates', async () => {
    getRooms.mockResolvedValue([]);
    createRoom.mockResolvedValue({ id: 'r-new', name: 'Beta', model: 'm', gameId: null, createdAt: 't' });
    render(tree());
    await waitFor(() => expect(getRooms).toHaveBeenCalled());
    await userEvent.type(screen.getByPlaceholderText(/new room/i), 'Beta');
    await userEvent.click(screen.getByRole('button', { name: /create/i }));
    expect(await screen.findByText('ROOM')).toBeInTheDocument();
  });
  it('shows retry on error', async () => {
    getRooms.mockRejectedValue(new Error('down'));
    render(tree());
    expect(await screen.findByText(/couldn.t load rooms/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Implement**

```tsx
// src/app/routes/RoomPicker.tsx
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getRooms, createRoom } from '../../plugins/llm-chat/restClient';
import type { IRoom } from '../../plugins/llm-chat/state';
import { notify } from '../../lib/notify';

type Status = 'loading' | 'ready' | 'error';

export function RoomPicker() {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<IRoom[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [newName, setNewName] = useState('');

  async function load() {
    setStatus('loading');
    try {
      setRooms(await getRooms());
      setStatus('ready');
    } catch {
      setStatus('error');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      const room = await createRoom(name);
      navigate(`/room/${room.id}`);
    } catch {
      notify.error('Could not create room');
    }
  }

  return (
    <div data-testid="room-picker" style={{ maxWidth: 560, margin: '48px auto', padding: 16 }}>
      <h1 style={{ fontSize: '1.25rem' }}>Rooms</h1>
      <form onSubmit={onCreate} style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New room name…" style={{ flex: 1 }} />
        <button type="submit">Create</button>
      </form>
      {status === 'loading' && <p>Loading rooms…</p>}
      {status === 'error' && (
        <p>
          Couldn’t load rooms.{' '}
          <button type="button" onClick={() => void load()}>
            Retry
          </button>
        </p>
      )}
      {status === 'ready' && (
        <ul style={{ listStyle: 'none', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rooms.map((r) => (
            <li key={r.id}>
              <button type="button" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(`/room/${r.id}`)}>
                {r.name}
              </button>
            </li>
          ))}
          {rooms.length === 0 && <li>No rooms yet — create one above.</li>}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run — expect PASS** (3).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/routes/RoomPicker.tsx studio/frontend/src/app/routes/RoomPicker.spec.tsx
git commit -m "feat(studio): room picker screen (list + create + navigate)"
```

---

### Task 8: Room route — validate, drive `openRoom`, render workbench

**Files:** Replace `src/app/routes/RoomRoute.tsx`; create `src/app/routes/RoomRoute.spec.tsx`. Modify `src/plugins/llm-chat/actions.ts` (add `closeRoom`).

**Interfaces — Consumes:** RR `useParams`; `getRooms` (restClient); `openRoom`, `closeRoom` (actions); `notify`; `ActiveRoomProvider` (Task 3); `Workbench` (Task 4). **Produces:** `RoomRoute` — validates `:roomId` against `getRooms()`; if valid, calls `openRoom(roomId)` and renders `<Workbench/>` inside `<ActiveRoomProvider>`; on param change re-drives `openRoom`; on unmount calls `closeRoom()`; if invalid → `notify.error` + `<Navigate to="/" replace/>`. **Adds to actions:** `closeRoom(): void` — leaves the active room and clears `activeRoomId`.

- [ ] **Step 1: Add `closeRoom` to `actions.ts`** (used by RoomRoute cleanup; keeps presence correct when leaving a room for the picker). Insert after `openRoom`:

```ts
// src/plugins/llm-chat/actions.ts  (add this export)
export function closeRoom(): void {
  const s = chatSlice();
  const prev = s.activeRoomId.get();
  if (prev) sock().leaveRoom(prev);
  s.activeRoomId.set(null);
  s.messages.set([]);
  s.members.set([]);
  s.typing.set([]);
  persist();
}
```

- [ ] **Step 2: Failing test**

```tsx
// src/app/routes/RoomRoute.spec.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const getRooms = vi.fn();
const openRoom = vi.fn();
const closeRoom = vi.fn();
const error = vi.fn();
vi.mock('../../plugins/llm-chat/restClient', () => ({ getRooms: () => getRooms() }));
vi.mock('../../plugins/llm-chat/actions', () => ({ openRoom: (id: string) => openRoom(id), closeRoom: () => closeRoom() }));
vi.mock('../../lib/notify', () => ({ notify: { error: (m: string) => error(m), info: vi.fn() } }));
vi.mock('../Workbench', () => ({ Workbench: () => <div data-testid="workbench">WB</div> }));

import { RoomRoute } from './RoomRoute';
import { useActiveRoomId } from './activeRoom';

beforeEach(() => {
  getRooms.mockReset();
  openRoom.mockReset();
  closeRoom.mockReset();
  error.mockReset();
});

function Echo() {
  return <span data-testid="rid">{useActiveRoomId()}</span>;
}
function tree(initial: string) {
  return (
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<div>PICKER</div>} />
        <Route
          path="/room/:roomId"
          element={
            <RoomRoute>
              <Echo />
            </RoomRoute>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('RoomRoute', () => {
  it('valid room → workbench + openRoom + context', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/r1'));
    expect(await screen.findByTestId('workbench')).toBeInTheDocument();
    expect(openRoom).toHaveBeenCalledWith('r1');
    expect(screen.getByTestId('rid')).toHaveTextContent('r1');
  });
  it('unknown room → picker + toast', async () => {
    getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    render(tree('/room/nope'));
    expect(await screen.findByText('PICKER')).toBeInTheDocument();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i));
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (placeholder).

- [ ] **Step 4: Implement**

```tsx
// src/app/routes/RoomRoute.tsx
import { useEffect, useState, type ReactNode } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { getRooms } from '../../plugins/llm-chat/restClient';
import { openRoom, closeRoom } from '../../plugins/llm-chat/actions';
import { notify } from '../../lib/notify';
import { ActiveRoomProvider } from './activeRoom';
import { Workbench } from '../Workbench';

type Validation = 'checking' | 'valid' | 'invalid';

export function RoomRoute({ children }: { children?: ReactNode }) {
  const { roomId } = useParams<{ roomId: string }>();
  const [state, setState] = useState<Validation>('checking');

  useEffect(() => {
    let alive = true;
    setState('checking');
    getRooms()
      .then((rooms) => {
        if (!alive) return;
        if (rooms.some((r) => r.id === roomId)) {
          void openRoom(roomId!);
          setState('valid');
        } else {
          setState('invalid');
        }
      })
      .catch(() => alive && setState('invalid'));
    return () => {
      alive = false;
    };
  }, [roomId]);

  // Leave the room when the route unmounts (back to picker / different room).
  useEffect(() => () => closeRoom(), []);

  if (state === 'checking') return <div data-testid="room-loading">Opening room…</div>;
  if (state === 'invalid' || !roomId) {
    notify.error('That room no longer exists.');
    return <Navigate to="/" replace />;
  }
  return (
    <ActiveRoomProvider roomId={roomId}>
      <Workbench />
      {children}
    </ActiveRoomProvider>
  );
}
```

- [ ] **Step 5: Run — expect PASS** (RoomRoute 2). Also run `actions.spec.ts` to confirm `closeRoom` didn't break existing action tests: `npx nx test frontend -- src/plugins/llm-chat/actions.spec.ts src/app/routes/RoomRoute.spec.tsx`

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/app/routes/RoomRoute.tsx studio/frontend/src/app/routes/RoomRoute.spec.tsx studio/frontend/src/plugins/llm-chat/actions.ts
git commit -m "feat(studio): room route drives openRoom from the URL param"
```

---

### Task 9: Remove RoomListPane, retarget plugin panes/commands

**Files:** Modify `src/plugins/llm-chat/index.ts`. Delete `src/plugins/llm-chat/RoomListPane.tsx`, `src/plugins/llm-chat/RoomListPane.spec.tsx`.

**Why:** Room selection is now the `RoomPicker` _screen_ (Task 7). The `llm-chat/rooms` pane and its `Open Room List` command are dead; `DEFAULT_LAYOUT` already dropped the pane in Task 4.

**Interfaces — Produces:** `llmChat` plugin with panes `llm-chat/room`, `llm-chat/settings` and commands `open-room`, `open-settings` only.

- [ ] **Step 1: Delete the pane + its test**

```bash
git rm studio/frontend/src/plugins/llm-chat/RoomListPane.tsx studio/frontend/src/plugins/llm-chat/RoomListPane.spec.tsx
```

- [ ] **Step 2: Edit `index.ts`** — drop the RoomListPane import, its pane entry, and the `open-rooms` command:

```ts
// src/plugins/llm-chat/index.ts
import type { IPlugin } from '../../host/types';
import type { ILlmChatState } from './state';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import { initChat } from './actions';
import { ChatRoomPane } from './ChatRoomPane';
import { SettingsPane } from './SettingsPane';

export const llmChat: IPlugin<ILlmChatState> = {
  id: LLM_CHAT_PLUGIN_ID,
  title: 'LLM Chat',
  persist: false,
  initialState: makeInitialState('', null),
  panes: [
    { id: 'llm-chat/room', title: 'Chat Room', component: ChatRoomPane as never },
    { id: 'llm-chat/settings', title: 'Chat Settings', component: SettingsPane as never },
  ],
  commands: [
    { id: 'llm-chat/open-room', title: 'Open Chat Room', run: (host) => host.openPane('llm-chat/room') },
    { id: 'llm-chat/open-settings', title: 'Open Chat Settings', run: (host) => host.openPane('llm-chat/settings') },
  ],
  init: () => initChat(),
};
```

> `makeInitialState('', null)` — the empty display name is replaced by the session username when `SessionSync` connects (Task 10). `generateGuestName` import is dropped here; it is removed from `prefs.ts`/`initChat` in Task 10.

- [ ] **Step 3: Run the plugin + index suites — expect PASS** (no refs to RoomListPane remain): `npx nx test frontend -- src/plugins/llm-chat`

If `index.spec.ts` asserts the old pane/command set, update it to the new set (panes `room`, `settings`; commands `open-room`, `open-settings`) as part of this task.

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/index.ts studio/frontend/src/plugins/llm-chat/index.spec.ts
git commit -m "refactor(studio): remove RoomListPane; room selection is now the picker screen"
```

---

### Task 10: Identity reconciliation — session-driven socket, drop guest name & auto-resume

**Files:** Modify `src/plugins/llm-chat/actions.ts`, `src/plugins/llm-chat/prefs.ts`, `src/plugins/llm-chat/SettingsPane.tsx`. Create `src/app/SessionSync.tsx`, `src/app/SessionSync.spec.tsx`. Modify `src/main.tsx` (mount `<SessionSync/>`).

**Why:** Login owns identity. The socket must connect with the **session username**, not `guest-NNNN`; the app must not auto-resume a persisted `activeRoomId` (URL is the source of truth); Settings no longer edits the display name.

**Interfaces — Produces:** actions `connectChatAs(username: string): void` (sets `displayName`, connects or reconnects the socket) and `disconnectChat(): void`; `initChat()` no longer connects eagerly or auto-opens a room. `SessionSync` — a render-null component that calls `connectChatAs(username)` when `username` becomes set/changes and `disconnectChat()` when it clears.

- [ ] **Step 1: Failing test for the actions change**

Add to `src/plugins/llm-chat/actions.spec.ts` (follow the file's existing `__setDeps` mock pattern):

```ts
// append to actions.spec.ts
import { connectChatAs, disconnectChat, initChat, __setDeps } from './actions';
import { chatSlice } from './state';

describe('session-driven connection', () => {
  it('connectChatAs sets displayName and connects', () => {
    const socket = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      reconnectWith: vi.fn(),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      sendPrompt: vi.fn(),
      setTyping: vi.fn(),
    };
    __setDeps({ socket });
    connectChatAs('ada');
    expect(chatSlice().displayName.get()).toBe('ada');
    expect(socket.connect).toHaveBeenCalledWith('ada');
  });
  it('connectChatAs reconnects when already connected once', () => {
    const socket = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      reconnectWith: vi.fn(),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      sendPrompt: vi.fn(),
      setTyping: vi.fn(),
    };
    __setDeps({ socket });
    connectChatAs('ada');
    connectChatAs('bob');
    expect(socket.reconnectWith).toHaveBeenLastCalledWith('bob');
  });
  it('initChat loads rooms but does not connect or auto-open', () => {
    const socket = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      reconnectWith: vi.fn(),
      joinRoom: vi.fn(),
      leaveRoom: vi.fn(),
      sendPrompt: vi.fn(),
      setTyping: vi.fn(),
    };
    const rest = { getRooms: vi.fn().mockResolvedValue([]), createRoom: vi.fn(), getMessages: vi.fn() };
    __setDeps({ socket, rest });
    initChat();
    expect(socket.connect).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`connectChatAs`/`disconnectChat` undefined).

- [ ] **Step 3: Edit `actions.ts`** — add connect/disconnect, track whether connected, simplify `initChat`:

```ts
// actions.ts — add near the top-level module state (uses the existing initSocketClient/sock imports)
let started = false;

export function connectChatAs(username: string): void {
  chatSlice().displayName.set(username);
  if (!started) {
    initSocketClient();
    started = true;
    sock().connect(username);
  } else {
    sock().reconnectWith(username);
  }
}

export function disconnectChat(): void {
  if (started) sock().disconnect();
}
```

Replace `initChat` with a version that does NOT connect or auto-open (it just loads the room list for any in-workbench use):

```ts
export function initChat(): void {
  void loadRooms();
}
```

Remove the now-unused `loadPrefs` import. `setDisplayName` is no longer called from the UI after Step 5; verify references and remove it if unused. Keep `persist()` for `activeRoomId` only (see Step 4).

> Note: `initSocketClient`/`sock` are already imported in `actions.ts`. `getSocketClient()` throws before init, so `connectChatAs` must `initSocketClient()` on first call (the `started` flag guards this). The `__setDeps({ socket })` test path sets `socket` directly, so `sock()` returns the injected mock and `initSocketClient` is a harmless no-op against the real singleton in tests.

- [ ] **Step 4: Simplify `prefs.ts`** — drop `generateGuestName` and `displayName` (identity now lives in the session). Persist only `activeRoomId`:

```ts
// src/plugins/llm-chat/prefs.ts
import { savePersisted, loadPersisted } from '../../state/persistence';

export const PREFS_KEY = 'llm-chat.prefs';
export const PREFS_VERSION = 2; // bump: dropped displayName + guest-name default

export interface IChatPrefs {
  activeRoomId: string | null;
}

export function loadPrefs(): IChatPrefs {
  return loadPersisted<IChatPrefs>(PREFS_KEY, PREFS_VERSION, { activeRoomId: null });
}

export function savePrefs(prefs: IChatPrefs): void {
  savePersisted(PREFS_KEY, PREFS_VERSION, prefs);
}
```

Update `actions.ts` `persist()` to `savePrefs({ activeRoomId: s.activeRoomId.get() })`, and update `prefs.spec.ts` to the v2 shape (drop the `generateGuestName` test).

- [ ] **Step 5: Remove the display-name field from `SettingsPane.tsx`** — keep only the model picker:

```tsx
// src/plugins/llm-chat/SettingsPane.tsx
import { useEffect, useState } from 'react';
import { getModels, type IModelOption } from './restClient';
import { bumpRenderCount } from '../../app/renderCount';

export function SettingsPane() {
  const [models, setModels] = useState<IModelOption[]>([]);
  bumpRenderCount('SettingsPane');

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="chat-settings-pane" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
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

Update `SettingsPane.spec.tsx` to drop the display-name assertions (keep the model-picker test).

- [ ] **Step 6: Create `SessionSync.tsx`** + test

```tsx
// src/app/SessionSync.tsx
import { useEffect } from 'react';
import { useSession } from '../session/SessionContext';
import { connectChatAs, disconnectChat } from '../plugins/llm-chat/actions';

export function SessionSync() {
  const { username } = useSession();
  useEffect(() => {
    if (username) connectChatAs(username);
    else disconnectChat();
  }, [username]);
  return null;
}
```

```tsx
// src/app/SessionSync.spec.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const connectChatAs = vi.fn();
const disconnectChat = vi.fn();
vi.mock('../plugins/llm-chat/actions', () => ({ connectChatAs: (u: string) => connectChatAs(u), disconnectChat: () => disconnectChat() }));

import { SessionSync } from './SessionSync';
import { SessionProvider } from '../session/SessionContext';
import { saveSession } from '../session/session';

beforeEach(() => {
  localStorage.clear();
  connectChatAs.mockReset();
  disconnectChat.mockReset();
});

describe('SessionSync', () => {
  it('connects with the logged-in username', () => {
    saveSession('ada');
    render(
      <SessionProvider>
        <SessionSync />
      </SessionProvider>,
    );
    expect(connectChatAs).toHaveBeenCalledWith('ada');
  });
  it('disconnects when anon', () => {
    render(
      <SessionProvider>
        <SessionSync />
      </SessionProvider>,
    );
    expect(disconnectChat).toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Mount `<SessionSync/>`** in `main.tsx` inside `SessionProvider` (above the router):

```tsx
// main.tsx — add import and element
import { SessionSync } from './app/SessionSync';
// ...
<SessionProvider>
  <SessionSync />
  <Toaster />
  <BrowserRouter>
    <AppRoutes />
  </BrowserRouter>
</SessionProvider>;
```

- [ ] **Step 8: Run the chat + app suites — expect PASS**: `npx nx test frontend -- src/plugins/llm-chat src/app/SessionSync.spec.tsx`

- [ ] **Step 9: Commit**

```bash
git add studio/frontend/src/plugins/llm-chat/actions.ts studio/frontend/src/plugins/llm-chat/actions.spec.ts studio/frontend/src/plugins/llm-chat/prefs.ts studio/frontend/src/plugins/llm-chat/prefs.spec.ts studio/frontend/src/plugins/llm-chat/SettingsPane.tsx studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx studio/frontend/src/app/SessionSync.tsx studio/frontend/src/app/SessionSync.spec.tsx studio/frontend/src/main.tsx
git commit -m "feat(studio): connect chat socket with the logged-in username; drop guest name + auto-resume"
```

---

### Task 11: Switch-user / log-out affordance

**Files:** Create `src/app/SwitchUser.tsx`, `src/app/SwitchUser.spec.tsx`. Modify `src/app/Workbench.tsx` (mount it in the header).

**Interfaces — Consumes:** `useSession()`; RR `useNavigate`. **Produces:** `SwitchUser` — shows the current username + a "Switch user" button that calls `logout()` then `navigate('/login', { replace: true })`. (`disconnectChat` is already triggered by `SessionSync` when `username` clears — no need to call it here.)

- [ ] **Step 1: Failing test**

```tsx
// src/app/SwitchUser.spec.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { SessionProvider } from '../session/SessionContext';
import { saveSession } from '../session/session';
import { SwitchUser } from './SwitchUser';

beforeEach(() => localStorage.clear());

function tree() {
  return (
    <SessionProvider>
      <MemoryRouter initialEntries={['/room/r1']}>
        <Routes>
          <Route path="/room/:roomId" element={<SwitchUser />} />
          <Route path="/login" element={<div>LOGIN</div>} />
        </Routes>
      </MemoryRouter>
    </SessionProvider>
  );
}

describe('SwitchUser', () => {
  it('shows the username', () => {
    saveSession('ada');
    render(tree());
    expect(screen.getByText(/ada/)).toBeInTheDocument();
  });
  it('logs out → /login + clears storage', async () => {
    saveSession('ada');
    render(tree());
    await userEvent.click(screen.getByRole('button', { name: /switch user/i }));
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
    expect(localStorage.getItem('bloom.studio.session')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — expect FAIL**.

- [ ] **Step 3: Implement**

```tsx
// src/app/SwitchUser.tsx
import { useNavigate } from 'react-router-dom';
import { useSession } from '../session/SessionContext';

export function SwitchUser() {
  const { username, logout } = useSession();
  const navigate = useNavigate();
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: '0.85rem', opacity: 0.8 }}>{username}</span>
      <button
        type="button"
        onClick={() => {
          logout();
          navigate('/login', { replace: true });
        }}
      >
        Switch user
      </button>
    </span>
  );
}
```

- [ ] **Step 4: Mount in `Workbench.tsx`** — replace the right-side `<ThemeToggle />` with a group:

```tsx
import { SwitchUser } from './SwitchUser';
// ...in the header, replace the lone <ThemeToggle /> with:
<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
  <SwitchUser />
  <ThemeToggle />
</div>;
```

- [ ] **Step 5: Run — expect PASS** (2), then full suite: `npx nx test frontend`

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/app/SwitchUser.tsx studio/frontend/src/app/SwitchUser.spec.tsx studio/frontend/src/app/Workbench.tsx
git commit -m "feat(studio): switch-user / log-out affordance in workbench header"
```

---

### Task 12: End-to-end flow (Playwright, local-only) + reconcile existing e2e

**Files:** Create `e2e/routing.spec.ts`. Modify `e2e/smoke.spec.ts` and `e2e/llm-chat.spec.ts`.

**Why:** `smoke.spec.ts` (`goto('/')` → workbench) and `llm-chat.spec.ts` (drives via the RoomList pane) both break under routing. Reconcile them to the new flow. `routing.spec.ts` stubs `GET/POST /rooms` so the routing tests are hermetic; the chat-streaming e2e continues to run against the live backend (`llm_backend=fake`) but now navigates via login + URL.

- [ ] **Step 1: Write `routing.spec.ts`**

```ts
// e2e/routing.spec.ts
import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

const ROOM = { id: 'r1', name: 'Alpha', model: 'm', gameId: null, createdAt: 't' };

async function stubRooms(page: Page, rooms = [ROOM]) {
  await page.route('**/rooms', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ...ROOM, id: 'r-new', name: 'Beta' }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rooms) });
  });
  await page.route('**/rooms/*/messages', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
}

function loggedIn(page: Page, username = 'ada') {
  return seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
}

test('unauthenticated → /login', async ({ page }) => {
  await stubRooms(page);
  await page.goto('/');
  await expect(page.getByTestId('login-screen')).toBeVisible();
});

test('login → picker → create → workbench', async ({ page }) => {
  await stubRooms(page);
  await page.goto('/login');
  await page.getByLabel(/name/i).fill('ada');
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByPlaceholder(/new room/i).fill('Beta');
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\/r-new$/);
  await expect(page.getByTestId('workbench')).toBeVisible();
});

test('deep-link before login preserves destination', async ({ page }) => {
  await stubRooms(page);
  await page.goto('/room/r1');
  await expect(page.getByTestId('login-screen')).toBeVisible();
  await page.getByLabel(/name/i).fill('ada');
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page).toHaveURL(/\/room\/r1$/);
  await expect(page.getByTestId('workbench')).toBeVisible();
});

test('shareable link opens directly when logged in', async ({ page }) => {
  await loggedIn(page);
  await stubRooms(page);
  await page.goto('/room/r1');
  await expect(page.getByTestId('workbench')).toBeVisible();
});

test('stale link → picker', async ({ page }) => {
  await loggedIn(page);
  await stubRooms(page, []);
  await page.goto('/room/r1');
  await expect(page.getByTestId('room-picker')).toBeVisible();
});
```

- [ ] **Step 2: Update `smoke.spec.ts`** — a logged-in visit to a room shows the workbench:

```ts
// e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';
import { seedLocalStorage } from './helpers';

test('logged-in deep-link boots the workbench', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'ada' } }));
  await page.route('**/rooms', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]) }),
  );
  await page.route('**/rooms/*/messages', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('/room/r1');
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bloom Studio' })).toBeVisible();
});
```

- [ ] **Step 3: Update `llm-chat.spec.ts`** — replace any RoomList-pane navigation (`room-list-pane`, `new-room-input`, `room-open-*`) with the new flow: seed/login, create or open via the picker, land on `/room/:id`, then assert streaming via the existing `chat-*` testids inside the workbench. Read the current file and rewrite its navigation preamble; **keep its streaming/presence/resume assertions**. Runs against the live backend with `llm_backend=fake` per the subsystem-2 design.

- [ ] **Step 4: Run e2e locally**

Run: `npx playwright test --config=studio/frontend/playwright.config.ts e2e/routing.spec.ts e2e/smoke.spec.ts`
Expected: routing (5) + smoke (1) PASS.

For the live-backend chat spec, start the backend with `llm_backend=fake`, then `just e2e`. Expected: `llm-chat.spec.ts` passes via the new navigation.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/routing.spec.ts studio/frontend/e2e/smoke.spec.ts studio/frontend/e2e/llm-chat.spec.ts
git commit -m "test(studio): e2e routing flow; reconcile smoke + llm-chat specs to URL navigation"
```

---

### Task 13: Final verification & PR

- [ ] **Step 1: Full unit suite** — `npx nx test frontend` — all green.
- [ ] **Step 2: Lint/typecheck** — `npx nx lint frontend` and `tsc -p studio/frontend/tsconfig.app.json --noEmit` — clean. (Check for dead code: unused `setDisplayName`, `loadPrefs`, `generateGuestName`.)
- [ ] **Step 3: Prettier** — `npx prettier --check "studio/frontend/src/**/*.{ts,tsx}"` — clean (`--write` + re-commit if needed).
- [ ] **Step 4: Manual smoke** — `npx nx serve frontend` with the backend running: fresh browser → `/login`; name → picker; create/open → `/room/:id` workbench with the Chat Room pane; send a prompt → streamed tokens; copy URL to a new tab → opens the room; "Switch user" → `/login`.
- [ ] **Step 5: PR**

```bash
git push -u origin feat/llm-chat-routing
gh pr create --fill
gh pr merge --squash --delete-branch
```

---

## Self-Review

**Spec coverage** (against the design doc, incl. the 2026-06-20 update note):

- §3 two-shell route table; `main.tsx` renders router → Tasks 5–8. Vite SPA fallback is the dev-server default (`appType:'spa'`); no config change. ✓
- §4 login = identity capture, persisted, supersedes `guest-NNNN`, switch-user; Settings drops display-name → Tasks 1,2,6,10,11. ✓
- §5 picker replaces RoomList pane → Tasks 7 (screen) + 9 (delete pane). ✓
- §6 URL is source of truth; `useActiveRoomId`; shared layout → Tasks 3,8 (RoomRoute drives `openRoom`); layout single-key persistence untouched, default retargeted to the chat room (Task 4). The reconciliation (slice mirror vs literal "no slice field") is documented in the spec update note. ✓
- §7 guards: deep-link+return-url, unknown room→picker+toast, bare `/`→picker → Tasks 5,6,8. ✓
- §8 lifecycle once app-level; socket connects post-login with the session username → Tasks 4 (boot once) + 10 (`SessionSync`/`connectChatAs`). ✓
- §10 notify seam → already merged; reused (no task needed). ✓
- §11 deps: `react-router-dom` (Task 5); `sonner`/`socket.io-client` already present. ✓

**Reuse check (no recreation):** picker + room route consume the merged `restClient`/`actions`/`state`; `notify`/`Toaster` reused; `IRoom` imported from `llm-chat/state` (single definition). ✓

**Placeholder scan:** Task 5 placeholders are explicit and replaced by Tasks 6–8. No TBD/TODO. ✓

**Type consistency:** `useSession()` shape, `IAppSetup`, `useActiveRoomId(): string`, `connectChatAs/disconnectChat/closeRoom` signatures consistent across the tasks that define and consume them. Session key `bloom.studio.session` consistent. ✓

**Cross-task risks flagged for the reviewer:**

- Task 10 bumps `PREFS_KEY` version to 2 and changes the prefs shape — old persisted prefs fall back cleanly (`loadPersisted` returns the fallback on version mismatch). Confirm `actions.spec.ts`/`prefs.spec.ts` are updated in the same task.
- `setDisplayName` may become dead after Task 10 — verify references before deleting.
- `llm-chat.spec.ts` (live-backend) rewrite in Task 12 Step 3 requires reading the current file; preserve its streaming assertions, change only the navigation preamble.

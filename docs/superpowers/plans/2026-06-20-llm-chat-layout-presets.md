# LLM Chat Layout Presets (Plan B subsystem 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shell-level capability to save, apply, list, and delete named Dockview arrangements — with built-in presets — surfaced through a new "Layout" menu and the command palette.

**Architecture:** A standalone `layoutPresets` service under `host/` persists user arrangements to a versioned localStorage key and resolves code-defined built-in builders; it reuses the existing `panelIdsFromLayout` validate-or-refuse guard. It is wired in `setupApp` and exposed via a dedicated module ref (kept **off** `IPluginHost` so plugins can't consume it). The "Layout" menu and a `SaveLayoutDialog` are the chrome; two static shell commands put Save/Reset in the palette.

**Tech Stack:** TypeScript, React, hookstate (unused here), dockview-react, Radix (shadcn) `menubar`/`dialog`, Vitest (unit, CI), Playwright (browser e2e, local-only).

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IPlugin`, `IPaneDef`) — repo coding standard. All new interfaces follow this.
- **TDD is mandatory** — failing test first, watch it fail, minimal code to pass, refactor.
- **Conventional Commits** for every commit (`feat:`, `test:`, `refactor:`, `docs:`).
- **Persistence envelope:** use `savePersisted`/`loadPersisted` from `src/state/persistence.ts` (prefix `bloom.studio.`, `{ version, data }` envelope). Presets key = `layoutPresets`, version = `1` → stored under `bloom.studio.layoutPresets`.
- **Keep presets OUT of the `IPlugin` contract** — no changes to `IPlugin`/`IPluginHost` types; exposure is via a dedicated module ref, mirroring `state/hostRef.ts`.
- **Reuse the existing guard:** `panelIdsFromLayout` is already exported from `src/host/layoutService.ts` — import it, do not re-implement.
- **`notify` seam:** error toasts go through `src/lib/notify.ts` (never `sonner` directly). The service takes `notify` as an injected dependency for testability.
- **Test runner (unit):** from `studio/frontend`, `npx vitest run <relative-path>` (per `studio/frontend/project.json` → cwd `studio/frontend`).
- **Test runner (e2e):** `npx playwright test --config=studio/frontend/playwright.config.ts <filter>` (a.k.a. `just e2e`). Browser e2e is **local-only, not CI**.
- **Available llm-chat panes:** `llm-chat/room` (title "Chat Room", testid `chat-room-pane`) and `llm-chat/settings` (title "Chat Settings", testid `chat-settings-pane`). There is **no** Room List pane (it is a route). Built-in presets reference only these ids.

---

### Task 1: `layoutPresets` service

**Files:**

- Create: `studio/frontend/src/host/layoutPresets.ts`
- Test: `studio/frontend/src/host/layoutPresets.spec.ts`

**Interfaces:**

- Consumes: `panelIdsFromLayout` from `./layoutService`; `savePersisted`, `loadPersisted` from `../state/persistence`.
- Produces:

  ```ts
  export interface ILayoutPresetInfo {
    name: string;
    kind: 'builtin' | 'user';
  }
  export interface IPaneRegistryLike {
    get(id: string): unknown | undefined;
  }
  export interface ILayoutBuilder {
    (api: any, paneRegistry: IPaneRegistryLike): void;
  }
  export interface ILayoutPresetsDeps {
    getApi: () => any | null;
    paneRegistry: IPaneRegistryLike;
    builtins: Record<string, ILayoutBuilder>;
    notify: { error(msg: string): void };
  }
  export interface ILayoutPresetsService {
    saveAs(name: string): boolean;
    apply(name: string): boolean;
    list(): ILayoutPresetInfo[];
    delete(name: string): void;
  }
  export function createLayoutPresetsService(deps: ILayoutPresetsDeps): ILayoutPresetsService;
  ```

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/host/layoutPresets.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLayoutPresetsService, type ILayoutPresetsDeps } from './layoutPresets';
import { savePersisted } from '../state/persistence';

beforeEach(() => localStorage.clear());

function makeDeps(over: Partial<ILayoutPresetsDeps> = {}) {
  const api = {
    toJSON: vi.fn(() => ({ panels: { 'llm-chat/room': {} } })),
    fromJSON: vi.fn(),
    clear: vi.fn(),
  };
  const known = new Set(['llm-chat/room', 'llm-chat/settings']);
  const builtinChat = vi.fn();
  const deps: ILayoutPresetsDeps = {
    getApi: () => api,
    paneRegistry: { get: (id: string) => (known.has(id) ? { id } : undefined) },
    builtins: { Chat: builtinChat },
    notify: { error: vi.fn() },
    ...over,
  };
  return { deps, api, builtinChat };
}

describe('layoutPresets.saveAs', () => {
  it('captures api.toJSON() under the name and lists it as a user preset', () => {
    const { deps, api } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.saveAs('My view')).toBe(true);
    expect(api.toJSON).toHaveBeenCalledTimes(1);
    expect(svc.list()).toContainEqual({ name: 'My view', kind: 'user' });
  });

  it('overwrites an existing user preset of the same name', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('dup');
    expect(svc.saveAs('dup')).toBe(true);
    expect(svc.list().filter((p) => p.name === 'dup')).toHaveLength(1);
  });

  it('rejects an empty/whitespace name and notifies', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.saveAs('   ')).toBe(false);
    expect(deps.notify.error).toHaveBeenCalled();
    expect(svc.list().some((p) => p.kind === 'user')).toBe(false);
  });

  it('rejects a name colliding with a built-in and notifies', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.saveAs('Chat')).toBe(false);
    expect(deps.notify.error).toHaveBeenCalled();
  });
});

describe('layoutPresets.apply', () => {
  it('applies a built-in by clearing then running its builder', () => {
    const { deps, api, builtinChat } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.apply('Chat')).toBe(true);
    expect(api.clear).toHaveBeenCalledTimes(1);
    expect(builtinChat).toHaveBeenCalledWith(api, deps.paneRegistry);
    expect(api.fromJSON).not.toHaveBeenCalled();
  });

  it('applies a user preset via fromJSON when all panes are known', () => {
    const { deps, api } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('ok');
    expect(svc.apply('ok')).toBe(true);
    expect(api.fromJSON).toHaveBeenCalledTimes(1);
  });

  it('refuses a user preset that references an unknown pane', () => {
    savePersisted('layoutPresets', 1, { bad: { panels: { 'gone/x': {} } } });
    const { deps, api } = makeDeps();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const svc = createLayoutPresetsService(deps);
    expect(svc.apply('bad')).toBe(false);
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(deps.notify.error).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('refuses an unknown name and notifies', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.apply('nope')).toBe(false);
    expect(deps.notify.error).toHaveBeenCalled();
  });
});

describe('layoutPresets.list / delete', () => {
  it('lists built-ins first, then user presets alphabetically', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('zeta');
    svc.saveAs('alpha');
    expect(svc.list()).toEqual([
      { name: 'Chat', kind: 'builtin' },
      { name: 'alpha', kind: 'user' },
      { name: 'zeta', kind: 'user' },
    ]);
  });

  it('deletes a user preset; built-in and missing names are no-ops', () => {
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    svc.saveAs('temp');
    svc.delete('temp');
    svc.delete('Chat'); // built-in — no throw, no removal
    svc.delete('ghost'); // missing — no throw
    expect(svc.list()).toEqual([{ name: 'Chat', kind: 'builtin' }]);
  });

  it('falls back to an empty user map on a version mismatch', () => {
    savePersisted('layoutPresets', 99, { stale: {} });
    const { deps } = makeDeps();
    const svc = createLayoutPresetsService(deps);
    expect(svc.list().some((p) => p.kind === 'user')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/host/layoutPresets.spec.ts`
Expected: FAIL — `createLayoutPresetsService` is not defined / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/host/layoutPresets.ts`:

```ts
import { panelIdsFromLayout } from './layoutService';
import { savePersisted, loadPersisted } from '../state/persistence';

const LAYOUT_PRESETS_KEY = 'layoutPresets';
const LAYOUT_PRESETS_VERSION = 1;

export interface ILayoutPresetInfo {
  name: string;
  kind: 'builtin' | 'user';
}

export interface IPaneRegistryLike {
  get(id: string): unknown | undefined;
}

export interface ILayoutBuilder {
  (api: any, paneRegistry: IPaneRegistryLike): void;
}

export interface ILayoutPresetsDeps {
  getApi: () => any | null;
  paneRegistry: IPaneRegistryLike;
  builtins: Record<string, ILayoutBuilder>;
  notify: { error(msg: string): void };
}

export interface ILayoutPresetsService {
  saveAs(name: string): boolean;
  apply(name: string): boolean;
  list(): ILayoutPresetInfo[];
  delete(name: string): void;
}

type UserMap = Record<string, unknown>;

export function createLayoutPresetsService(deps: ILayoutPresetsDeps): ILayoutPresetsService {
  const loadUser = (): UserMap => loadPersisted<UserMap>(LAYOUT_PRESETS_KEY, LAYOUT_PRESETS_VERSION, {});
  const saveUser = (map: UserMap): void => savePersisted(LAYOUT_PRESETS_KEY, LAYOUT_PRESETS_VERSION, map);

  function saveAs(name: string): boolean {
    const trimmed = name.trim();
    if (!trimmed) {
      deps.notify.error('Enter a name for the arrangement.');
      return false;
    }
    if (deps.builtins[trimmed]) {
      deps.notify.error(`"${trimmed}" is a built-in arrangement and can't be overwritten.`);
      return false;
    }
    const api = deps.getApi();
    if (!api) return false;
    const map = loadUser();
    map[trimmed] = api.toJSON();
    saveUser(map);
    return true;
  }

  function apply(name: string): boolean {
    const api = deps.getApi();
    if (!api) return false;
    const builtin = deps.builtins[name];
    if (builtin) {
      api.clear();
      builtin(api, deps.paneRegistry);
      return true;
    }
    const layout = loadUser()[name];
    if (layout == null) {
      deps.notify.error(`No arrangement named "${name}".`);
      return false;
    }
    const unknown = panelIdsFromLayout(layout).filter((id) => !deps.paneRegistry.get(id));
    if (unknown.length > 0) {
      console.warn('[layout] refusing preset with unknown panes:', unknown);
      deps.notify.error(`Arrangement "${name}" references panes that no longer exist.`);
      return false;
    }
    api.fromJSON(layout);
    return true;
  }

  function list(): ILayoutPresetInfo[] {
    const builtins: ILayoutPresetInfo[] = Object.keys(deps.builtins).map((name) => ({ name, kind: 'builtin' }));
    const users: ILayoutPresetInfo[] = Object.keys(loadUser())
      .sort()
      .map((name) => ({ name, kind: 'user' }));
    return [...builtins, ...users];
  }

  function remove(name: string): void {
    const map = loadUser();
    if (!(name in map)) return;
    delete map[name];
    saveUser(map);
  }

  return { saveAs, apply, list, delete: remove };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/host/layoutPresets.spec.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/host/layoutPresets.ts studio/frontend/src/host/layoutPresets.spec.ts
git commit -m "feat(studio): layoutPresets service (save/apply/list/delete)"
```

---

### Task 2: Built-in presets

**Files:**

- Create: `studio/frontend/src/app/layoutPresets.builtins.ts`
- Test: `studio/frontend/src/app/layoutPresets.builtins.spec.ts`

**Interfaces:**

- Consumes: nothing from prior tasks at runtime (structurally compatible with `ILayoutBuilder` from Task 1 — `(api, paneRegistry) => void`).
- Produces: `export const LAYOUT_BUILTINS: Record<string, (api: DockviewApi, reg: IPaneRegistryLikeLocal) => void>` with keys `Chat` and `Focus`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/app/layoutPresets.builtins.spec.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { LAYOUT_BUILTINS } from './layoutPresets.builtins';

function fakeApi() {
  return {
    getPanel: vi.fn(() => undefined),
    addPanel: vi.fn(),
  };
}
const reg = { get: (id: string) => ({ title: id }) };

describe('LAYOUT_BUILTINS', () => {
  it('Chat adds Chat Room then Chat Settings to its right', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Chat(api as never, reg);
    const ids = api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(['llm-chat/room', 'llm-chat/settings']);
    const settingsCall = api.addPanel.mock.calls[1][0] as { position?: unknown };
    expect(settingsCall.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
  });

  it('Focus adds only Chat Room', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Focus(api as never, reg);
    const ids = api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(['llm-chat/room']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/layoutPresets.builtins.spec.ts`
Expected: FAIL — `layoutPresets.builtins` module not found.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/app/layoutPresets.builtins.ts`:

```ts
import type { DockviewApi } from 'dockview-react';

interface IPaneRegistryLikeLocal {
  get(id: string): { title?: string } | undefined;
}

// Mirrors the DEFAULT_LAYOUT add idiom; kept separate so Reset's default and
// the preset built-ins stay decoupled.
function addPane(api: DockviewApi, reg: IPaneRegistryLikeLocal, id: string, position?: { direction: 'right' | 'below'; referencePanel: string }): void {
  if (!api.getPanel(id)) {
    api.addPanel({ id, component: id, title: reg.get(id)?.title ?? id, params: { paneId: id }, position });
  }
}

export const LAYOUT_BUILTINS: Record<string, (api: DockviewApi, reg: IPaneRegistryLikeLocal) => void> = {
  Chat(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'llm-chat/settings', { direction: 'right', referencePanel: 'llm-chat/room' });
  },
  Focus(api, reg) {
    addPane(api, reg, 'llm-chat/room');
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/layoutPresets.builtins.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/layoutPresets.builtins.ts studio/frontend/src/app/layoutPresets.builtins.spec.ts
git commit -m "feat(studio): built-in layout presets (Chat, Focus)"
```

---

### Task 3: Shell module refs

**Files:**

- Create: `studio/frontend/src/state/layoutPresetsRef.ts`
- Create: `studio/frontend/src/state/saveLayoutDialogRef.ts`
- Test: `studio/frontend/src/state/layoutPresetsRef.spec.ts`

**Interfaces:**

- Consumes: `ILayoutPresetsService` from `../host/layoutPresets`.
- Produces:
  - `setLayoutPresets(s: ILayoutPresetsService): void`, `getLayoutPresets(): ILayoutPresetsService` (throws if unset, mirroring `hostRef`).
  - `setSaveLayoutOpener(fn: () => void): void`, `openSaveLayoutDialog(): void` (no-op if no opener registered).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/state/layoutPresetsRef.spec.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setLayoutPresets, getLayoutPresets } from './layoutPresetsRef';
import { setSaveLayoutOpener, openSaveLayoutDialog } from './saveLayoutDialogRef';
import type { ILayoutPresetsService } from '../host/layoutPresets';

const svc = { saveAs: vi.fn(), apply: vi.fn(), list: vi.fn(() => []), delete: vi.fn() } as ILayoutPresetsService;

describe('layoutPresetsRef', () => {
  it('round-trips the service', () => {
    setLayoutPresets(svc);
    expect(getLayoutPresets()).toBe(svc);
  });
});

describe('saveLayoutDialogRef', () => {
  beforeEach(() => setSaveLayoutOpener(() => {}));
  it('invokes the registered opener', () => {
    const open = vi.fn();
    setSaveLayoutOpener(open);
    openSaveLayoutDialog();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('is a no-op when no opener is registered yet', () => {
    expect(() => openSaveLayoutDialog()).not.toThrow();
  });
});
```

> Note: `getLayoutPresets()` throwing before `setLayoutPresets` is not asserted here because module state persists within the file once set; the round-trip + the `hostRef` precedent cover the contract.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/state/layoutPresetsRef.spec.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/state/layoutPresetsRef.ts`:

```ts
import type { ILayoutPresetsService } from '../host/layoutPresets';

let current: ILayoutPresetsService | null = null;

export function setLayoutPresets(s: ILayoutPresetsService): void {
  current = s;
}

export function getLayoutPresets(): ILayoutPresetsService {
  if (!current) throw new Error('Layout presets not initialised — call setLayoutPresets() during boot.');
  return current;
}
```

Create `studio/frontend/src/state/saveLayoutDialogRef.ts`:

```ts
// A tiny shell signal so the "Save arrangement…" command (registered in the host
// layer at boot) can open the Menubar-owned SaveLayoutDialog.
let opener: (() => void) | null = null;

export function setSaveLayoutOpener(fn: () => void): void {
  opener = fn;
}

export function openSaveLayoutDialog(): void {
  opener?.();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/state/layoutPresetsRef.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/state/layoutPresetsRef.ts studio/frontend/src/state/saveLayoutDialogRef.ts studio/frontend/src/state/layoutPresetsRef.spec.ts
git commit -m "feat(studio): shell refs for layout presets + save-dialog opener"
```

---

### Task 4: Wire the service + shell commands in `setupApp`

**Files:**

- Modify: `studio/frontend/src/app/setupApp.ts`
- Test: `studio/frontend/src/app/setupApp.spec.ts`

**Interfaces:**

- Consumes: `createLayoutPresetsService` (Task 1), `LAYOUT_BUILTINS` (Task 2), `setLayoutPresets` + `openSaveLayoutDialog` (Task 3), `notify` (`../lib/notify`).
- Produces: after `setupApp()`, `getLayoutPresets()` returns a service and `host.listCommands()` includes `shell/save-layout` and `shell/reset-layout`.

- [ ] **Step 1: Write the failing test**

Append to `studio/frontend/src/app/setupApp.spec.ts` (add the import at the top alongside the existing import):

```ts
import { getLayoutPresets } from '../state/layoutPresetsRef';
```

Then add inside the `describe('setupApp', ...)` block:

```ts
it('registers shell layout commands in the palette', () => {
  const ids = setupApp()
    .host.listCommands()
    .map((c) => c.id);
  expect(ids).toContain('shell/save-layout');
  expect(ids).toContain('shell/reset-layout');
});

it('exposes the layout presets service via the ref', () => {
  setupApp();
  expect(getLayoutPresets()).toBeTruthy();
  expect(
    getLayoutPresets()
      .list()
      .some((p) => p.kind === 'builtin'),
  ).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/setupApp.spec.ts`
Expected: FAIL — commands not registered / `getLayoutPresets` throws "not initialised".

- [ ] **Step 3: Write minimal implementation**

In `studio/frontend/src/app/setupApp.ts`, add imports near the existing import block:

```ts
import { createLayoutPresetsService } from '../host/layoutPresets';
import { LAYOUT_BUILTINS } from './layoutPresets.builtins';
import { setLayoutPresets } from '../state/layoutPresetsRef';
import { openSaveLayoutDialog } from '../state/saveLayoutDialogRef';
import { notify } from '../lib/notify';
```

Then, immediately **after** the `setHost(host);` line and **before** the `let extra: IPlugin[] = [];` line, insert:

```ts
const layoutPresets = createLayoutPresetsService({
  getApi: () => api,
  paneRegistry,
  builtins: LAYOUT_BUILTINS,
  notify,
});
setLayoutPresets(layoutPresets);

host.registerCommand({ id: 'shell/save-layout', title: 'Save arrangement…', run: () => openSaveLayoutDialog() });
host.registerCommand({ id: 'shell/reset-layout', title: 'Reset layout', run: (h) => h.resetLayout() });
```

(`api` is the `let api: DockviewApi | null` already declared in `setupApp`; the `getApi` closure reads its latest value, exactly like the host's `getApi`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/setupApp.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/setupApp.ts studio/frontend/src/app/setupApp.spec.ts
git commit -m "feat(studio): wire layoutPresets service + shell layout commands"
```

---

### Task 5: `SaveLayoutDialog` component

**Files:**

- Create: `studio/frontend/src/app/SaveLayoutDialog.tsx`
- Test: `studio/frontend/src/app/SaveLayoutDialog.spec.tsx`

**Interfaces:**

- Consumes: `getLayoutPresets` (Task 3) — calls `.saveAs(name)`; shadcn `Dialog`/`DialogContent` (`@/components/ui/dialog`), `Button` (`@/components/ui/button`).
- Produces: `export interface ISaveLayoutDialogProps { open: boolean; onOpenChange(open: boolean): void; }` and `export function SaveLayoutDialog(props: ISaveLayoutDialogProps): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/app/SaveLayoutDialog.spec.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const saveAs = vi.fn();
vi.mock('../state/layoutPresetsRef', () => ({
  getLayoutPresets: () => ({ saveAs, apply: vi.fn(), list: () => [], delete: vi.fn() }),
}));

import { SaveLayoutDialog } from './SaveLayoutDialog';

describe('SaveLayoutDialog', () => {
  beforeEach(() => saveAs.mockReset());

  it('calls saveAs with the typed name and closes on success', () => {
    saveAs.mockReturnValue(true);
    const onOpenChange = vi.fn();
    render(<SaveLayoutDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByTestId('save-layout-name'), { target: { value: 'My view' } });
    fireEvent.click(screen.getByTestId('save-layout-confirm'));
    expect(saveAs).toHaveBeenCalledWith('My view');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open when saveAs is rejected', () => {
    saveAs.mockReturnValue(false);
    const onOpenChange = vi.fn();
    render(<SaveLayoutDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByTestId('save-layout-name'), { target: { value: 'Chat' } });
    fireEvent.click(screen.getByTestId('save-layout-confirm'));
    expect(saveAs).toHaveBeenCalledWith('Chat');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/SaveLayoutDialog.spec.tsx`
Expected: FAIL — `SaveLayoutDialog` module not found.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/app/SaveLayoutDialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { getLayoutPresets } from '../state/layoutPresetsRef';

export interface ISaveLayoutDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
}

export function SaveLayoutDialog({ open, onOpenChange }: ISaveLayoutDialogProps) {
  const [name, setName] = useState('');
  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const submit = () => {
    if (getLayoutPresets().saveAs(name)) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>Save arrangement</h2>
        <input
          data-testid="save-layout-name"
          autoFocus
          value={name}
          placeholder="Arrangement name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button data-testid="save-layout-cancel" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button data-testid="save-layout-confirm" onClick={submit}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/SaveLayoutDialog.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/SaveLayoutDialog.tsx studio/frontend/src/app/SaveLayoutDialog.spec.tsx
git commit -m "feat(studio): SaveLayoutDialog name prompt"
```

---

### Task 6: "Layout" menu in `Menubar` (+ fix the existing layout e2e)

**Files:**

- Modify: `studio/frontend/src/app/Menubar.tsx`
- Modify: `studio/frontend/e2e/layout.spec.ts:34` (the `menu-file` click → `menu-layout`)
- Test: `studio/frontend/src/app/Menubar.spec.tsx`

**Interfaces:**

- Consumes: `getHost` (`../state/hostRef`), `getLayoutPresets` (Task 3), `setSaveLayoutOpener` (Task 3), `SaveLayoutDialog` (Task 5), shadcn `menubar` parts.
- Produces: `AppMenubar` renders a **Layout** menu (`menu-layout`) containing `layout-save`, one `layout-apply-<name>` per preset, one `layout-delete-<name>` per user preset, and `menu-reset-layout`. The **File** menu is removed.

> **UX note (deviation from spec §6):** Delete is rendered as flat `Delete: <name>` items rather than a `▸` submenu, because the shadcn `menubar` exports `MenubarSub` but not `MenubarSubTrigger`/`MenubarSubContent`. Functionally identical; avoids adding scaffolding. The `menu-reset-layout` testid is preserved (now under Layout) so existing references keep working.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/app/Menubar.spec.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const resetLayout = vi.fn();
const apply = vi.fn();
const del = vi.fn();
vi.mock('../state/hostRef', () => ({
  getHost: () => ({ listPanes: () => [], openPane: vi.fn(), resetLayout }),
}));
vi.mock('../state/layoutPresetsRef', () => ({
  getLayoutPresets: () => ({
    list: () => [
      { name: 'Chat', kind: 'builtin' },
      { name: 'My view', kind: 'user' },
    ],
    apply,
    delete: del,
    saveAs: vi.fn(),
  }),
}));

import { AppMenubar } from './Menubar';

describe('AppMenubar — Layout menu', () => {
  beforeEach(() => {
    resetLayout.mockReset();
    apply.mockReset();
    del.mockReset();
  });

  it('applies a preset, deletes a user preset, and resets — and has no File menu', async () => {
    const user = userEvent.setup();
    render(<AppMenubar />);
    expect(screen.queryByTestId('menu-file')).toBeNull();

    await user.click(screen.getByTestId('menu-layout'));
    await user.click(screen.getByTestId('layout-apply-Chat'));
    expect(apply).toHaveBeenCalledWith('Chat');

    await user.click(screen.getByTestId('menu-layout'));
    await user.click(screen.getByTestId('layout-delete-My view'));
    expect(del).toHaveBeenCalledWith('My view');

    await user.click(screen.getByTestId('menu-layout'));
    await user.click(screen.getByTestId('menu-reset-layout'));
    expect(resetLayout).toHaveBeenCalledTimes(1);
  });

  it('shows no delete item for a built-in preset', async () => {
    const user = userEvent.setup();
    render(<AppMenubar />);
    await user.click(screen.getByTestId('menu-layout'));
    expect(screen.queryByTestId('layout-delete-Chat')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/Menubar.spec.tsx`
Expected: FAIL — no `menu-layout` trigger / `layout-apply-Chat` item.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `studio/frontend/src/app/Menubar.tsx` with:

```tsx
import { useEffect, useState } from 'react';
import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator } from '@/components/ui/menubar';
import { getHost } from '../state/hostRef';
import { getLayoutPresets } from '../state/layoutPresetsRef';
import { setSaveLayoutOpener } from '../state/saveLayoutDialogRef';
import { SaveLayoutDialog } from './SaveLayoutDialog';

export function AppMenubar() {
  const host = getHost();
  const presets = getLayoutPresets();
  const [saveOpen, setSaveOpen] = useState(false);

  useEffect(() => {
    setSaveLayoutOpener(() => setSaveOpen(true));
  }, []);

  const all = presets.list();
  const userPresets = all.filter((p) => p.kind === 'user');

  return (
    <>
      <Menubar>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-layout">Layout</MenubarTrigger>
          <MenubarContent>
            <MenubarItem data-testid="layout-save" onClick={() => setSaveOpen(true)}>
              Save arrangement…
            </MenubarItem>
            <MenubarSeparator />
            {all.map((p) => (
              <MenubarItem key={`apply-${p.name}`} data-testid={`layout-apply-${p.name}`} onClick={() => presets.apply(p.name)}>
                {p.name}
                {p.kind === 'builtin' ? '  (built-in)' : ''}
              </MenubarItem>
            ))}
            {userPresets.length > 0 && <MenubarSeparator />}
            {userPresets.map((p) => (
              <MenubarItem key={`delete-${p.name}`} data-testid={`layout-delete-${p.name}`} onClick={() => presets.delete(p.name)}>
                Delete: {p.name}
              </MenubarItem>
            ))}
            <MenubarSeparator />
            <MenubarItem data-testid="menu-reset-layout" onClick={() => host.resetLayout()}>
              Reset layout
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger data-testid="menu-view">View</MenubarTrigger>
          <MenubarContent>
            {host.listPanes().map((p) => (
              <MenubarItem key={p.id} data-testid={`view-open-${p.id}`} onClick={() => host.openPane(p.id)}>
                {p.title}
              </MenubarItem>
            ))}
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <SaveLayoutDialog open={saveOpen} onOpenChange={setSaveOpen} />
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/Menubar.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Update the existing layout e2e to open the Layout menu**

In `studio/frontend/e2e/layout.spec.ts`, change line 34 from:

```ts
await page.getByTestId('menu-file').click();
```

to:

```ts
await page.getByTestId('menu-layout').click();
```

(The next line, `menu-reset-layout`, is unchanged — Reset now lives under Layout.)

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/app/Menubar.tsx studio/frontend/src/app/Menubar.spec.tsx studio/frontend/e2e/layout.spec.ts
git commit -m "feat(studio): Layout menu (save/apply/delete/reset)"
```

---

### Task 7: Browser e2e — save, apply, delete (local-only)

**Files:**

- Create: `studio/frontend/e2e/layout-presets.spec.ts`

**Interfaces:**

- Consumes: `gotoWorkbench` from `./helpers` (hermetic — stubs `/rooms` and messages; no backend needed); testids `menu-layout`, `layout-save`, `save-layout-name`, `save-layout-confirm`, `layout-apply-<name>`, `layout-delete-<name>`, `menu-reset-layout`; pane testids `chat-room-pane`, `chat-settings-pane`; `window.__wbApi` (exposed in dev by `setupApp.attachDockview`).

- [ ] **Step 1: Write the e2e test**

Create `studio/frontend/e2e/layout-presets.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('apply the Focus built-in shows only the Chat Room pane', async ({ page }) => {
  await gotoWorkbench(page);
  await expect(page.getByTestId('chat-settings-pane')).toBeVisible();

  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-Focus').click();

  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('chat-settings-pane')).toHaveCount(0);
});

test('save the current arrangement, change it, then re-apply restores it', async ({ page }) => {
  await gotoWorkbench(page);
  // Default = Chat Room + Chat Settings. Save it as "both".
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-save').click();
  await page.getByTestId('save-layout-name').fill('both');
  await page.getByTestId('save-layout-confirm').click();

  // Mutate: close Chat Settings.
  await page.evaluate(() => (window as any).__wbApi?.getPanel('llm-chat/settings')?.api.close());
  await page.getByTestId('chat-settings-pane').waitFor({ state: 'detached' });

  // Re-apply "both" → Chat Settings returns.
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-both').click();
  await expect(page.getByTestId('chat-settings-pane')).toBeVisible();
});

test('delete a user preset removes it from the Layout menu', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-save').click();
  await page.getByTestId('save-layout-name').fill('temp');
  await page.getByTestId('save-layout-confirm').click();

  // It now appears as an apply item.
  await page.getByTestId('menu-layout').click();
  await expect(page.getByTestId('layout-apply-temp')).toBeVisible();

  // Delete it.
  await page.getByTestId('layout-delete-temp').click();

  // Re-open the menu: the apply item is gone.
  await page.getByTestId('menu-layout').click();
  await expect(page.getByTestId('layout-apply-temp')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the e2e suite (local only — not CI)**

Run: `npx playwright test --config=studio/frontend/playwright.config.ts layout-presets`
Expected: PASS — 3 tests green. (Playwright auto-starts the frontend dev server per `playwright.config.ts`; no backend required since `gotoWorkbench` stubs REST.)

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/e2e/layout-presets.spec.ts
git commit -m "test(studio): browser e2e for layout presets (save/apply/delete)"
```

---

## Final verification

- [ ] Run the full frontend unit suite: `cd studio/frontend && npx vitest run` — all green (no regressions in `layoutService`, `setupApp`, etc.).
- [ ] Run the layout + chrome e2e to confirm the menu move didn't break them: `npx playwright test --config=studio/frontend/playwright.config.ts layout chrome` — green.
- [ ] Confirm the prettier gate passes if one runs in this repo (format the new/changed files before the final commit if needed).

---

## Notes for the implementer

- **`api.clear()`** is used to fully replace the layout before running a built-in builder. If the installed `dockview-react` version lacks `clear()` on the api, fall back to closing each existing panel (`api.panels.forEach((p) => p.api.close())`) before building — but `clear()` is the expected method; only deviate if a test proves it's missing.
- **Singleton `setupApp`:** the `setupApp` tests share one memoized instance per Vitest file; assert presence of commands/service, not re-initialization.
- **Radix menus in jsdom:** `userEvent.click` on the `menu-layout` trigger opens the portalled content so the items become queryable (the existing pattern). If an item isn't found, ensure the menu was re-opened (Radix closes on item select).
- **No `IPlugin`/`IPluginHost` changes** — verify the diff touches none of `host/types.ts`.
  </content>

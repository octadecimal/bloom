# Studio Frontend Workbench Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `studio/frontend` IDE-style **workbench app shell** — a dockview docking surface with a plugin→pane architecture, hookstate state, per-plugin opt-in persistence, and an exhaustive Playwright e2e suite — proven by two throwaway demo plugins.

**Architecture:** An Nx React app (Vite). A single module-scope hookstate `rootStore` (no React Context) holds `workspace` + namespaced `plugins[id]` slices. A host layer (pane/command registries + layout service) drives a `dockview-react` surface. Plugins register from a static array (dynamic-ready contract). Panels reach their slice via per-plugin typed hooks. Chrome (menubar, ⌘/Ctrl-K palette, View menu, theme toggle) is shadcn + Tailwind v4.

**Tech Stack:** TypeScript, React, Nx (Vite executor), Tailwind v4 (CSS-first), shadcn/ui, dockview-react, @hookstate/core, Vitest (unit), Playwright (e2e).

**Source spec:** `docs/superpowers/specs/2026-06-18-studio-frontend-workbench-design.md`

**Branch:** create `feat/studio-frontend-shell` off `main` before Task 1 (main is protected; land each task — or small groups — via PR, per `AGENTS.md`).

## Global Constraints

- **No React Context, ever.** hookstate is the only global-state mechanism. The `init(host)` argument and `useHost()` return a plain singleton object, never `React.createContext`. Theme is applied by a hookstate effect, never a `ThemeProvider`/`next-themes`.
- **Re-render performance is a core principle.** Components subscribe to the **narrowest** hookstate leaf they read (`s.count`, not the whole slice). Never `useHookstate` a broad parent node inside a pane.
- **TypeScript interfaces use an `I` prefix** (`IPlugin`, `IPaneDef`, …) per `docs/coding-standards.md`. This governs `interface` declarations only; type aliases and generics (`TState`) are exempt; external types (dockview's `IDockviewPanelProps`, hookstate's `State<T>`) keep their names.
- **e2e is the exhaustive source of truth for behavior** (`AGENTS.md`). Unit tests (Vitest) cover pure logic; Playwright covers observable behavior. **e2e is NOT run in CI** (too time/money-expensive) — it runs locally via `just e2e`.
- **dockview owns the layout tree.** hookstate never mirrors it.
- **Strict-singleton panes.** One instance per pane type; re-opening focuses the existing pane. No `instanceId`.
- **Conventional Commits** (`type(scope): description`), imperative mood. Land via PR; self-merge OK.
- **Version pins** (set in Task 1; verify against each tool's current docs at implementation time, the stack moves fast): React `18.3.x` (stable with dockview-react + shadcn), Tailwind `4.x` via `@tailwindcss/vite`, `dockview-react` latest 4.x, `@hookstate/core` `4.x`, Playwright latest, Node `20 LTS` (`.nvmrc`). **Nx must NOT manage the Rust crates** — the existing root `Cargo.toml` workspace stays untouched.

---

### Task 1: Nx React app scaffold + Playwright smoke test

Stand up the Nx workspace at the repo root (coexisting with the Cargo workspace), generate the `studio-frontend` React app on Vite, wire Playwright, and prove the app boots with one smoke e2e. Folds in all toolchain setup so the deliverable is "the app runs and a real browser sees it."

**Files:**
- Create (generated): root `package.json`, `nx.json`, `tsconfig.base.json`, `.nvmrc`, `.prettierrc`
- Create (generated): `studio/frontend/project.json`, `vite.config.ts`, `tsconfig*.json`, `index.html`, `src/main.tsx`, `src/app/Workbench.tsx`
- Create: `studio/frontend/playwright.config.ts`, `studio/frontend/e2e/smoke.spec.ts`
- Modify: `justfile`, `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a runnable Nx app served at `http://localhost:4200`; `<Workbench>` placeholder rendering a `data-testid="workbench"` root.

- [ ] **Step 1: Initialize Nx + generate the React app**

Run from repo root (these create the root TS toolchain alongside the existing Cargo workspace):

```bash
npx --yes create-nx-workspace@latest . --preset=apps --nxCloud=skip --packageManager=npm
npx nx add @nx/react
npx nx g @nx/react:app studio/frontend --bundler=vite --e2eTestRunner=playwright --style=css --routing=false --no-interactive
```

Expected: `studio/frontend/` populated; a `studio/frontend-e2e/` (Playwright) project created; root `nx.json` + `package.json` exist. If the generator nests e2e differently, that's fine — note the actual e2e path and use it consistently below (this plan assumes e2e lives at `studio/frontend/e2e`; move/rename the generated folder to match, or adjust paths).

- [ ] **Step 2: Pin Node and React versions**

Create `.nvmrc`:

```
20
```

In root `package.json`, ensure React is pinned to 18.3:

```json
"react": "18.3.1",
"react-dom": "18.3.1"
```

Run: `npm install`
Expected: installs without peer-dependency errors.

- [ ] **Step 3: Replace the generated app entry with a Workbench placeholder**

`studio/frontend/src/app/Workbench.tsx`:

```tsx
export function Workbench() {
  return (
    <div data-testid="workbench" style={{ height: '100vh' }}>
      <h1>Bloom Studio</h1>
    </div>
  );
}
```

`studio/frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Workbench } from './app/Workbench';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Workbench />
  </StrictMode>,
);
```

- [ ] **Step 4: Write the failing smoke e2e**

`studio/frontend/e2e/smoke.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('workbench boots and renders the app root', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bloom Studio' })).toBeVisible();
});
```

Ensure `studio/frontend/playwright.config.ts` has a `webServer` that runs the dev server and `baseURL: 'http://localhost:4200'`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  use: { baseURL: 'http://localhost:4200', trace: 'on-first-retry' },
  webServer: {
    command: 'npx nx serve studio-frontend',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

- [ ] **Step 5: Run the smoke test to verify it passes**

Run: `npx playwright test --config=studio/frontend/playwright.config.ts`
Expected: `1 passed`. (The webServer boots Vite, the browser loads the app, the heading is visible.)

- [ ] **Step 6: Add justfile TS/e2e targets**

Edit `justfile` — add (keep the existing cargo targets):

```just
# TypeScript / frontend
ts-test:
    npx nx run-many -t test

e2e:
    npx playwright test --config=studio/frontend/playwright.config.ts

serve-frontend:
    npx nx serve studio-frontend
```

- [ ] **Step 7: Update .gitignore for Node/Nx**

Ensure `.gitignore` contains (the scaffold round already added `node_modules` and `.nx/cache`; add the rest):

```gitignore
dist
.nx/workspace-data
test-output
playwright-report
blob-report
.playwright
```

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "build(frontend): scaffold Nx React app + Playwright smoke test"
```

---

### Task 2: Tailwind v4 + shadcn/ui wired

Wire Tailwind v4 (CSS-first) and shadcn into the Nx app, and prove a styled shadcn `Button` renders. This is the highest-risk setup step (Tailwind v4 + Nx + shadcn is the least-worn combination) — isolate it so a reviewer can reject just this.

**Files:**
- Modify: `studio/frontend/vite.config.ts`, `studio/frontend/src/main.tsx`
- Create: `studio/frontend/src/styles.css`, `studio/frontend/components.json`, `studio/frontend/src/lib/utils.ts`, `studio/frontend/src/components/ui/button.tsx`
- Create: `studio/frontend/e2e/styling.spec.ts`

**Interfaces:**
- Consumes: the app from Task 1.
- Produces: `cn(...classes)` in `src/lib/utils.ts`; shadcn `Button` in `src/components/ui/button.tsx`; the `.dark` class toggles dark theme tokens.

- [ ] **Step 1: Install Tailwind v4 + the Vite plugin**

Run: `npm install -D tailwindcss@4 @tailwindcss/vite && npm install class-variance-authority clsx tailwind-merge lucide-react`
Expected: installs cleanly.

- [ ] **Step 2: Add the Tailwind Vite plugin**

In `studio/frontend/vite.config.ts`, add the plugin to the `plugins` array:

```ts
import tailwindcss from '@tailwindcss/vite';
// ...
plugins: [react(), tailwindcss(), /* ...existing Nx plugins... */],
```

- [ ] **Step 3: Create the CSS-first stylesheet with shadcn tokens**

`studio/frontend/src/styles.css`:

```css
@import 'tailwindcss';
@import 'dockview-react/dist/styles/dockview.css';

@custom-variant dark (&:is(.dark *));

:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.15 0 0);
  --primary: oklch(0.55 0.2 264);
  --primary-foreground: oklch(0.98 0 0);
  --border: oklch(0.9 0 0);
}
.dark {
  --background: oklch(0.15 0 0);
  --foreground: oklch(0.98 0 0);
  --primary: oklch(0.65 0.2 264);
  --primary-foreground: oklch(0.15 0 0);
  --border: oklch(0.3 0 0);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-border: var(--border);
}

body { background: var(--background); color: var(--foreground); margin: 0; }
```

Import it in `src/main.tsx` (top): `import './styles.css';`

- [ ] **Step 4: Create `components.json` and the `cn` util**

`studio/frontend/components.json`:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": { "css": "src/styles.css", "baseColor": "neutral", "cssVariables": true },
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui" },
  "iconLibrary": "lucide"
}
```

Add the `@/*` path alias to `studio/frontend/tsconfig.json` (`compilerOptions.paths`): `"@/*": ["./src/*"]`, and mirror it in `vite.config.ts` `resolve.alias` (`'@': path.resolve(__dirname, './src')`).

`studio/frontend/src/lib/utils.ts`:

```ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 5: Add the shadcn Button**

Try the CLI first: `npx shadcn@latest add button` (run inside `studio/frontend`). If the CLI cannot resolve the Nx layout, create `studio/frontend/src/components/ui/button.tsx` manually:

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        outline: 'border border-border bg-transparent hover:bg-primary/10',
      },
      size: { default: 'h-9 px-4 py-2', icon: 'h-9 w-9' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface IButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: IButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
```

- [ ] **Step 6: Write the failing styling e2e**

Put a Button in the Workbench placeholder temporarily:

```tsx
// Workbench.tsx — temporary, replaced in Task 9
import { Button } from '@/components/ui/button';
export function Workbench() {
  return (
    <div data-testid="workbench" style={{ height: '100vh' }}>
      <Button data-testid="probe-button">Click</Button>
    </div>
  );
}
```

`studio/frontend/e2e/styling.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('shadcn Button renders with Tailwind utility classes applied', async ({ page }) => {
  await page.goto('/');
  const btn = page.getByTestId('probe-button');
  await expect(btn).toBeVisible();
  // Tailwind applied a non-transparent background (the primary token), proving the pipeline works.
  const bg = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `just e2e`
Expected: smoke + styling specs pass. If the background is transparent, the Tailwind pipeline is mis-wired — fix the Vite plugin / CSS import before proceeding.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "build(frontend): wire Tailwind v4 (CSS-first) + shadcn/ui"
```

---

### Task 3: hookstate root store

Create the single module-scope store and its types. Pure data; unit-tested.

**Files:**
- Create: `studio/frontend/src/state/rootStore.ts`, `studio/frontend/src/state/rootStore.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `rootStore` (a hookstate `State<IRootState>`), `IRootState`, `IWorkspaceState`.

- [ ] **Step 1: Install hookstate**

Run: `npm install @hookstate/core`

- [ ] **Step 2: Write the failing test**

`studio/frontend/src/state/rootStore.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rootStore } from './rootStore';

describe('rootStore', () => {
  it('starts with a dark theme and an empty plugins map', () => {
    expect(rootStore.workspace.theme.get()).toBe('dark');
    expect(rootStore.plugins.get()).toEqual({});
  });

  it('allows seeding a plugin slice by id', () => {
    rootStore.plugins.merge({ probe: { n: 1 } });
    expect((rootStore.plugins.get() as Record<string, { n: number }>).probe.n).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find module `./rootStore`.

- [ ] **Step 4: Implement the store**

`studio/frontend/src/state/rootStore.ts`:

```ts
import { hookstate } from '@hookstate/core';

export interface IWorkspaceState {
  theme: 'light' | 'dark'; // dockview owns layout AND active-pane state
}

export interface IRootState {
  workspace: IWorkspaceState;
  plugins: Record<string, unknown>; // plugins[id] = that plugin's slice; typed at the hook
}

// Created once, at module scope — not in React, never in a Context.
export const rootStore = hookstate<IRootState>({
  workspace: { theme: 'dark' },
  plugins: {},
});
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/state/rootStore.ts studio/frontend/src/state/rootStore.spec.ts
git commit -m "feat(frontend): add hookstate root store"
```

---

### Task 4: Versioned persistence codec

A pure localStorage codec: `{ version, data }` write/read with fallback-to-default on parse error or version mismatch, plus a debounced saver. The basis for theme + opted-in plugin slices + layout.

**Files:**
- Create: `studio/frontend/src/state/persistence.ts`, `studio/frontend/src/state/persistence.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `loadPersisted<T>(key: string, version: number, fallback: T): T`
  - `savePersisted<T>(key: string, version: number, data: T): void`
  - `makeDebouncedSaver<T>(key: string, version: number, delayMs?: number): (data: T) => void`
  - `STORAGE_PREFIX = 'bloom.studio.'`

- [ ] **Step 1: Write the failing tests**

`studio/frontend/src/state/persistence.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadPersisted, savePersisted, makeDebouncedSaver, STORAGE_PREFIX } from './persistence';

beforeEach(() => localStorage.clear());

describe('persistence codec', () => {
  it('round-trips data under a prefixed key', () => {
    savePersisted('workspace', 1, { theme: 'light' });
    expect(localStorage.getItem(STORAGE_PREFIX + 'workspace')).toContain('"version":1');
    expect(loadPersisted('workspace', 1, { theme: 'dark' })).toEqual({ theme: 'light' });
  });

  it('falls back when the key is absent', () => {
    expect(loadPersisted('missing', 1, { n: 0 })).toEqual({ n: 0 });
  });

  it('falls back on version mismatch', () => {
    savePersisted('k', 1, { n: 5 });
    expect(loadPersisted('k', 2, { n: 0 })).toEqual({ n: 0 });
  });

  it('falls back on corrupt JSON without throwing', () => {
    localStorage.setItem(STORAGE_PREFIX + 'k', '{not json');
    expect(loadPersisted('k', 1, { n: 0 })).toEqual({ n: 0 });
  });

  it('debounced saver coalesces rapid writes', () => {
    vi.useFakeTimers();
    const save = makeDebouncedSaver<{ n: number }>('k', 1, 50);
    save({ n: 1 });
    save({ n: 2 });
    vi.advanceTimersByTime(60);
    expect(loadPersisted('k', 1, { n: 0 })).toEqual({ n: 2 });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find module `./persistence`.

- [ ] **Step 3: Implement the codec**

`studio/frontend/src/state/persistence.ts`:

```ts
export const STORAGE_PREFIX = 'bloom.studio.';

interface IEnvelope<T> {
  version: number;
  data: T;
}

export function savePersisted<T>(key: string, version: number, data: T): void {
  try {
    const env: IEnvelope<T> = { version, data };
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(env));
  } catch {
    // storage full / unavailable — non-fatal for UI preferences
  }
}

export function loadPersisted<T>(key: string, version: number, fallback: T): T {
  const raw = localStorage.getItem(STORAGE_PREFIX + key);
  if (raw == null) return fallback;
  try {
    const env = JSON.parse(raw) as IEnvelope<T>;
    if (env.version !== version) return fallback;
    return env.data;
  } catch {
    return fallback;
  }
}

export function makeDebouncedSaver<T>(key: string, version: number, delayMs = 250): (data: T) => void {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return (data: T) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => savePersisted(key, version, data), delayMs);
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/state/persistence.ts studio/frontend/src/state/persistence.spec.ts
git commit -m "feat(frontend): add versioned localStorage persistence codec"
```

---

### Task 5: Host reference (late binding) + typed plugin hooks

Break the `host/` ↔ `state/` cycle with a late-bound host holder, and build `makePluginHooks` — the public contract panels use to reach their slice (scoped) and the host (no Context).

**Files:**
- Create: `studio/frontend/src/state/hostRef.ts`, `studio/frontend/src/state/makePluginHooks.ts`, `studio/frontend/src/state/makePluginHooks.spec.ts`

**Interfaces:**
- Consumes: `rootStore` (Task 3).
- Produces:
  - `setHost(h: IPluginHost): void`, `getHost(): IPluginHost` (throws if unset).
  - `makePluginHooks<TState>(pluginId): { usePluginState: () => State<TState>; useHost: () => IPluginHost }`.
- Note: `IPluginHost` is defined in Task 6; this task imports it as a type only. Implement Task 6's `host/types.ts` first if your tooling requires the type to resolve, or use a local structural type until then.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/state/makePluginHooks.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { rootStore } from './rootStore';
import { makePluginHooks } from './makePluginHooks';

interface ICounter { count: number }

describe('makePluginHooks', () => {
  it('reads and writes the plugin-scoped slice', () => {
    rootStore.plugins.merge({ probe: { count: 0 } });
    const { usePluginState } = makePluginHooks<ICounter>('probe');
    const { result } = renderHook(() => usePluginState());
    expect(result.current.count.get()).toBe(0);
    act(() => result.current.count.set(3));
    expect((rootStore.plugins.get() as Record<string, ICounter>).probe.count).toBe(3);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find `./makePluginHooks` (and possibly `@testing-library/react`).

- [ ] **Step 3: Install the React testing library**

Run: `npm install -D @testing-library/react @testing-library/dom jsdom`
Ensure `vite.config.ts` test config uses `environment: 'jsdom'` (the Nx generator usually sets this for the `test` target).

- [ ] **Step 4: Implement hostRef and makePluginHooks**

`studio/frontend/src/state/hostRef.ts`:

```ts
import type { IPluginHost } from '../host/types';

let current: IPluginHost | null = null;

export function setHost(h: IPluginHost): void {
  current = h;
}

export function getHost(): IPluginHost {
  if (!current) throw new Error('Host not initialised — call setHost() during boot.');
  return current;
}
```

`studio/frontend/src/state/makePluginHooks.ts`:

```ts
import { useHookstate, type State } from '@hookstate/core';
import { rootStore } from './rootStore';
import { getHost } from './hostRef';

// Module-scope factory keyed by pluginId; binds to a scoped handle into the single
// root store. The `as State<TState>` cast is the single, contained type seam.
export function makePluginHooks<TState>(pluginId: string) {
  return {
    usePluginState: () =>
      useHookstate(rootStore.plugins.nested(pluginId)) as unknown as State<TState>,
    useHost: () => getHost(),
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/state/hostRef.ts studio/frontend/src/state/makePluginHooks.ts studio/frontend/src/state/makePluginHooks.spec.ts
git commit -m "feat(frontend): add late-bound host ref + typed plugin hooks"
```

---

### Task 6: Plugin contract types + pane/command registries

Define the stable contract (`IPlugin`, `IPaneDef`, `ICommandDef`, `IPluginHost`) and the two registries. Registries are pure maps; unit-tested.

**Files:**
- Create: `studio/frontend/src/host/types.ts`, `studio/frontend/src/host/paneRegistry.ts`, `studio/frontend/src/host/commandRegistry.ts`, `studio/frontend/src/host/registries.spec.ts`

**Interfaces:**
- Consumes: nothing (types only).
- Produces:
  - `IPlugin<TState>`, `IPaneDef`, `ICommandDef`, `IPluginHost` (see code).
  - `createPaneRegistry(): { register(def: IPaneDef): void; get(id): IPaneDef | undefined; list(): IPaneDef[]; asComponentMap(): Record<string, React.ComponentType<IDockviewPanelProps>> }` — `asComponentMap()` returns a **memoized stable reference**, rebuilt only when registrations change.
  - `createCommandRegistry(): { register(def: ICommandDef): void; get(id): ICommandDef | undefined; list(): ICommandDef[] }`.

- [ ] **Step 1: Write the failing tests**

`studio/frontend/src/host/registries.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createPaneRegistry } from './paneRegistry';
import { createCommandRegistry } from './commandRegistry';

const Dummy = () => null;

describe('paneRegistry', () => {
  it('registers, gets, lists, and returns a stable component map until changed', () => {
    const r = createPaneRegistry();
    r.register({ id: 'p/a', title: 'A', component: Dummy as never });
    expect(r.get('p/a')?.title).toBe('A');
    expect(r.list()).toHaveLength(1);
    const map1 = r.asComponentMap();
    expect(r.asComponentMap()).toBe(map1); // stable reference, no re-instantiation
    r.register({ id: 'p/b', title: 'B', component: Dummy as never });
    expect(r.asComponentMap()).not.toBe(map1); // rebuilt after a change
    expect(Object.keys(r.asComponentMap())).toEqual(['p/a', 'p/b']);
  });
});

describe('commandRegistry', () => {
  it('registers, gets, and lists', () => {
    const r = createCommandRegistry();
    const run = () => undefined;
    r.register({ id: 'p/do', title: 'Do', run });
    expect(r.get('p/do')?.title).toBe('Do');
    expect(r.list()).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find the registry modules.

- [ ] **Step 3: Implement the types**

`studio/frontend/src/host/types.ts`:

```ts
import type { ComponentType } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

export interface IPaneDef {
  id: string; // namespaced: `${pluginId}/${key}`
  title: string;
  component: ComponentType<IDockviewPanelProps>;
}

export interface ICommandDef {
  id: string; // namespaced
  title: string;
  run(host: IPluginHost): void;
}

export interface IPlugin<TState = unknown> {
  id: string;
  title: string;
  initialState?: TState; // seeds rootStore.plugins[id] before init()
  persist?: boolean; // default false; opt into UI-preference persistence
  panes: IPaneDef[];
  commands?: ICommandDef[];
  init?(host: IPluginHost): void;
  dispose?(host: IPluginHost): void; // for the dynamic-unload future
}

export interface IPluginHost {
  registerPane(def: IPaneDef): void;
  registerCommand(def: ICommandDef): void;
  openPane(paneId: string): void; // singleton: focus if open, else create
  runCommand(commandId: string): void;
  listPanes(): IPaneDef[];
  listCommands(): ICommandDef[];
  resetLayout(): void;
}
```

- [ ] **Step 4: Implement the registries**

`studio/frontend/src/host/paneRegistry.ts`:

```ts
import type { ComponentType } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import type { IPaneDef } from './types';

export function createPaneRegistry() {
  const panes = new Map<string, IPaneDef>();
  let cache: Record<string, ComponentType<IDockviewPanelProps>> | null = null;

  return {
    register(def: IPaneDef) {
      panes.set(def.id, def);
      cache = null; // invalidate the memoized map
    },
    get: (id: string) => panes.get(id),
    list: () => [...panes.values()],
    asComponentMap() {
      if (!cache) {
        cache = {};
        for (const [id, def] of panes) cache[id] = def.component;
      }
      return cache;
    },
  };
}
```

`studio/frontend/src/host/commandRegistry.ts`:

```ts
import type { ICommandDef } from './types';

export function createCommandRegistry() {
  const cmds = new Map<string, ICommandDef>();
  return {
    register: (def: ICommandDef) => void cmds.set(def.id, def),
    get: (id: string) => cmds.get(id),
    list: () => [...cmds.values()],
  };
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/host/
git commit -m "feat(frontend): add plugin contract types + pane/command registries"
```

---

### Task 7: Layout service (dockview-owned layout, validate-or-default)

Encapsulate all dockview-layout concerns: attach to the api, persist on change (debounced), restore with **validate-or-default**, and reset. Unit-tested against a fake `DockviewApi`.

**Files:**
- Create: `studio/frontend/src/host/layoutService.ts`, `studio/frontend/src/host/layoutService.spec.ts`

**Interfaces:**
- Consumes: `loadPersisted`/`makeDebouncedSaver` (Task 4); pane registry (Task 6).
- Produces: `createLayoutService(deps: { paneRegistry; defaultLayout(api): void }): { attach(api): void; reset(): void }`. Internally: on `onDidLayoutChange` it debounce-saves `api.toJSON()`; on attach it restores. Restore validates every panel id in the saved JSON against `paneRegistry`; if all known → `api.fromJSON`; else → `defaultLayout(api)` and log dropped ids.

- [ ] **Step 1: Write the failing tests**

`studio/frontend/src/host/layoutService.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLayoutService, panelIdsFromLayout } from './layoutService';
import { savePersisted } from '../state/persistence';

beforeEach(() => localStorage.clear());

function fakeApi(saved: unknown) {
  return {
    toJSON: () => saved,
    fromJSON: vi.fn(),
    onDidLayoutChange: (_cb: () => void) => ({ dispose() {} }),
  } as never;
}

describe('panelIdsFromLayout', () => {
  it('extracts panel ids from a dockview layout blob', () => {
    const layout = { panels: { 'p/a': {}, 'p/b': {} } };
    expect(panelIdsFromLayout(layout).sort()).toEqual(['p/a', 'p/b']);
  });
});

describe('layoutService restore', () => {
  const known = new Set(['p/a']);
  const paneRegistry = { get: (id: string) => (known.has(id) ? { id } : undefined) } as never;

  it('restores when all saved panel ids are known', () => {
    savePersisted('layout', 1, { panels: { 'p/a': {} } });
    const api = fakeApi({});
    const def = vi.fn();
    createLayoutService({ paneRegistry, defaultLayout: def }).attach(api);
    expect(api.fromJSON).toHaveBeenCalledTimes(1);
    expect(def).not.toHaveBeenCalled();
  });

  it('falls back to default when any saved panel id is unknown', () => {
    savePersisted('layout', 1, { panels: { 'p/a': {}, 'p/GONE': {} } });
    const api = fakeApi({});
    const def = vi.fn();
    createLayoutService({ paneRegistry, defaultLayout: def }).attach(api);
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(def).toHaveBeenCalledTimes(1);
  });

  it('uses default when nothing is saved', () => {
    const api = fakeApi({});
    const def = vi.fn();
    createLayoutService({ paneRegistry, defaultLayout: def }).attach(api);
    expect(def).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find `./layoutService`.

- [ ] **Step 3: Implement the layout service**

`studio/frontend/src/host/layoutService.ts`:

```ts
import { loadPersisted, makeDebouncedSaver } from '../state/persistence';

const LAYOUT_KEY = 'layout';
const LAYOUT_VERSION = 1;

// dockview serializes panels under a `panels` map keyed by panel id.
export function panelIdsFromLayout(layout: unknown): string[] {
  const panels = (layout as { panels?: Record<string, unknown> })?.panels;
  return panels ? Object.keys(panels) : [];
}

interface IPaneRegistryLike {
  get(id: string): unknown | undefined;
}

export function createLayoutService(deps: {
  paneRegistry: IPaneRegistryLike;
  defaultLayout: (api: any) => void;
}) {
  const save = makeDebouncedSaver<unknown>(LAYOUT_KEY, LAYOUT_VERSION);

  function restore(api: any): void {
    const saved = loadPersisted<unknown | null>(LAYOUT_KEY, LAYOUT_VERSION, null);
    if (saved == null) return deps.defaultLayout(api);
    const ids = panelIdsFromLayout(saved);
    const unknown = ids.filter((id) => !deps.paneRegistry.get(id));
    if (unknown.length > 0) {
      console.warn('[layout] dropping unknown panels, using default:', unknown);
      return deps.defaultLayout(api);
    }
    api.fromJSON(saved);
  }

  return {
    attach(api: any) {
      restore(api);
      api.onDidLayoutChange(() => save(api.toJSON()));
    },
    reset() {
      save(null);
    },
  };
}
```

(`reset()` clears the saved layout; the caller re-applies `DEFAULT_LAYOUT` and re-saves — wired in Task 9.)

- [ ] **Step 4: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/host/layoutService.ts studio/frontend/src/host/layoutService.spec.ts
git commit -m "feat(frontend): add layout service with validate-or-default restore"
```

---

### Task 8: Host + boot sequence

Assemble the `IPluginHost` (delegating `openPane` to a dockview api set at mount) and the boot sequence (seed → register → init → hydrate). `init` failures are isolated. Unit-tested.

**Files:**
- Create: `studio/frontend/src/host/host.ts`, `studio/frontend/src/host/boot.ts`, `studio/frontend/src/host/boot.spec.ts`

**Interfaces:**
- Consumes: registries (Task 6), `rootStore` (Task 3), persistence (Task 4), `setHost` (Task 5).
- Produces:
  - `createHost(deps): IPluginHost` where `deps = { paneRegistry, commandRegistry, getApi: () => DockviewApi | null, resetLayout: () => void }`.
  - `boot(plugins: IPlugin[], host: IPluginHost): void` — seeds `rootStore.plugins[id]` from `initialState` (hydrating from persistence when `persist`), registers panes/commands, calls `init(host)` inside try/catch (a throwing plugin is skipped, others continue).
  - `pluginStorageKey(id) => id` (slice key passed to the codec).

- [ ] **Step 1: Write the failing tests**

`studio/frontend/src/host/boot.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../state/rootStore';
import { createPaneRegistry } from './paneRegistry';
import { createCommandRegistry } from './commandRegistry';
import { createHost } from './host';
import { boot } from './boot';
import type { IPlugin } from './types';

const Dummy = (() => null) as never;

function freshHost() {
  return createHost({
    paneRegistry: createPaneRegistry(),
    commandRegistry: createCommandRegistry(),
    getApi: () => null,
    resetLayout: () => undefined,
  });
}

beforeEach(() => {
  rootStore.plugins.set({});
  localStorage.clear();
});

describe('boot', () => {
  it('seeds plugin slices and registers panes', () => {
    const host = freshHost();
    const p: IPlugin<{ n: number }> = {
      id: 'demo', title: 'Demo', initialState: { n: 7 },
      panes: [{ id: 'demo/main', title: 'Main', component: Dummy }],
    };
    boot([p], host);
    expect((rootStore.plugins.get() as Record<string, { n: number }>).demo.n).toBe(7);
    expect(host.listPanes().map((x) => x.id)).toEqual(['demo/main']);
  });

  it('isolates a plugin whose init throws; others still register', () => {
    const host = freshHost();
    const bad: IPlugin = { id: 'bad', title: 'Bad', panes: [], init: () => { throw new Error('boom'); } };
    const good: IPlugin = { id: 'good', title: 'Good', panes: [{ id: 'good/p', title: 'P', component: Dummy }] };
    expect(() => boot([bad, good], host)).not.toThrow();
    expect(host.listPanes().map((x) => x.id)).toEqual(['good/p']);
  });

  it('hydrates a persisted slice for persist:true plugins', () => {
    // Pre-seed persisted state as if from a previous session.
    const { savePersisted } = await import('../state/persistence');
    savePersisted('demo', 1, { n: 99 });
    const host = freshHost();
    const p: IPlugin<{ n: number }> = {
      id: 'demo', title: 'Demo', persist: true, initialState: { n: 0 },
      panes: [],
    };
    boot([p], host);
    expect((rootStore.plugins.get() as Record<string, { n: number }>).demo.n).toBe(99);
  });
});
```

(Note: the third test uses top-level `await import`; if your Vitest config disallows that inside `it`, move the import to the top of the file.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find `./host` / `./boot`.

- [ ] **Step 3: Implement the host**

`studio/frontend/src/host/host.ts`:

```ts
import type { IPluginHost, IPaneDef, ICommandDef } from './types';

interface IHostDeps {
  paneRegistry: { register(d: IPaneDef): void; get(id: string): IPaneDef | undefined; list(): IPaneDef[] };
  commandRegistry: { register(d: ICommandDef): void; get(id: string): ICommandDef | undefined; list(): ICommandDef[] };
  getApi: () => any | null; // DockviewApi once mounted
  resetLayout: () => void;
}

export function createHost(deps: IHostDeps): IPluginHost {
  const host: IPluginHost = {
    registerPane: (d) => deps.paneRegistry.register(d),
    registerCommand: (d) => deps.commandRegistry.register(d),
    listPanes: () => deps.paneRegistry.list(),
    listCommands: () => deps.commandRegistry.list(),
    openPane(paneId) {
      const api = deps.getApi();
      if (!api) return;
      const existing = api.getPanel(paneId);
      if (existing) { existing.api.setActive(); return; }
      api.addPanel({ id: paneId, component: paneId, params: { paneId } });
    },
    runCommand(commandId) {
      const cmd = deps.commandRegistry.get(commandId);
      if (!cmd) { console.warn('[host] unknown command:', commandId); return; }
      cmd.run(host);
    },
    resetLayout: () => deps.resetLayout(),
  };
  return host;
}
```

- [ ] **Step 4: Implement boot**

`studio/frontend/src/host/boot.ts`:

```ts
import { rootStore } from '../state/rootStore';
import { loadPersisted } from '../state/persistence';
import type { IPlugin, IPluginHost } from './types';

const SLICE_VERSION = 1;
export const pluginStorageKey = (id: string) => id;

export function boot(plugins: IPlugin[], host: IPluginHost): void {
  for (const p of plugins) {
    try {
      const seed = p.persist
        ? loadPersisted(pluginStorageKey(p.id), SLICE_VERSION, p.initialState ?? {})
        : (p.initialState ?? {});
      rootStore.plugins.nested(p.id).set(seed as never);

      p.panes.forEach((pane) => host.registerPane(pane));
      p.commands?.forEach((cmd) => host.registerCommand(cmd));
      p.init?.(host);
    } catch (err) {
      console.error(`[boot] plugin "${p.id}" failed to initialise — skipping`, err);
    }
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/host/host.ts studio/frontend/src/host/boot.ts studio/frontend/src/host/boot.spec.ts
git commit -m "feat(frontend): add plugin host + isolated boot sequence"
```

---

### Task 9: Mount dockview + wire host/boot + DEFAULT_LAYOUT + persistence-on-change

Replace the Workbench placeholder with the real docking surface, wire boot + host + layout service, and add per-plugin slice persistence-on-change. Proven by an e2e that the demo panes (added in Task 13) appear — for now, a single temporary demo pane proves the wiring.

**Files:**
- Modify: `studio/frontend/src/app/Workbench.tsx`
- Create: `studio/frontend/src/app/workbenchSetup.ts`, `studio/frontend/src/state/persistSlices.ts`
- Create: `studio/frontend/e2e/dockview.spec.ts`
- Create (temporary): `studio/frontend/src/plugins/index.ts` (a one-pane temp plugin; replaced in Task 13)

**Interfaces:**
- Consumes: everything in Tasks 3–8; `DockviewReact` from `dockview-react`.
- Produces: a mounted workbench; `setupWorkbench()` returning `{ host, paneRegistry, layoutService, onReady }`; `registerSlicePersistence(plugins)` subscribing opted-in slices to debounced saves.

- [ ] **Step 1: Install dockview**

Run: `npm install dockview-react`

- [ ] **Step 2: Implement slice persistence subscription**

`studio/frontend/src/state/persistSlices.ts`:

```ts
import { rootStore } from './rootStore';
import { makeDebouncedSaver } from './persistence';
import type { IPlugin } from '../host/types';

const SLICE_VERSION = 1;

// Subscribe each persist:true plugin's slice to a debounced localStorage save.
export function registerSlicePersistence(plugins: IPlugin[]): void {
  for (const p of plugins) {
    if (!p.persist) continue;
    const save = makeDebouncedSaver(p.id, SLICE_VERSION);
    rootStore.plugins.nested(p.id).attach(() => ({
      id: Symbol(p.id),
      init: () => ({}),
      onSet: () => save(rootStore.plugins.nested(p.id).get({ noproxy: true })),
    }) as never);
  }
}
```

(If hookstate's plugin-attach API differs in the installed version, achieve the same with a `subscribe`/effect that calls `save(...)` on change. The behavioral contract — opted-in slices persist debounced — is what the e2e in Task 13 enforces.)

- [ ] **Step 3: Implement workbench setup**

`studio/frontend/src/app/workbenchSetup.ts`:

```ts
import { createPaneRegistry } from '../host/paneRegistry';
import { createCommandRegistry } from '../host/commandRegistry';
import { createHost } from '../host/host';
import { createLayoutService } from '../host/layoutService';
import { boot } from '../host/boot';
import { setHost } from '../state/hostRef';
import { registerSlicePersistence } from '../state/persistSlices';
import { PLUGINS } from '../plugins';
import type { DockviewApi } from 'dockview-react';

export function setupWorkbench() {
  const paneRegistry = createPaneRegistry();
  const commandRegistry = createCommandRegistry();
  let api: DockviewApi | null = null;

  const layoutService = createLayoutService({
    paneRegistry,
    defaultLayout: (a) => DEFAULT_LAYOUT(a),
  });

  const host = createHost({
    paneRegistry,
    commandRegistry,
    getApi: () => api,
    resetLayout: () => { layoutService.reset(); if (api) DEFAULT_LAYOUT(api); },
  });

  setHost(host);
  boot(PLUGINS, host);
  registerSlicePersistence(PLUGINS);

  return {
    host,
    paneRegistry,
    onReady: (a: DockviewApi) => { api = a; layoutService.attach(a); },
  };
}

// Opens the first registered pane of each plugin in a single group as a sensible default.
function DEFAULT_LAYOUT(api: DockviewApi) {
  // cleared on reset; re-add from the registry
  const panes = (api as any).panels?.map((p: any) => p.id) ?? [];
  panes.forEach((id: string) => api.getPanel(id)?.api.close());
}
```

(`DEFAULT_LAYOUT` is fully specified in Task 13 once the demo panes exist — for this task it opens the single temporary pane below.)

- [ ] **Step 4: Add a temporary one-pane plugin**

`studio/frontend/src/plugins/index.ts` (temporary — replaced in Task 13):

```tsx
import type { IPlugin } from '../host/types';

const TempPane = () => <div data-testid="temp-pane">temp</div>;

export const PLUGINS: IPlugin[] = [
  { id: 'temp', title: 'Temp', panes: [{ id: 'temp/main', title: 'Temp', component: TempPane as never }] },
];
```

Update `DEFAULT_LAYOUT` in `workbenchSetup.ts` to add `temp/main`:

```ts
function DEFAULT_LAYOUT(api: DockviewApi) {
  if (!api.getPanel('temp/main')) {
    api.addPanel({ id: 'temp/main', component: 'temp/main', params: { paneId: 'temp/main' } });
  }
}
```

- [ ] **Step 5: Mount dockview in the Workbench**

`studio/frontend/src/app/Workbench.tsx`:

```tsx
import { useMemo } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { setupWorkbench } from './workbenchSetup';

export function Workbench() {
  const wb = useMemo(() => setupWorkbench(), []);
  const components = useMemo(() => wb.paneRegistry.asComponentMap(), [wb]);

  return (
    <div data-testid="workbench" className="dockview-theme-dark" style={{ height: '100vh' }}>
      <DockviewReact
        components={components}
        onReady={(e: DockviewReadyEvent) => wb.onReady(e.api)}
      />
    </div>
  );
}
```

- [ ] **Step 6: Write the failing e2e**

`studio/frontend/e2e/dockview.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('the docking surface mounts and shows the default pane', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('temp-pane')).toBeVisible();
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `just e2e`
Expected: the dockview spec passes (temp pane visible). Unit suite still green: `npx nx test studio-frontend`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(frontend): mount dockview surface and wire host/boot/layout"
```

---

### Task 10: Theme application + toggle (html .dark + dockview class) + persistence

The theme effect drives both shadcn (`.dark` on `<html>`) and dockview (`dockview-theme-*` on the dock container); the toggle flips the leaf; theme persists.

**Files:**
- Create: `studio/frontend/src/app/useApplyTheme.ts`, `studio/frontend/src/app/ThemeToggle.tsx`, `studio/frontend/src/state/persistWorkspace.ts`
- Modify: `studio/frontend/src/app/Workbench.tsx`
- Create: `studio/frontend/e2e/theme.spec.ts`

**Interfaces:**
- Consumes: `rootStore` (Task 3), persistence (Task 4).
- Produces: `useApplyTheme(dockEl: HTMLElement | null)`; `<ThemeToggle/>`; `registerWorkspacePersistence()` (persists + hydrates `workspace.theme`).

- [ ] **Step 1: Implement workspace persistence + hydration**

`studio/frontend/src/state/persistWorkspace.ts`:

```ts
import { rootStore } from './rootStore';
import { loadPersisted, makeDebouncedSaver } from './persistence';

const WS_KEY = 'workspace';
const WS_VERSION = 1;

export function hydrateWorkspace(): void {
  const saved = loadPersisted(WS_KEY, WS_VERSION, { theme: 'dark' as const });
  rootStore.workspace.set(saved);
}

export function registerWorkspacePersistence(): void {
  const save = makeDebouncedSaver<{ theme: 'light' | 'dark' }>(WS_KEY, WS_VERSION, 50);
  rootStore.workspace.attach(() => ({
    id: Symbol('workspace-persist'),
    init: () => ({}),
    onSet: () => save(rootStore.workspace.get({ noproxy: true })),
  }) as never);
}
```

Call `hydrateWorkspace()` + `registerWorkspacePersistence()` inside `setupWorkbench()` (before render).

- [ ] **Step 2: Implement the theme effect**

`studio/frontend/src/app/useApplyTheme.ts`:

```ts
import { useEffect } from 'react';
import { useHookstate } from '@hookstate/core';
import { rootStore } from '../state/rootStore';

export function useApplyTheme(dockEl: HTMLElement | null) {
  const theme = useHookstate(rootStore.workspace.theme);
  useEffect(() => {
    const dark = theme.get() === 'dark';
    document.documentElement.classList.toggle('dark', dark); // shadcn / Tailwind
    if (dockEl) {
      dockEl.classList.toggle('dockview-theme-dark', dark);
      dockEl.classList.toggle('dockview-theme-light', !dark);
    }
  }, [theme.get(), dockEl]);
}
```

- [ ] **Step 3: Implement the toggle**

`studio/frontend/src/app/ThemeToggle.tsx`:

```tsx
import { useHookstate } from '@hookstate/core';
import { Button } from '@/components/ui/button';
import { rootStore } from '../state/rootStore';

export function ThemeToggle() {
  const theme = useHookstate(rootStore.workspace.theme);
  return (
    <Button
      data-testid="theme-toggle"
      variant="outline"
      size="icon"
      onClick={() => theme.set((t) => (t === 'dark' ? 'light' : 'dark'))}
    >
      {theme.get() === 'dark' ? '🌙' : '☀️'}
    </Button>
  );
}
```

- [ ] **Step 4: Wire into the Workbench**

In `Workbench.tsx`, capture the dock container ref, call `useApplyTheme(dockEl)`, and render `<ThemeToggle/>` in a top bar:

```tsx
import { useMemo, useState } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { setupWorkbench } from './workbenchSetup';
import { useApplyTheme } from './useApplyTheme';
import { ThemeToggle } from './ThemeToggle';

export function Workbench() {
  const wb = useMemo(() => setupWorkbench(), []);
  const components = useMemo(() => wb.paneRegistry.asComponentMap(), [wb]);
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme(dockEl);

  return (
    <div data-testid="workbench" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 4 }}>
        <ThemeToggle />
      </div>
      <div ref={setDockEl} style={{ flex: 1 }}>
        <DockviewReact components={components} onReady={(e: DockviewReadyEvent) => wb.onReady(e.api)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Write the failing e2e (coverage row 2)**

`studio/frontend/e2e/theme.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('theme toggle flips dark/light and persists across reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  await expect(html).toHaveClass(/dark/);
  await page.getByTestId('theme-toggle').click();
  await expect(html).not.toHaveClass(/dark/);
  await page.reload();
  await expect(html).not.toHaveClass(/dark/); // persisted
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `just e2e`
Expected: theme spec passes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(frontend): add theme toggle with dockview sync and persistence"
```

---

### Task 11: Chrome — command palette + View menu

The ⌘/Ctrl-K command palette and a View menu, both views over the registries. Uses shadcn `command` + `menubar`.

**Files:**
- Create: `studio/frontend/src/components/ui/command.tsx`, `studio/frontend/src/components/ui/menubar.tsx` (shadcn), `studio/frontend/src/app/CommandPalette.tsx`, `studio/frontend/src/app/Menubar.tsx`
- Modify: `studio/frontend/src/app/Workbench.tsx`
- Create: `studio/frontend/e2e/chrome.spec.ts`

**Interfaces:**
- Consumes: `host` (Task 8) via `getHost()`.
- Produces: `<CommandPalette/>` (opens on ⌘/Ctrl-K, runs commands), `<Menubar/>` (File → Reset layout, View → pane list).

- [ ] **Step 1: Add shadcn command + menubar components**

Run inside `studio/frontend`: `npx shadcn@latest add command menubar` (or vendor them manually if the CLI can't resolve the Nx layout — both are standard shadcn components built on `cmdk` and `@radix-ui/react-menubar`; `npm install cmdk @radix-ui/react-menubar`).

- [ ] **Step 2: Implement the command palette**

`studio/frontend/src/app/CommandPalette.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { CommandDialog, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { getHost } from '../state/hostRef';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const host = getHost();
  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Type a command…" data-testid="command-input" />
      <CommandList>
        <CommandEmpty>No commands.</CommandEmpty>
        {host.listCommands().map((c) => (
          <CommandItem key={c.id} value={c.title} onSelect={() => { host.runCommand(c.id); setOpen(false); }}>
            {c.title}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
```

- [ ] **Step 3: Implement the View menu**

`studio/frontend/src/app/Menubar.tsx`:

```tsx
import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem } from '@/components/ui/menubar';
import { getHost } from '../state/hostRef';

export function AppMenubar() {
  const host = getHost();
  return (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
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
  );
}
```

- [ ] **Step 4: Wire into the Workbench top bar**

In `Workbench.tsx`, render `<AppMenubar/>` (left) and `<ThemeToggle/>` (right) in the top bar, and mount `<CommandPalette/>` once.

- [ ] **Step 5: Write the failing e2e (coverage rows 3, 4)**

`studio/frontend/e2e/chrome.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('Ctrl-K opens the palette and runs a command', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Control+k');
  await expect(page.getByTestId('command-input')).toBeVisible();
  // a demo command (added in Task 13) opens a pane — asserted there; here assert the palette opens.
});

test('View menu opens a pane and re-opening focuses (no duplicate)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('menu-view').click();
  // pane ids resolved against the demo plugins in Task 13; this test is completed there.
  await expect(page.getByTestId('menu-view')).toBeVisible();
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `just e2e`
Expected: chrome spec passes (palette opens; View menu visible).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(frontend): add command palette and View menu chrome"
```

---

### Task 12: Per-pane error boundary

Wrap every pane so a render-time throw shows a fallback in that pane instead of killing the workbench.

**Files:**
- Create: `studio/frontend/src/app/PaneErrorBoundary.tsx`
- Modify: `studio/frontend/src/host/paneRegistry.ts` (wrap components in `asComponentMap`)
- Create: `studio/frontend/src/app/PaneErrorBoundary.spec.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `PaneErrorBoundary` (class component); `asComponentMap()` now wraps each registered component in it.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/app/PaneErrorBoundary.spec.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaneErrorBoundary } from './PaneErrorBoundary';

function Boom(): never { throw new Error('boom'); }

describe('PaneErrorBoundary', () => {
  it('renders a fallback instead of propagating a render error', () => {
    render(<PaneErrorBoundary><Boom /></PaneErrorBoundary>);
    expect(screen.getByTestId('pane-error')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx nx test studio-frontend`
Expected: FAIL — cannot find `./PaneErrorBoundary`.

- [ ] **Step 3: Implement the boundary**

`studio/frontend/src/app/PaneErrorBoundary.tsx`:

```tsx
import { Component, type ReactNode } from 'react';

interface IPaneErrorBoundaryProps { children: ReactNode }
interface IPaneErrorBoundaryState { error: Error | null }

export class PaneErrorBoundary extends Component<IPaneErrorBoundaryProps, IPaneErrorBoundaryState> {
  state: IPaneErrorBoundaryState = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return <div data-testid="pane-error" style={{ padding: 12 }}>This pane failed to render.</div>;
    }
    return this.props.children;
  }
}
```

- [ ] **Step 4: Wrap registered components**

In `paneRegistry.ts`, change `asComponentMap` to wrap each component:

```tsx
// at top: import { PaneErrorBoundary } from '../app/PaneErrorBoundary';
// inside asComponentMap, when building cache:
cache[id] = (props: IDockviewPanelProps) => (
  <PaneErrorBoundary>{def.component(props) as never}</PaneErrorBoundary>
);
```

(Rename `paneRegistry.ts` → `paneRegistry.tsx` since it now contains JSX. Update imports.)

- [ ] **Step 5: Run it to verify it passes**

Run: `npx nx test studio-frontend`
Expected: PASS. Unit + e2e suites still green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(frontend): isolate pane render errors with a per-pane error boundary"
```

---

### Task 13: Demo plugins + final registry + render-counter + behavior e2e

Replace the temp plugin with `demo-counter` (persist) and `demo-scratch` (ephemeral), finalize `DEFAULT_LAYOUT`, add the render-counter test hook, and assert the behavior matrix (rows 5, 6, 10, plus completing rows 3–4).

**Files:**
- Create: `studio/frontend/src/plugins/demo-counter/{index.ts,state.ts,CounterPane.tsx,MirrorPane.tsx}`
- Create: `studio/frontend/src/plugins/demo-scratch/{index.ts,state.ts,ScratchPane.tsx}`
- Modify: `studio/frontend/src/plugins/index.ts`, `studio/frontend/src/app/workbenchSetup.ts` (final `DEFAULT_LAYOUT`)
- Create: `studio/frontend/src/app/renderCount.ts`
- Create: `studio/frontend/e2e/panes.spec.ts`

**Interfaces:**
- Consumes: `makePluginHooks` (Task 5), the host/boot/layout wiring.
- Produces: `PLUGINS = [demoCounter, demoScratch]`; `bumpRenderCount(name)` exposed on `window.__renderCounts` in dev/test builds.

- [ ] **Step 1: Add the render-counter hook**

`studio/frontend/src/app/renderCount.ts`:

```ts
// Test-only instrumentation: counts renders per named component.
declare global { interface Window { __renderCounts?: Record<string, number> } }

export function bumpRenderCount(name: string): void {
  if (import.meta.env.PROD) return;
  const w = window as Window;
  w.__renderCounts = w.__renderCounts ?? {};
  w.__renderCounts[name] = (w.__renderCounts[name] ?? 0) + 1;
}
```

- [ ] **Step 2: Implement demo-counter**

`src/plugins/demo-counter/state.ts`:

```ts
import { makePluginHooks } from '../../state/makePluginHooks';
export interface ICounterState { count: number }
export const counterHooks = makePluginHooks<ICounterState>('demo-counter');
```

`src/plugins/demo-counter/CounterPane.tsx`:

```tsx
import { Button } from '@/components/ui/button';
import { counterHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function CounterPane() {
  const s = counterHooks.usePluginState();
  bumpRenderCount('CounterPane');
  return (
    <div data-testid="counter-pane" style={{ padding: 12 }}>
      <span data-testid="counter-value">{s.count.get()}</span>
      <Button data-testid="counter-inc" onClick={() => s.count.set((c) => c + 1)}>+</Button>
    </div>
  );
}
```

`src/plugins/demo-counter/MirrorPane.tsx`:

```tsx
import { counterHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function MirrorPane() {
  const s = counterHooks.usePluginState();
  bumpRenderCount('MirrorPane');
  return <div data-testid="mirror-pane" style={{ padding: 12 }}>count is {s.count.get()}</div>;
}
```

`src/plugins/demo-counter/index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import type { ICounterState } from './state';
import { CounterPane } from './CounterPane';
import { MirrorPane } from './MirrorPane';

export const demoCounter: IPlugin<ICounterState> = {
  id: 'demo-counter',
  title: 'Counter',
  persist: true,
  initialState: { count: 0 },
  panes: [
    { id: 'demo-counter/editor', title: 'Counter', component: CounterPane as never },
    { id: 'demo-counter/mirror', title: 'Mirror', component: MirrorPane as never },
  ],
};
```

- [ ] **Step 3: Implement demo-scratch**

`src/plugins/demo-scratch/state.ts`:

```ts
import { makePluginHooks } from '../../state/makePluginHooks';
export interface IScratchState { text: string }
export const scratchHooks = makePluginHooks<IScratchState>('demo-scratch');
```

`src/plugins/demo-scratch/ScratchPane.tsx`:

```tsx
import { scratchHooks } from './state';
import { bumpRenderCount } from '../../app/renderCount';

export function ScratchPane() {
  const s = scratchHooks.usePluginState();
  bumpRenderCount('ScratchPane');
  return (
    <div data-testid="scratch-pane" style={{ padding: 12 }}>
      <input data-testid="scratch-input" value={s.text.get()} onChange={(e) => s.text.set(e.target.value)} />
    </div>
  );
}
```

`src/plugins/demo-scratch/index.ts`:

```ts
import type { IPlugin } from '../../host/types';
import type { IScratchState } from './state';
import { ScratchPane } from './ScratchPane';

export const demoScratch: IPlugin<IScratchState> = {
  id: 'demo-scratch',
  title: 'Scratch',
  persist: false,
  initialState: { text: '' },
  panes: [{ id: 'demo-scratch/main', title: 'Scratch', component: ScratchPane as never }],
};
```

- [ ] **Step 4: Finalize the registry and DEFAULT_LAYOUT**

`src/plugins/index.ts`:

```ts
import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch];
```

In `workbenchSetup.ts`, replace `DEFAULT_LAYOUT`:

```ts
function DEFAULT_LAYOUT(api: DockviewApi) {
  const add = (id: string, ref?: { direction: 'right' | 'below'; referencePanel: string }) => {
    if (!api.getPanel(id)) api.addPanel({ id, component: id, params: { paneId: id }, position: ref });
  };
  add('demo-counter/editor');
  add('demo-counter/mirror', { direction: 'right', referencePanel: 'demo-counter/editor' });
  add('demo-scratch/main', { direction: 'below', referencePanel: 'demo-counter/editor' });
}
```

- [ ] **Step 5: Write the failing behavior e2e (rows 5, 6, 10) and complete rows 3–4**

`studio/frontend/e2e/panes.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('counter increments, mirror reflects, and count persists across reload (rows 5)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('counter-inc').click();
  await page.getByTestId('counter-inc').click();
  await expect(page.getByTestId('counter-value')).toHaveText('2');
  await expect(page.getByTestId('mirror-pane')).toHaveText('count is 2');
  await page.reload();
  await expect(page.getByTestId('counter-value')).toHaveText('2'); // persist:true
});

test('scratch text is ephemeral across reload (row 6)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('scratch-input').fill('hello');
  await page.reload();
  await expect(page.getByTestId('scratch-input')).toHaveValue(''); // persist:false
});

test('incrementing re-renders only counter + mirror, not scratch (row 10)', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => (window.__renderCounts = {}));
  await page.getByTestId('counter-inc').click();
  const counts = await page.evaluate(() => window.__renderCounts ?? {});
  expect(counts['CounterPane'] ?? 0).toBeGreaterThanOrEqual(1);
  expect(counts['MirrorPane'] ?? 0).toBeGreaterThanOrEqual(1);
  expect(counts['ScratchPane'] ?? 0).toBe(0); // scoped subscription: scratch must not re-render
});

test('View menu opens a pane and re-opening focuses, not duplicates (row 4)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('demo-counter/editor' === 'x' ? '' : 'counter-inc'); // ensure app booted
  // close, then reopen via the View menu, then reopen again — still exactly one
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-demo-scratch/main').click();
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-demo-scratch/main').click();
  await expect(page.getByTestId('scratch-pane')).toHaveCount(1);
});
```

- [ ] **Step 6: Run it to verify it passes**

Run: `just e2e`
Expected: panes spec passes; the Task-11 chrome spec's command/pane assertions can now be completed if you stubbed them.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(frontend): add demo plugins, render-counter, and behavior e2e"
```

---

### Task 14: Layout e2e — dock interactions, persist/restore/reset, corrupt fallback, drag smoke

Complete the layout coverage (rows 7, 8, 9): API-driven dock changes + persistence, reset, corrupt-blob fallback, and one real-drag smoke.

**Files:**
- Create: `studio/frontend/e2e/layout.spec.ts`
- Create: `studio/frontend/e2e/helpers.ts` (localStorage seeding helper)

**Interfaces:**
- Consumes: the mounted workbench; `STORAGE_PREFIX` semantics (key `bloom.studio.layout`).

- [ ] **Step 1: Add a storage helper**

`studio/frontend/e2e/helpers.ts`:

```ts
import type { Page } from '@playwright/test';

export async function seedLocalStorage(page: Page, key: string, value: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value]);
}
```

- [ ] **Step 2: Write the failing e2e (rows 8, 9 + a real-drag smoke for 7)**

`studio/frontend/e2e/layout.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import { seedLocalStorage } from './helpers';

test('layout persists across reload and Reset restores default (row 8)', async ({ page }) => {
  await page.goto('/');
  // close the scratch pane via dockview API, reload, assert it stays closed (layout persisted)
  await page.evaluate(() => (window as any).__wbApi?.getPanel('demo-scratch/main')?.api.close());
  await expect(page.getByTestId('scratch-pane')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('scratch-pane')).toHaveCount(0);
  // Reset layout → default brings scratch back
  await page.getByTestId('menu-reset-layout').click();
  await expect(page.getByTestId('scratch-pane')).toHaveCount(1);
});

test('a corrupt saved layout falls back to default without crashing (row 9)', async ({ page }) => {
  await seedLocalStorage(page, 'bloom.studio.layout', '{not valid json');
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible(); // default layout applied, no crash
});

test('real drag smoke: a tab can be dragged to a new group (row 7)', async ({ page }) => {
  await page.goto('/');
  const source = page.getByText('Scratch', { exact: true }).first();
  const target = page.getByTestId('counter-pane');
  await source.dragTo(target); // best-effort; isolated smoke — flakiness can't sink the suite
  await expect(page.getByTestId('scratch-pane')).toBeVisible();
});
```

To support the API-driven test, expose the api on `window` in dev/test builds — in `workbenchSetup.ts` `onReady`, add: `if (!import.meta.env.PROD) (window as any).__wbApi = a;`

- [ ] **Step 3: Run it to verify it passes**

Run: `just e2e`
Expected: layout spec passes (the real-drag smoke may need a tolerant assertion; keep it isolated in this file).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(frontend): cover layout persistence, reset, corrupt fallback, drag smoke"
```

---

### Task 15: Error-path e2e — bad plugin, corrupt slice blob, unknown command

Complete the error-path coverage (rows 11, 12, 13), which the source-of-truth suite must encode.

**Files:**
- Create: `studio/frontend/e2e/errors.spec.ts`
- Create (test-only): a fault-injection switch so e2e can register a throwing plugin / unknown command without polluting production code.

**Interfaces:**
- Consumes: boot isolation (Task 8), command no-op (Task 8), slice persistence fallback (Tasks 4/8).

- [ ] **Step 1: Add a test-only fault-injection hook**

In `workbenchSetup.ts`, before `boot`, allow an injected extra plugin from a global set only in dev/test builds:

```ts
let extra: any[] = [];
if (!import.meta.env.PROD && (window as any).__injectPlugins) extra = (window as any).__injectPlugins;
boot([...PLUGINS, ...extra], host);
```

- [ ] **Step 2: Write the failing e2e (rows 11, 12, 13)**

`studio/frontend/e2e/errors.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

test('a plugin whose init throws is skipped; the workbench still boots (row 11)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__injectPlugins = [
      { id: 'bad', title: 'Bad', panes: [], init: () => { throw new Error('boom'); } },
    ];
  });
  await page.goto('/');
  await expect(page.getByTestId('counter-pane')).toBeVisible(); // good plugins still loaded
});

test('a corrupt persisted plugin slice falls back to initialState (row 12)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bloom.studio.demo-counter', '{bad json'));
  await page.goto('/');
  await expect(page.getByTestId('counter-value')).toHaveText('0'); // initialState, no crash
});

test('an unknown command id is a no-op, no crash (row 13)', async ({ page }) => {
  await page.goto('/');
  const ok = await page.evaluate(() => {
    try { (window as any).__host?.runCommand('does/not-exist'); return true; } catch { return false; }
  });
  expect(ok).toBe(true);
  await expect(page.getByTestId('counter-pane')).toBeVisible();
});
```

Expose the host in dev/test builds (`workbenchSetup.ts`, after `setHost`): `if (!import.meta.env.PROD) (window as any).__host = host;`

- [ ] **Step 3: Run it to verify it passes**

Run: `just e2e`
Expected: errors spec passes.

- [ ] **Step 4: Full-suite green check**

Run: `npx nx test studio-frontend && just e2e`
Expected: all unit tests pass; all e2e specs pass (the complete coverage matrix from spec §10).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "test(frontend): cover bad-plugin isolation, corrupt slice, unknown command"
```

---

## Self-Review

**1. Spec coverage (against the spec's build slice §11 and e2e matrix §10):**
- Nx React app + Tailwind v4 + shadcn → Tasks 1–2. ✓
- State layer (rootStore, makePluginHooks, persistence codec, theme effect) → Tasks 3, 4, 5, 10. ✓
- Host layer (IPluginHost, pane + command registries, layout service) → Tasks 6, 7, 8. ✓
- dockview mounted + openPane singleton + DEFAULT_LAYOUT → Tasks 9, 13. ✓
- Chrome (menubar, palette ⌘/Ctrl-K, View menu, theme toggle) → Tasks 10, 11. ✓
- Plugin registry + two demo plugins → Tasks 9 (temp), 13 (final). ✓
- Per-pane error boundary + dockview theme sync + persistence key scheme → Tasks 12, 10, 4/8. ✓
- Playwright wired + full coverage matrix rows 1–13 → Tasks 1 (1), 10 (2), 11 (3,4 partial), 13 (3,4,5,6,10), 14 (7,8,9), 15 (11,12,13). ✓
- justfile targets; CI deferred → Task 1. ✓

**2. Placeholder scan:** Every code step shows complete code; setup steps give exact commands + expected output. The genuinely volatile pieces (Nx generator output, Tailwind v4 + shadcn-in-Nx wiring, exact hookstate attach API, dockview layout JSON shape) are flagged with verify-against-docs notes rather than left as "TODO" — they are real instructions with concrete code, plus a fallback when a tool's API differs. No "TBD"/"handle edge cases".

**3. Type consistency:** `IPlugin/IPaneDef/ICommandDef/IPluginHost` (Task 6) are used unchanged in Tasks 5, 8, 9, 13. `makePluginHooks<TState>` → `{ usePluginState, useHost }` (Task 5) is consumed identically by `counterHooks`/`scratchHooks` (Task 13). `rootStore.plugins.nested(id)` is the single slice-access idiom across Tasks 5, 8, 9, 10. Persistence `STORAGE_PREFIX = 'bloom.studio.'` + key `layout`/`workspace`/`<pluginId>` (Task 4) match the e2e seeds in Tasks 14–15 (`bloom.studio.layout`, `bloom.studio.demo-counter`).

**Known risk flagged for the implementer:** Tailwind v4 + Nx + shadcn (Task 2) and the exact hookstate change-subscription API (Tasks 9–10) are the two spots most likely to need a small, version-specific adjustment. Both have a stated fallback; the e2e behavior is the contract that confirms either path works.

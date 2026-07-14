# Workbench UX pass 1 — journey phases + shell cleanups: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Chat/Focus layout builtins with four journey-phase presets (Design/Art/Math/Play), add a stateless toolbar phase switcher, make the Art phase the default layout, gate demo panes out of prod, and make the command palette discoverable + auto-list every pane.

**Architecture:** All changes live in `studio/frontend`. The existing `LAYOUT_BUILTINS` map + `createLayoutPresetsService.apply()` (`api.clear()` + rebuild) carry the presets — no new machinery. `workbenchSetup.ts` is deleted; `setupApp.ts` uses `LAYOUT_BUILTINS.Art` directly so there is exactly one definition of the default arrangement. `CommandPalette` becomes a controlled component so a toolbar hint button can open it, and it renders an "Open <title>" item per `host.listPanes()` entry, which lets the ~10 hand-written per-plugin `*/open-*` commands be deleted.

**Tech Stack:** React + TypeScript, Dockview, Vitest (unit), Playwright (e2e), Tailwind tokens from `docs/design-language.md`.

**Spec:** `docs/superpowers/specs/2026-07-14-workbench-ux-pass1-design.md`

## Global Constraints

- Work in worktree `C:\code\bloom.wt\workbench-ux`, branch `feat/workbench-ux`. `BLOOM_PORT_OFFSET=2` → studio frontend `:4202`, backend `:8002`, runtime client `:4302`. NEVER use default ports (`:4200`/`:8000`/`:4300`) — other live sessions hold them.
- The worktree has **no `node_modules` yet** — Task 1 Step 0 runs `npm install` first.
- TypeScript interfaces use an `I` prefix (`docs/coding-standards.md`).
- No raw colors — only existing Tailwind token classes (`border-border`, `text-muted-foreground`, `bg-raised-hover`, `text-foreground`); a guard test blocks raw colors outside `styles.css`.
- The View menu and its `view-open-*` testids are **untouched** — 29 e2e specs depend on them.
- Semantic commits (`feat:`/`test:`/`refactor:`), imperative mood.
- All unit test commands run from `C:\code\bloom.wt\workbench-ux\studio\frontend` (`npx vitest run <path>`).
- Pane ids (verified in plugin manifests): `llm-chat/room`, `gdd/viewer`, `game/preview`, `property-inspector/panel`, `assets/board`, `game-config/editor`, `math/viewer`.

---

### Task 1: Journey-phase layout builtins

**Files:**

- Modify: `studio/frontend/src/app/layoutPresets.builtins.ts`
- Test: `studio/frontend/src/app/layoutPresets.builtins.spec.ts`

**Interfaces:**

- Consumes: `LAYOUT_BUILTINS: Record<string, (api, reg) => void>` shape consumed by `createLayoutPresetsService` (`src/host/layoutPresets.ts`) — unchanged.
- Produces: `LAYOUT_BUILTINS` with exactly four keys: `Design`, `Art`, `Math`, `Play`. Task 2 references `LAYOUT_BUILTINS.Art`; Task 3's switcher calls `presets.apply('<key>')` with these names.

- [ ] **Step 0: Install dependencies (worktree is fresh)**

```powershell
cd C:\code\bloom.wt\workbench-ux; npm install
```

- [ ] **Step 1: Write the failing test — replace the whole spec file**

Replace the entire contents of `studio/frontend/src/app/layoutPresets.builtins.spec.ts` with:

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

function addedIds(api: ReturnType<typeof fakeApi>): string[] {
  return api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id);
}

describe('LAYOUT_BUILTINS', () => {
  it('exposes exactly the four journey phases', () => {
    expect(Object.keys(LAYOUT_BUILTINS)).toEqual(['Design', 'Art', 'Math', 'Play']);
  });

  it('Design: chat left, GDD viewer right', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Design(api as never, reg);
    expect(addedIds(api)).toEqual(['llm-chat/room', 'gdd/viewer']);
    const gdd = api.addPanel.mock.calls[1][0] as { position?: unknown };
    expect(gdd.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
  });

  it('Art: chat left, game scene right, inspector right of it, asset board below it', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Art(api as never, reg);
    expect(addedIds(api)).toEqual(['llm-chat/room', 'game/preview', 'property-inspector/panel', 'assets/board']);
    const [, game, inspector, board] = api.addPanel.mock.calls.map((c) => c[0] as { position?: unknown });
    expect(game.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
    expect(inspector.position).toEqual({ direction: 'right', referencePanel: 'game/preview' });
    expect(board.position).toEqual({ direction: 'below', referencePanel: 'game/preview' });
  });

  it('Math: chat left, game config right, math viewer right of it', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Math(api as never, reg);
    expect(addedIds(api)).toEqual(['llm-chat/room', 'game-config/editor', 'math/viewer']);
    const [, config, math] = api.addPanel.mock.calls.map((c) => c[0] as { position?: unknown });
    expect(config.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
    expect(math.position).toEqual({ direction: 'right', referencePanel: 'game-config/editor' });
  });

  it('Play: game scene dominant, chat docked left and narrow', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Play(api as never, reg);
    expect(addedIds(api)).toEqual(['game/preview', 'llm-chat/room']);
    const chat = api.addPanel.mock.calls[1][0] as { position?: unknown; initialWidth?: number };
    expect(chat.position).toEqual({ direction: 'left', referencePanel: 'game/preview' });
    expect(chat.initialWidth).toBe(360);
  });

  it('is idempotent: skips panes that already exist', () => {
    const api = fakeApi();
    api.getPanel = vi.fn(() => ({}) as never);
    LAYOUT_BUILTINS.Art(api as never, reg);
    expect(api.addPanel).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/app/layoutPresets.builtins.spec.ts
```

Expected: FAIL — `LAYOUT_BUILTINS` still has keys `Chat`, `Focus`.

- [ ] **Step 3: Implement — replace the whole builtins file**

Replace the entire contents of `studio/frontend/src/app/layoutPresets.builtins.ts` with:

```ts
import type { DockviewApi } from 'dockview-react';

interface IPaneRegistryLikeLocal {
  get(id: string): { title?: string } | undefined;
}

type Position = { direction: 'left' | 'right' | 'below'; referencePanel: string };

// Mirrors the Dockview add idiom; add-if-missing so re-applying a preset over
// a partial layout only fills the gaps.
function addPane(api: DockviewApi, reg: IPaneRegistryLikeLocal, id: string, position?: Position, initialWidth?: number): void {
  if (!api.getPanel(id)) {
    api.addPanel({ id, component: id, title: reg.get(id)?.title ?? id, params: { paneId: id }, position, initialWidth });
  }
}

// The four authoring-journey phases (spec: workbench-ux-pass1). Chat is the
// control surface, docked left in every phase.
export const LAYOUT_BUILTINS: Record<string, (api: DockviewApi, reg: IPaneRegistryLikeLocal) => void> = {
  Design(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'gdd/viewer', { direction: 'right', referencePanel: 'llm-chat/room' });
  },
  Art(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'game/preview', { direction: 'right', referencePanel: 'llm-chat/room' });
    addPane(api, reg, 'property-inspector/panel', { direction: 'right', referencePanel: 'game/preview' });
    addPane(api, reg, 'assets/board', { direction: 'below', referencePanel: 'game/preview' });
  },
  Math(api, reg) {
    addPane(api, reg, 'llm-chat/room');
    addPane(api, reg, 'game-config/editor', { direction: 'right', referencePanel: 'llm-chat/room' });
    addPane(api, reg, 'math/viewer', { direction: 'right', referencePanel: 'game-config/editor' });
  },
  Play(api, reg) {
    // Game scene first so it owns the dominant share; chat docks left, narrow.
    addPane(api, reg, 'game/preview');
    addPane(api, reg, 'llm-chat/room', { direction: 'left', referencePanel: 'game/preview' }, 360);
  },
};
```

Note: `initialWidth` is a supported Dockview `AddPanelOptions` field (verified in `node_modules/dockview-core/dist/cjs/dockview/options.d.ts`).

- [ ] **Step 4: Run test to verify it passes**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/app/layoutPresets.builtins.spec.ts
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```powershell
cd C:\code\bloom.wt\workbench-ux
git add studio/frontend/src/app/layoutPresets.builtins.ts studio/frontend/src/app/layoutPresets.builtins.spec.ts
git commit -m "feat(studio): journey-phase layout builtins (Design/Art/Math/Play)"
```

---

### Task 2: Default layout = Art phase (delete workbenchSetup.ts)

**Files:**

- Delete: `studio/frontend/src/app/workbenchSetup.ts`
- Modify: `studio/frontend/src/app/setupApp.ts`

**Interfaces:**

- Consumes: `LAYOUT_BUILTINS.Art(api, paneRegistry)` from Task 1 (already imported in `setupApp.ts` as `LAYOUT_BUILTINS`).
- Produces: nothing new — `setupApp` behavior only. The e2e default-layout contract (Task 6) becomes: first run / Reset shows `llm-chat/room` + `game/preview` + `property-inspector/panel` + `assets/board`.

- [ ] **Step 1: Rewire setupApp**

In `studio/frontend/src/app/setupApp.ts`:

Remove the import (line 13):

```ts
import { DEFAULT_LAYOUT } from './workbenchSetup';
```

Replace the two call sites:

```ts
const layoutService = createLayoutService({
  paneRegistry,
  defaultLayout: (a) => LAYOUT_BUILTINS.Art(a, paneRegistry),
});

const host = createHost({
  paneRegistry,
  commandRegistry,
  getApi: () => api,
  resetLayout: () => {
    layoutService.reset();
    if (api) LAYOUT_BUILTINS.Art(api, paneRegistry);
  },
});
```

(`LAYOUT_BUILTINS` is already imported on line 14 — keep that import.)

- [ ] **Step 2: Delete the now-orphaned file**

```powershell
cd C:\code\bloom.wt\workbench-ux
git rm studio/frontend/src/app/workbenchSetup.ts
```

`setupApp.ts` was its only importer (verified by grep — the only other `DEFAULT_LAYOUT` mention is a comment in `layoutPresets.builtins.ts`, rewritten in Task 1).

- [ ] **Step 3: Verify — typecheck + full unit suite**

```powershell
cd C:\code\bloom.wt\workbench-ux
npx nx run frontend:typecheck; npx nx run frontend:test
```

Expected: both PASS (`setupApp.spec.ts` still passes — it asserts builtin presets exist, not their names).

- [ ] **Step 4: Commit**

```powershell
git add -A studio/frontend/src/app
git commit -m "feat(studio): default layout delegates to the Art phase preset"
```

---

### Task 3: PhaseSwitcher in the toolbar

**Files:**

- Create: `studio/frontend/src/app/PhaseSwitcher.tsx`
- Create: `studio/frontend/src/app/PhaseSwitcher.spec.tsx`
- Modify: `studio/frontend/src/app/Workbench.tsx`

**Interfaces:**

- Consumes: `getLayoutPresets()/setLayoutPresets()` from `src/state/layoutPresetsRef.ts`; `ILayoutPresetsService.apply(name: string): boolean`.
- Produces: `<PhaseSwitcher />` (no props), testids `phase-switcher` and `phase-Design` / `phase-Art` / `phase-Math` / `phase-Play` (Task 6's e2e clicks `phase-Math`).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/app/PhaseSwitcher.spec.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLayoutPresets } from '../state/layoutPresetsRef';
import { PhaseSwitcher } from './PhaseSwitcher';
import type { ILayoutPresetsService } from '../host/layoutPresets';

const apply = vi.fn(() => true);
beforeEach(() => {
  apply.mockClear();
  setLayoutPresets({ apply, saveAs: vi.fn(), list: vi.fn(() => []), delete: vi.fn(), onPresetsChange: vi.fn(() => () => {}) } as ILayoutPresetsService);
});

describe('PhaseSwitcher', () => {
  it('renders the four journey phases in order', () => {
    render(<PhaseSwitcher />);
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Design', 'Art', 'Math', 'Play']);
  });

  it('clicking a phase applies that preset', () => {
    render(<PhaseSwitcher />);
    fireEvent.click(screen.getByTestId('phase-Math'));
    expect(apply).toHaveBeenCalledWith('Math');
  });

  it('has no active-phase highlight (stateless by design)', () => {
    render(<PhaseSwitcher />);
    fireEvent.click(screen.getByTestId('phase-Art'));
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
  });
});
```

(If `setLayoutPresets` rejects double-set across specs, check `src/state/layoutPresetsRef.ts` — it is a plain module-level ref (`let` + setter), so repeated sets are fine.)

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/app/PhaseSwitcher.spec.tsx
```

Expected: FAIL — `./PhaseSwitcher` module not found.

- [ ] **Step 3: Implement the component**

Create `studio/frontend/src/app/PhaseSwitcher.tsx`:

```tsx
import { getLayoutPresets } from '../state/layoutPresetsRef';

const PHASES = ['Design', 'Art', 'Math', 'Play'] as const;

// Deliberately stateless: no active-phase highlight — the layout drifts the
// moment the user rearranges panes, and a lying highlight is worse than none.
export function PhaseSwitcher() {
  const presets = getLayoutPresets();
  return (
    <div data-testid="phase-switcher" className="flex items-center overflow-hidden rounded-md border border-border">
      {PHASES.map((name, i) => (
        <button
          key={name}
          type="button"
          data-testid={`phase-${name}`}
          onClick={() => presets.apply(name)}
          className={`px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-raised-hover hover:text-foreground ${i > 0 ? 'border-l border-border' : ''}`}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
```

(Hairline-bordered segment group per `docs/design-language.md`: `--border` maps to `--hairline`; no new colors, no accent.)

- [ ] **Step 4: Run test to verify it passes**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/app/PhaseSwitcher.spec.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 5: Render it in the toolbar's empty flex space**

In `studio/frontend/src/app/Workbench.tsx`, add the import and replace the spacer `<div className="flex-1" />` :

```tsx
import { PhaseSwitcher } from './PhaseSwitcher';
```

```tsx
<div className="flex flex-1 items-center justify-center">
  <PhaseSwitcher />
</div>
```

- [ ] **Step 6: Verify typecheck + suite**

```powershell
cd C:\code\bloom.wt\workbench-ux
npx nx run frontend:typecheck; npx nx run frontend:test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add studio/frontend/src/app/PhaseSwitcher.tsx studio/frontend/src/app/PhaseSwitcher.spec.tsx studio/frontend/src/app/Workbench.tsx
git commit -m "feat(studio): toolbar phase switcher applies journey presets"
```

---

### Task 4: Demo panes out of prod

**Files:**

- Modify: `studio/frontend/src/plugins/index.ts`
- Create: `studio/frontend/src/plugins/index.spec.ts`

**Interfaces:**

- Consumes: `import.meta.env.PROD` (same guard pattern as `__injectPlugins` in `setupApp.ts`).
- Produces: `PLUGINS: IPlugin[]` — demo plugins present in dev, absent in prod. Nothing else changes.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/index.spec.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PLUGINS demo gating', () => {
  it('includes demo plugins outside prod', async () => {
    vi.resetModules();
    const { PLUGINS } = await import('./index');
    const ids = PLUGINS.map((p) => p.id);
    expect(ids).toContain('demo-counter');
    expect(ids).toContain('demo-scratch');
  });

  it('excludes demo plugins in prod builds', async () => {
    vi.stubEnv('PROD', true);
    vi.resetModules();
    const { PLUGINS } = await import('./index');
    const ids = PLUGINS.map((p) => p.id);
    expect(ids).not.toContain('demo-counter');
    expect(ids).not.toContain('demo-scratch');
  });
});
```

(`vi.stubEnv('PROD', true)` stubs `import.meta.env.PROD`; `vi.resetModules()` forces `./index` to re-evaluate its module-level guard.)

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/plugins/index.spec.ts
```

Expected: FAIL — the prod test finds `demo-counter` (no gating yet).

- [ ] **Step 3: Implement the gate**

In `studio/frontend/src/plugins/index.ts`, remove `demoCounter, demoScratch` from the array literal and append conditionally:

```ts
export const PLUGINS: IPlugin[] = [
  sceneStorePlugin,
  llmChat,
  assets,
  gdd,
  game,
  gameConfig,
  gameStructure,
  sceneGraph,
  propertyInspector,
  regionOverrides,
  math,
];

// Demo panes are dev-only fixtures (used by e2e chrome/panes/keyboard specs,
// which run against the dev server).
if (!import.meta.env.PROD) {
  PLUGINS.push(demoCounter, demoScratch);
}
```

(Keep both imports — they are still used in the dev branch.)

- [ ] **Step 4: Run test to verify it passes**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/plugins/index.spec.ts
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```powershell
cd C:\code\bloom.wt\workbench-ux
git add studio/frontend/src/plugins/index.ts studio/frontend/src/plugins/index.spec.ts
git commit -m "feat(studio): gate demo panes out of prod builds"
```

---

### Task 5: Palette — hint button, auto-listed panes, delete open-\* commands

**Files:**

- Modify: `studio/frontend/src/app/CommandPalette.tsx`
- Create: `studio/frontend/src/app/CommandPalette.spec.tsx`
- Modify: `studio/frontend/src/app/Workbench.tsx`
- Modify (delete `commands` entries): `studio/frontend/src/plugins/llm-chat/index.ts`, `assets/index.ts`, `gdd/index.ts`, `game/index.ts`, `game-config/index.ts`, `game-structure/index.ts`, `scene-graph/index.ts`, `property-inspector/index.ts`, `region-overrides/index.ts`, `math/index.ts`
- Modify (manifest specs): `studio/frontend/src/plugins/llm-chat/index.spec.ts`, `assets/index.spec.ts`, `scene-graph/index.spec.ts`, `property-inspector/index.spec.ts`

**Interfaces:**

- Consumes: `IPluginHost.listPanes(): IPaneDef[]`, `listCommands(): ICommandDef[]`, `openPane(id)`, `runCommand(id)` via `getHost()/setHost()` (`src/state/hostRef.ts`).
- Produces: `CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void })` — now controlled; Workbench owns the state. Toolbar button testid `palette-hint`. `demo-counter/increment` is the ONLY plugin command left (e2e `chrome.spec.ts` runs it — do not delete it).

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/app/CommandPalette.spec.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setHost } from '../state/hostRef';
import { CommandPalette } from './CommandPalette';
import type { IPluginHost } from '../host/types';

const openPane = vi.fn();
const runCommand = vi.fn();

function fakeHost(): IPluginHost {
  return {
    registerPane: vi.fn(),
    registerCommand: vi.fn(),
    openPane,
    runCommand,
    listPanes: () => [
      { id: 'gdd/viewer', title: 'Game Design Doc', component: () => null },
      { id: 'assets/board', title: 'Asset Board', component: () => null },
    ],
    listCommands: () => [{ id: 'shell/reset-layout', title: 'Reset layout', run: vi.fn() }],
    resetLayout: vi.fn(),
  };
}

beforeEach(() => {
  openPane.mockClear();
  runCommand.mockClear();
  setHost(fakeHost());
});

describe('CommandPalette', () => {
  it('lists an "Open <title>" entry for every registered pane plus all commands', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText('Open Game Design Doc')).toBeTruthy();
    expect(screen.getByText('Open Asset Board')).toBeTruthy();
    expect(screen.getByText('Reset layout')).toBeTruthy();
  });

  it('selecting an Open entry opens the pane and closes the palette', () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText('Open Asset Board'));
    expect(openPane).toHaveBeenCalledWith('assets/board');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when closed', () => {
    render(<CommandPalette open={false} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('command-input')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```powershell
cd C:\code\bloom.wt\workbench-ux\studio\frontend; npx vitest run src/app/CommandPalette.spec.tsx
```

Expected: FAIL — `CommandPalette` takes no props / no "Open …" entries.

- [ ] **Step 3: Implement the controlled palette with auto-listed panes**

Replace the entire contents of `studio/frontend/src/app/CommandPalette.tsx` with:

```tsx
import { useEffect } from 'react';
import { CommandDialog, CommandInput, CommandList, CommandItem, CommandEmpty } from '@/components/ui/command';
import { getHost } from '../state/hostRef';

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const host = getHost();
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command…" data-testid="command-input" />
      <CommandList>
        <CommandEmpty>No commands.</CommandEmpty>
        {host.listPanes().map((p) => (
          <CommandItem
            key={p.id}
            value={`Open ${p.title}`}
            onSelect={() => {
              host.openPane(p.id);
              onOpenChange(false);
            }}
          >
            Open {p.title}
          </CommandItem>
        ))}
        {host.listCommands().map((c) => (
          <CommandItem
            key={c.id}
            value={c.title}
            onSelect={() => {
              host.runCommand(c.id);
              onOpenChange(false);
            }}
          >
            {c.title}
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
```

- [ ] **Step 4: Wire Workbench — own the state, add the hint button**

In `studio/frontend/src/app/Workbench.tsx`:

Add to imports:

```tsx
import { useState, type ReactNode } from 'react';
```

(replacing the existing `import { type ReactNode } from 'react';`)

Inside the component, before `return`:

```tsx
const [paletteOpen, setPaletteOpen] = useState(false);
```

In the toolbar, immediately after the PhaseSwitcher flex-space div (before `{roomContext && …}`), add:

```tsx
        <button
          type="button"
          data-testid="palette-hint"
          title="Open the command palette"
          onClick={() => setPaletteOpen(true)}
          className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-raised-hover hover:text-foreground"
        >
          Commands ⌘K
        </button>
        <ToolbarDivider />
```

And change the palette render to:

```tsx
<CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
```

- [ ] **Step 5: Delete the hand-written open-\* plugin commands**

Remove the entire `commands:` property from these 10 plugin manifests (the auto-listed pane entries replace them; `demo-counter/increment` in `demo-counter/index.ts` STAYS):

- `src/plugins/llm-chat/index.ts` (3 commands)
- `src/plugins/assets/index.ts`
- `src/plugins/gdd/index.ts`
- `src/plugins/game/index.ts`
- `src/plugins/game-config/index.ts`
- `src/plugins/game-structure/index.ts`
- `src/plugins/scene-graph/index.ts`
- `src/plugins/property-inspector/index.ts`
- `src/plugins/region-overrides/index.ts`
- `src/plugins/math/index.ts`

- [ ] **Step 6: Update the four manifest specs that asserted those commands**

`src/plugins/llm-chat/index.spec.ts` — replace the `'declares three commands'` test with:

```ts
it('declares no commands (palette auto-lists panes)', () => {
  expect(llmChat.commands).toBeUndefined();
});
```

`src/plugins/assets/index.spec.ts` — in the `'declares id, pane, and command'` test, replace the commands assertion line with `expect(assets.commands).toBeUndefined();` (and rename the test to `'declares id and pane'`).

`src/plugins/scene-graph/index.spec.ts` — delete the line asserting `toContain('scene-graph/open')` (replace with `expect(sceneGraph.commands).toBeUndefined();`).

`src/plugins/property-inspector/index.spec.ts` — delete both `property-inspector/open` assertion lines (replace with `expect(propertyInspector.commands).toBeUndefined();`).

- [ ] **Step 7: Run the full unit suite + typecheck**

```powershell
cd C:\code\bloom.wt\workbench-ux
npx nx run frontend:typecheck; npx nx run frontend:test
```

Expected: PASS — including the new CommandPalette spec and the four updated manifest specs.

- [ ] **Step 8: Commit**

```powershell
git add -A studio/frontend/src
git commit -m "feat(studio): palette hint button + auto-listed pane commands, drop per-plugin open-* commands"
```

---

### Task 6: E2e updates — new default layout, builtin names, phase switcher

**Files:**

- Modify: `studio/frontend/e2e/layout-presets.spec.ts`
- Modify: `studio/frontend/e2e/layout.spec.ts`

**Interfaces:**

- Consumes: testids from earlier tasks — `phase-Math`, `layout-apply-Design`; pane testids `chat-room-pane`, `asset-board`, `gdd-no-game`, `gc-no-game`, `math-no-game` (hermetic `gotoWorkbench` rooms have `gameId: null`, so the no-game placeholders render); dv `__wbApi` dev hook.
- Produces: green Playwright specs encoding the new default-layout contract.

- [ ] **Step 1: Rewrite `e2e/layout-presets.spec.ts`**

Replace the entire file with:

```ts
import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('apply the Design built-in shows chat + GDD and drops the Art panes', async ({ page }) => {
  await gotoWorkbench(page);
  // Default = Art phase: asset board is present.
  await expect(page.getByTestId('asset-board')).toBeVisible();

  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-Design').click();

  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('gdd-no-game')).toBeVisible();
  await expect(page.getByTestId('asset-board')).toHaveCount(0);
});

test('clicking a phase button lands that phase panes', async ({ page }) => {
  await gotoWorkbench(page);
  await page.getByTestId('phase-Math').click();

  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('gc-no-game')).toBeVisible();
  await expect(page.getByTestId('math-no-game')).toBeVisible();
  await expect(page.getByTestId('asset-board')).toHaveCount(0);
});

test('save the current arrangement, change it, then re-apply restores it', async ({ page }) => {
  await gotoWorkbench(page);
  // Default = Art phase. Save it as "mine".
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-save').click();
  await page.getByTestId('save-layout-name').fill('mine');
  await page.getByTestId('save-layout-confirm').click();

  // Mutate: close the Asset Board.
  await page.evaluate(() => (window as any).__wbApi?.getPanel('assets/board')?.api.close());
  await page.getByTestId('asset-board').waitFor({ state: 'detached' });

  // Re-apply "mine" → Asset Board returns.
  await page.getByTestId('menu-layout').click();
  await page.getByTestId('layout-apply-mine').click();
  await expect(page.getByTestId('asset-board')).toBeVisible();
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

- [ ] **Step 2: Update `e2e/layout.spec.ts` for the Art default**

The old default pane used for close/persist/reset assertions was `llm-chat/settings` (`chat-settings-pane`) — no longer in the default layout. Swap to `assets/board` (`asset-board`):

Test 1 (`layout persists across reload…`): replace the close + waits:

```ts
// Close a DEFAULT pane (asset board) via __wbApi so it's missing from the layout.
await page.evaluate(() => (window as any).__wbApi?.getPanel('assets/board')?.api.close());
await page.getByTestId('asset-board').waitFor({ state: 'detached' });

// Wait for the debounced (~250ms) layout save to flush — layout must NOT include the closed pane.
await page.waitForFunction(() => {
  const val = localStorage.getItem('bloom.studio.layout');
  return val != null && !val.includes('assets/board');
});
```

…and the two assertions after reload / after reset:

```ts
await expect(page.getByTestId('asset-board')).toHaveCount(0);
```

```ts
// After reset: add-if-missing re-adds the asset board — proves reset re-applied the default.
await expect(page.getByTestId('asset-board')).toBeVisible();
```

Test 2 (corrupt layout): update the stale comment — the fallback default is the Art phase — and keep the `chat-room-pane` assertion (still valid).

Test 3 (drag smoke): the `Chat Settings` tab no longer exists by default. Drag the `Asset Board` tab instead:

```ts
const source = page.locator('.dv-tab', { hasText: 'Asset Board' }).first();
const target = page.getByTestId('chat-room-pane');
await source.dragTo(target, { force: true });
// Active panel content is attached — no crash or blank dockview.
await page.getByTestId('asset-board').waitFor({ state: 'attached' });
// Both tab-strip entries survive — neither panel was accidentally closed by the drag.
await expect(page.locator('.dv-tab', { hasText: 'Asset Board' })).toHaveCount(1);
await expect(page.locator('.dv-tab', { hasText: 'Chat Room' })).toHaveCount(1);
```

- [ ] **Step 3: Commit**

```powershell
cd C:\code\bloom.wt\workbench-ux
git add studio/frontend/e2e/layout-presets.spec.ts studio/frontend/e2e/layout.spec.ts
git commit -m "test(e2e): journey-phase presets + Art default layout contract"
```

---

### Task 7: Full gates, e2e run, PR

**Files:** none (verification + PR only)

- [ ] **Step 1: Frontend CI gates (all four — vitest green ≠ types valid)**

```powershell
cd C:\code\bloom.wt\workbench-ux
.\node_modules\.bin\prettier --check .
npx nx run frontend:typecheck
npx nx run frontend:test
npx nx run frontend:build
```

Expected: all PASS. If prettier fails, run `.\node_modules\.bin\prettier --write .` on the failing files (pinned prettier, NOT npx — npx pulls a newer version that disagrees on markdown).

- [ ] **Step 2: Full e2e against the replay backend (worktree offset 2)**

In one terminal (leave running):

```powershell
cd C:\code\bloom.wt\workbench-ux; just backend-serve-replay
```

Then:

```powershell
cd C:\code\bloom.wt\workbench-ux; just e2e
```

Expected: full suite green. `BLOOM_PORT_OFFSET=2` comes from the worktree `.env` — the suite must attach to `:4202`/`:8002`, never the default-port stack. Specs most exposed to the default-layout change beyond the two updated files: `chrome.spec.ts` (demo panes — still present, e2e runs the dev server), `styling.spec.ts` and `panes.spec.ts` (open panes via the View menu — untouched). Investigate any red with superpowers:systematic-debugging before touching the spec.

- [ ] **Step 3: Push and open the PR**

```powershell
cd C:\code\bloom.wt\workbench-ux
git push -u origin feat/workbench-ux
gh pr create --title "feat(studio): journey-phase presets + shell cleanups (workbench UX pass 1)" --body "Implements docs/superpowers/specs/2026-07-14-workbench-ux-pass1-design.md

- Design/Art/Math/Play layout builtins replace Chat/Focus; toolbar PhaseSwitcher (stateless)
- Default layout = Art phase (workbenchSetup.ts deleted; one definition)
- Demo panes gated out of prod builds
- Command palette: toolbar hint button, auto-lists Open <pane> for every registered pane; 10 hand-written open-* commands deleted
- View menu + view-open-* testids untouched
- Full unit gates + just e2e (replay, offset-2 ports) green

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review notes

- **Spec coverage:** §1 presets → Task 1; §2 switcher → Task 3; §3 default = Art → Task 2; §4 demo gating → Task 4, palette hint + auto-list → Task 5; testing section → Tasks 1/3/4/5 (unit), Task 6 (e2e names + phase-button assertion), Task 7 (`just e2e`).
- **Play "narrow chat":** expressed as `initialWidth: 360` on the chat panel added left of the game scene — a Dockview-supported `AddPanelOptions` field; asserted at unit level only (widths are cosmetic).
- **`demo-counter/increment` survives** Task 5 — `chrome.spec.ts` drives it through the palette.
- **Type consistency:** `CommandPalette({ open, onOpenChange })` (Task 5 Step 3) matches Workbench usage (Step 4) and the spec file (Step 1); `PhaseSwitcher` testids `phase-<Name>` match Task 6's `phase-Math` click.

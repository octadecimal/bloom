# Asset Board View Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows-Explorer-style view control to the asset board that switches thumbnail size (Small/Medium/Large) and a compact List layout, with the choice persisted globally.

**Architecture:** A pure `viewConfig` module maps each view mode to presentation tokens (container layout, card/image sizes, which chrome to render). `AssetBoardPane` holds the active mode in local state (seeded from a persisted pref), renders a four-button `ViewToggle` in its header, and passes the mode to each `AssetCard`, which looks up its tokens from `viewConfig`. No backend, socket, or shared-store changes — pure client view state.

**Tech Stack:** React + TypeScript, hookstate (existing plugin state), Tailwind (semantic tokens only), `lucide-react` icons, vitest (unit), Playwright (e2e). Persistence via the existing `state/persistence.ts` helpers.

## Global Constraints

- **TypeScript interfaces use an `I` prefix** (`IAssetViewConfig`, `IAssetPrefs`). Union type aliases (`AssetViewMode`) do not.
- **No raw colors** — use semantic Tailwind tokens only (e.g. `bg-muted`, `text-muted-foreground`, `border-border`). Raw hex outside `styles.css` is blocked by a guard test.
- **Single source for `AssetViewMode`**: declared in `viewConfig.ts`; every other file imports it from there.
- **Persistence key**: `assets.prefs`, version `1`, stored under the `bloom.studio.` prefix by the shared helpers. Default `{ viewMode: 'medium' }`.
- **Run all frontend gates before pushing** (from `studio/frontend`): `npx prettier --check .` (repo-pinned prettier), `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. A green vitest run does NOT prove types compile — run all four.
- **Single-file unit runs** during TDD: from `studio/frontend`, `npx vitest run <relative-spec-path>`.
- All new `data-testid`s: `view-mode-small`, `view-mode-medium`, `view-mode-large`, `view-mode-list` (toggle buttons); the asset grid container gains `data-view-mode={mode}`; each card root gains `data-view-mode={mode}`.

---

### Task 1: `viewConfig.ts` — the mode → presentation token map

**Files:**

- Create: `studio/frontend/src/plugins/assets/viewConfig.ts`
- Test: `studio/frontend/src/plugins/assets/viewConfig.spec.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type AssetViewMode = 'small' | 'medium' | 'large' | 'list'`
  - `interface IAssetViewConfig { container: string; card: string; image: string; showWorkflow: boolean; showCandidates: boolean; actions: 'always' | 'hover'; row: boolean }`
  - `const VIEW_CONFIG: Record<AssetViewMode, IAssetViewConfig>`
  - `const VIEW_MODES: AssetViewMode[]` (ordered: small, medium, large, list)

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/assets/viewConfig.spec.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { VIEW_CONFIG, VIEW_MODES, type AssetViewMode } from './viewConfig';

describe('viewConfig', () => {
  it('lists the four modes in size order', () => {
    expect(VIEW_MODES).toEqual(['small', 'medium', 'large', 'list']);
  });

  it('has a complete config entry for every mode', () => {
    for (const mode of VIEW_MODES) {
      const cfg = VIEW_CONFIG[mode];
      expect(typeof cfg.container).toBe('string');
      expect(cfg.container.length).toBeGreaterThan(0);
      expect(typeof cfg.card).toBe('string');
      expect(typeof cfg.image).toBe('string');
      expect(typeof cfg.showWorkflow).toBe('boolean');
      expect(typeof cfg.showCandidates).toBe('boolean');
      expect(['always', 'hover']).toContain(cfg.actions);
      expect(typeof cfg.row).toBe('boolean');
    }
  });

  it('only Large shows full chrome (workflow + candidates + always-on actions)', () => {
    expect(VIEW_CONFIG.large).toMatchObject({ showWorkflow: true, showCandidates: true, actions: 'always', row: false });
    expect(VIEW_CONFIG.small).toMatchObject({ showWorkflow: false, showCandidates: false, actions: 'hover' });
    expect(VIEW_CONFIG.medium).toMatchObject({ showWorkflow: false, showCandidates: false, actions: 'hover' });
  });

  it('only List uses a row layout', () => {
    expect(VIEW_CONFIG.list.row).toBe(true);
    expect(VIEW_CONFIG.small.row).toBe(false);
    const modes: AssetViewMode[] = ['small', 'medium', 'large'];
    for (const m of modes) expect(VIEW_CONFIG[m].row).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `studio/frontend`): `npx vitest run src/plugins/assets/viewConfig.spec.ts`
Expected: FAIL — cannot resolve `./viewConfig`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/assets/viewConfig.ts`:

```ts
// studio/frontend/src/plugins/assets/viewConfig.ts
// Presentation tokens per asset-board view mode. AssetCard is a thin renderer
// that looks up its layout/chrome here, so the modes live in one data-driven map.

export type AssetViewMode = 'small' | 'medium' | 'large' | 'list';

export interface IAssetViewConfig {
  /** Tailwind classes for the grid/list container that wraps all cards. */
  container: string;
  /** Tailwind classes applied to each card root (width, or row layout). */
  card: string;
  /** Tailwind classes for the selected-image box (height, and size in list). */
  image: string;
  /** Show the workflow tag in the card header. */
  showWorkflow: boolean;
  /** Render the candidate-seed strip inline. */
  showCandidates: boolean;
  /** 'always' = footer actions always rendered; 'hover' = only while hovered. */
  actions: 'always' | 'hover';
  /** Lay the card out as a horizontal row (List view). */
  row: boolean;
}

export const VIEW_MODES: AssetViewMode[] = ['small', 'medium', 'large', 'list'];

export const VIEW_CONFIG: Record<AssetViewMode, IAssetViewConfig> = {
  small: { container: 'flex flex-wrap gap-2', card: 'w-24', image: 'h-20', showWorkflow: false, showCandidates: false, actions: 'hover', row: false },
  medium: { container: 'flex flex-wrap gap-2.5', card: 'w-36', image: 'h-28', showWorkflow: false, showCandidates: false, actions: 'hover', row: false },
  large: { container: 'flex flex-wrap gap-2.5', card: 'w-56', image: 'h-32', showWorkflow: true, showCandidates: true, actions: 'always', row: false },
  list: { container: 'flex flex-col gap-1', card: 'w-full', image: 'h-10 w-10', showWorkflow: true, showCandidates: false, actions: 'always', row: true },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/assets/viewConfig.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/viewConfig.ts studio/frontend/src/plugins/assets/viewConfig.spec.ts
git commit -m "feat(assets): view-mode presentation config"
```

---

### Task 2: `prefs.ts` — persist the global view-mode choice

**Files:**

- Create: `studio/frontend/src/plugins/assets/prefs.ts`
- Test: `studio/frontend/src/plugins/assets/prefs.spec.ts`

**Interfaces:**

- Consumes: `AssetViewMode` from `./viewConfig`; `savePersisted`/`loadPersisted` from `../../state/persistence`.
- Produces:
  - `interface IAssetPrefs { viewMode: AssetViewMode }`
  - `loadPrefs(): IAssetPrefs` (defaults to `{ viewMode: 'medium' }`)
  - `savePrefs(prefs: IAssetPrefs): void`
  - `const ASSET_PREFS_KEY = 'assets.prefs'`, `const ASSET_PREFS_VERSION = 1`

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/assets/prefs.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadPrefs, savePrefs } from './prefs';

describe('assets prefs', () => {
  beforeEach(() => localStorage.clear());

  it('loadPrefs defaults to medium on first run', () => {
    expect(loadPrefs()).toEqual({ viewMode: 'medium' });
  });

  it('savePrefs round-trips through loadPrefs', () => {
    savePrefs({ viewMode: 'small' });
    expect(loadPrefs()).toEqual({ viewMode: 'small' });
  });

  it('persists under the bloom.studio.assets.prefs key', () => {
    savePrefs({ viewMode: 'list' });
    expect(localStorage.getItem('bloom.studio.assets.prefs')).toContain('list');
  });

  it('falls back to the default when a stale version is stored', () => {
    localStorage.setItem('bloom.studio.assets.prefs', JSON.stringify({ version: 0, data: { viewMode: 'list' } }));
    expect(loadPrefs()).toEqual({ viewMode: 'medium' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/assets/prefs.spec.ts`
Expected: FAIL — cannot resolve `./prefs`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/assets/prefs.ts`:

```ts
// studio/frontend/src/plugins/assets/prefs.ts
import { savePersisted, loadPersisted } from '../../state/persistence';
import type { AssetViewMode } from './viewConfig';

export const ASSET_PREFS_KEY = 'assets.prefs';
export const ASSET_PREFS_VERSION = 1;

export interface IAssetPrefs {
  viewMode: AssetViewMode;
}

export function loadPrefs(): IAssetPrefs {
  return loadPersisted<IAssetPrefs>(ASSET_PREFS_KEY, ASSET_PREFS_VERSION, { viewMode: 'medium' });
}

export function savePrefs(prefs: IAssetPrefs): void {
  savePersisted(ASSET_PREFS_KEY, ASSET_PREFS_VERSION, prefs);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/assets/prefs.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/prefs.ts studio/frontend/src/plugins/assets/prefs.spec.ts
git commit -m "feat(assets): persist asset-board view mode"
```

---

### Task 3: `ViewToggle.tsx` — the four-button segmented control

**Files:**

- Create: `studio/frontend/src/plugins/assets/ViewToggle.tsx`
- Test: `studio/frontend/src/plugins/assets/ViewToggle.spec.tsx`

**Interfaces:**

- Consumes: `AssetViewMode`, `VIEW_MODES` from `./viewConfig`; `Button` from `@/components/ui/button`; icons from `lucide-react`.
- Produces: `function ViewToggle({ mode, onChange }: { mode: AssetViewMode; onChange: (m: AssetViewMode) => void })`.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/assets/ViewToggle.spec.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewToggle } from './ViewToggle';

describe('ViewToggle', () => {
  it('renders a button for each of the four modes', () => {
    render(<ViewToggle mode="medium" onChange={() => {}} />);
    expect(screen.getByTestId('view-mode-small')).toBeTruthy();
    expect(screen.getByTestId('view-mode-medium')).toBeTruthy();
    expect(screen.getByTestId('view-mode-large')).toBeTruthy();
    expect(screen.getByTestId('view-mode-list')).toBeTruthy();
  });

  it('marks the active mode with aria-pressed', () => {
    render(<ViewToggle mode="large" onChange={() => {}} />);
    expect(screen.getByTestId('view-mode-large').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('view-mode-small').getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onChange with the clicked mode', () => {
    const onChange = vi.fn();
    render(<ViewToggle mode="medium" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('view-mode-list'));
    expect(onChange).toHaveBeenCalledWith('list');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/plugins/assets/ViewToggle.spec.tsx`
Expected: FAIL — cannot resolve `./ViewToggle`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/assets/ViewToggle.tsx`:

```tsx
// studio/frontend/src/plugins/assets/ViewToggle.tsx
import { Grid3x3, LayoutGrid, Square, List } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { VIEW_MODES, type AssetViewMode } from './viewConfig';

const ICONS: Record<AssetViewMode, typeof Grid3x3> = {
  small: Grid3x3,
  medium: LayoutGrid,
  large: Square,
  list: List,
};

const LABELS: Record<AssetViewMode, string> = {
  small: 'Small thumbnails',
  medium: 'Medium thumbnails',
  large: 'Large thumbnails',
  list: 'List view',
};

export function ViewToggle({ mode, onChange }: { mode: AssetViewMode; onChange: (m: AssetViewMode) => void }) {
  return (
    <div role="group" aria-label="Asset view mode" className="flex items-center gap-0.5">
      {VIEW_MODES.map((m) => {
        const Icon = ICONS[m];
        const active = m === mode;
        return (
          <Button
            key={m}
            type="button"
            size="icon"
            variant={active ? 'accentOutline' : 'ghost'}
            aria-pressed={active}
            aria-label={LABELS[m]}
            title={LABELS[m]}
            data-testid={`view-mode-${m}`}
            onClick={() => onChange(m)}
          >
            <Icon className="h-3.5 w-3.5" />
          </Button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/plugins/assets/ViewToggle.spec.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/ViewToggle.tsx studio/frontend/src/plugins/assets/ViewToggle.spec.tsx
git commit -m "feat(assets): segmented view-mode toggle control"
```

---

### Task 4: `AssetCard.tsx` — config-driven chrome + List row

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetCard.tsx` (full rewrite below)
- Modify: `studio/frontend/src/plugins/assets/AssetCard.spec.tsx` (pass `mode`, add per-mode tests)

**Interfaces:**

- Consumes: `VIEW_CONFIG`, `AssetViewMode` from `./viewConfig`; `cn` from `@/lib/utils`.
- Produces: `function AssetCard({ index, mode }: { index: number; mode: AssetViewMode })` — `mode` is now **required**.

The existing `AssetCard.spec.tsx` renders `<AssetCard index={0} />` with no mode. Those tests assume full chrome (workflow, candidates, always-on Generate), so they become Large-mode tests: update each `render(<AssetCard index={0} />)` to `render(<AssetCard index={0} mode="large" />)`. Then add new tests for compact-mode behavior.

- [ ] **Step 1: Update existing tests to pass `mode="large"` and add new failing tests**

In `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`, replace every `render(<AssetCard index={0} />)` with `render(<AssetCard index={0} mode="large" />)`, and the two-card render block:

```tsx
render(
  <>
    <AssetCard index={0} mode="large" />
    <AssetCard index={1} mode="large" />
  </>,
);
```

Then append these new tests inside the `describe('AssetCard', ...)` block:

```tsx
it('large mode shows the workflow tag, candidates, and an always-visible Generate', () => {
  assetsSlice().assets.set([
    mk({
      status: 'done',
      generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
      selectedGenerationId: 'gen1',
      progress: null,
    }),
  ]);
  render(<AssetCard index={0} mode="large" />);
  expect(screen.getByTestId('asset-candidates')).toBeTruthy();
  expect(screen.getByText('schnell-opaque')).toBeTruthy();
  expect(screen.getByTestId('asset-generate')).toBeTruthy();
});

it('medium mode hides workflow + candidates and reveals actions only on hover', () => {
  assetsSlice().assets.set([
    mk({
      status: 'done',
      generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
      selectedGenerationId: 'gen1',
      progress: null,
    }),
  ]);
  render(<AssetCard index={0} mode="medium" />);
  expect(screen.queryByTestId('asset-candidates')).toBeNull();
  expect(screen.queryByText('schnell-opaque')).toBeNull();
  expect(screen.queryByTestId('asset-generate')).toBeNull();
  fireEvent.mouseEnter(screen.getByTestId('asset-card-a1'));
  expect(screen.getByTestId('asset-generate')).toBeTruthy();
  fireEvent.mouseLeave(screen.getByTestId('asset-card-a1'));
  expect(screen.queryByTestId('asset-generate')).toBeNull();
});

it('surfaces the error state in compact (small) mode', () => {
  assetsSlice().assets.set([mk({ status: 'error', error: 'boom', progress: null })]);
  render(<AssetCard index={0} mode="small" />);
  expect(screen.getByTestId('asset-error').textContent).toContain('boom');
});

it('list mode renders a row with name, workflow, and always-visible actions', () => {
  assetsSlice().assets.set([mk({ status: 'idle', progress: null })]);
  render(<AssetCard index={0} mode="list" />);
  const card = screen.getByTestId('asset-card-a1');
  expect(card.getAttribute('data-view-mode')).toBe('list');
  expect(screen.getByText('Wild')).toBeTruthy();
  expect(screen.getByText('schnell-opaque')).toBeTruthy();
  expect(screen.getByTestId('asset-generate')).toBeTruthy();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/assets/AssetCard.spec.tsx`
Expected: FAIL — `AssetCard` does not accept `mode` / compact-mode behavior not implemented (type error or assertion failures).

- [ ] **Step 3: Rewrite `AssetCard.tsx`**

Replace the entire contents of `studio/frontend/src/plugins/assets/AssetCard.tsx` with:

```tsx
// studio/frontend/src/plugins/assets/AssetCard.tsx
import { useState, useEffect } from 'react';
import { assetsHooks } from './state';
import type { IGeneration } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { ImageLightbox } from './ImageLightbox';
import { VIEW_CONFIG, type AssetViewMode } from './viewConfig';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// Subscribes to ITS OWN asset node (s.assets[index]) and reads individual leaves,
// so an asset_progress tick (scoped node write) re-renders only this card.
// `mode` drives presentation via VIEW_CONFIG so the card stays a thin renderer.
export function AssetCard({ index, mode }: { index: number; mode: AssetViewMode }) {
  const s = assetsHooks.usePluginState();
  const a = s.assets[index];
  bumpRenderCount('AssetCard');
  const cfg = VIEW_CONFIG[mode];

  const id = a.id.get();
  const status = a.status.get();
  const generations = a.generations.get() as IGeneration[];
  const selectedId = a.selectedGenerationId.get();
  const progress = a.progress.get();
  const selected = generations.find((g) => g.id === selectedId);
  const busy = status === 'generating' || status === 'queued';
  const [zoomed, setZoomed] = useState(false);
  const [hovered, setHovered] = useState(false);
  useEffect(() => {
    setZoomed(false);
  }, [selectedId]);
  // NOTE: hookstate v4 reserves `state.error` for async promise errors; reach the
  // asset field via `a.nested('error')`.
  const errorMessage = (a.nested('error') as unknown as { get(): string | null }).get();
  const showActions = cfg.actions === 'always' || hovered;

  // Transient-state block — rendered in EVERY mode so an in-flight or failed
  // generation is never hidden, however compact the tile is.
  const statusBlock = (
    <>
      {status === 'generating' && progress && <progress data-testid="asset-progress" className="w-full" value={progress.value} max={progress.max} />}
      {status === 'generating' && !progress && !selected && (
        <span data-testid="asset-generating" className="text-xs text-muted-foreground">
          Generating…
        </span>
      )}
      {status === 'queued' && (
        <span data-testid="asset-queued" className="text-xs text-muted-foreground">
          queued…
        </span>
      )}
      {status === 'error' && (
        <span data-testid="asset-error" className="text-xs text-destructive">
          {errorMessage ?? 'Generation failed'}
        </span>
      )}
    </>
  );

  const generateButton = (
    <Button data-testid="asset-generate" variant="accentOutline" onClick={() => generateAsset(id)} disabled={busy}>
      {generations.length > 0 ? 'Generate again' : 'Generate'}
    </Button>
  );
  const deleteButton = (
    <Button variant="ghost" onClick={() => void deleteAsset(id)}>
      Delete
    </Button>
  );
  const lightbox = selected && <ImageLightbox src={`${BACKEND_URL}${selected.imageRef}`} alt={a.name.get()} open={zoomed} onOpenChange={setZoomed} />;

  // LIST MODE — one compact horizontal row: thumb · name · workflow · status · actions.
  if (cfg.row) {
    return (
      <Card data-testid={`asset-card-${id}`} data-view-mode={mode} className={cn(cfg.card, 'flex items-center gap-2 p-1.5')}>
        <div className={cn(cfg.image, 'flex shrink-0 items-center justify-center overflow-hidden rounded bg-muted')}>
          {selected && (
            <img
              data-testid="asset-selected-image"
              src={`${BACKEND_URL}${selected.imageRef}`}
              alt={a.name.get()}
              onClick={() => setZoomed(true)}
              className="h-full w-full cursor-zoom-in object-contain"
            />
          )}
        </div>
        <strong className="flex-1 truncate">{a.name.get()}</strong>
        <span className="font-mono text-[11px] text-muted-foreground">{a.workflow.get()}</span>
        <div className="flex justify-end">{statusBlock}</div>
        {generateButton}
        {deleteButton}
        {lightbox}
      </Card>
    );
  }

  // GRID MODES (small / medium / large) — vertical card with config-driven chrome.
  return (
    <Card
      data-testid={`asset-card-${id}`}
      data-view-mode={mode}
      className={cfg.card}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <strong className="truncate">{a.name.get()}</strong>
          {cfg.showWorkflow && <span className="font-mono text-[11px] text-muted-foreground">{a.workflow.get()}</span>}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        {selected && (
          <div className={cn(cfg.image, 'flex w-full items-center justify-center overflow-hidden rounded-md bg-muted')}>
            <img
              data-testid="asset-selected-image"
              src={`${BACKEND_URL}${selected.imageRef}`}
              alt={a.name.get()}
              width={a.width.get()}
              height={a.height.get()}
              onClick={() => setZoomed(true)}
              className="h-full w-full cursor-zoom-in object-contain"
            />
          </div>
        )}

        {statusBlock}
        {!selected && status === 'idle' && <span className="text-xs text-muted-foreground">No image yet</span>}

        {cfg.showCandidates && generations.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="asset-candidates">
            {generations.map((g) => (
              <img
                key={g.id}
                src={`${BACKEND_URL}${g.imageRef}`}
                alt={`seed ${g.seed}`}
                width={48}
                height={48}
                onClick={() => void selectGeneration(id, g.id)}
                className="cursor-pointer rounded"
                style={{ outline: g.id === selectedId ? '2px solid currentColor' : 'none' }}
              />
            ))}
          </div>
        )}
      </CardContent>

      {showActions && (
        <CardFooter className="justify-between">
          {generateButton}
          {deleteButton}
        </CardFooter>
      )}

      {lightbox}
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/plugins/assets/AssetCard.spec.tsx`
Expected: PASS (all existing Large-mode tests + 4 new per-mode tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/assets/AssetCard.spec.tsx
git commit -m "feat(assets): config-driven card chrome + list row per view mode"
```

---

### Task 5: `AssetBoardPane.tsx` — wire the toggle, state, persistence, and layout

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`
- Modify: `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx` (add view-mode tests)

**Interfaces:**

- Consumes: `loadPrefs`, `savePrefs` from `./prefs`; `ViewToggle` from `./ViewToggle`; `VIEW_CONFIG`, `AssetViewMode` from `./viewConfig`; passes `mode` to `AssetCard`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx` inside the `describe('AssetBoardPane', ...)` block. Add `fireEvent` to the testing-library import (`import { render, screen, act, fireEvent } from '@testing-library/react';`) and `import { loadPrefs } from './prefs';` at the top:

```tsx
it('renders the four view-mode toggles', () => {
  act(() => {
    assetsSlice().activeGameId.set('g1');
  });
  render(<AssetBoardPane {...fakeProps} />);
  expect(screen.getByTestId('view-mode-small')).toBeTruthy();
  expect(screen.getByTestId('view-mode-medium')).toBeTruthy();
  expect(screen.getByTestId('view-mode-large')).toBeTruthy();
  expect(screen.getByTestId('view-mode-list')).toBeTruthy();
});

it('defaults the grid to medium and persists a new choice on click', () => {
  localStorage.clear();
  act(() => {
    assetsSlice().activeGameId.set('g1');
  });
  render(<AssetBoardPane {...fakeProps} />);
  expect(screen.getByTestId('asset-grid').getAttribute('data-view-mode')).toBe('medium');
  fireEvent.click(screen.getByTestId('view-mode-list'));
  expect(screen.getByTestId('asset-grid').getAttribute('data-view-mode')).toBe('list');
  expect(loadPrefs()).toEqual({ viewMode: 'list' });
});

it('seeds the active mode from persisted prefs on mount', () => {
  localStorage.setItem('bloom.studio.assets.prefs', JSON.stringify({ version: 1, data: { viewMode: 'small' } }));
  act(() => {
    assetsSlice().activeGameId.set('g1');
  });
  render(<AssetBoardPane {...fakeProps} />);
  expect(screen.getByTestId('asset-grid').getAttribute('data-view-mode')).toBe('small');
});
```

Also add `localStorage.clear();` as the first line inside the file's existing `beforeEach` so a persisted mode from one test never leaks into the next:

```tsx
beforeEach(() => {
  localStorage.clear();
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  window.__renderCounts = {};
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/plugins/assets/AssetBoardPane.spec.tsx`
Expected: FAIL — no `view-mode-*` toggles, `asset-grid` has no `data-view-mode`.

- [ ] **Step 3: Edit `AssetBoardPane.tsx`**

Add imports near the existing ones:

```tsx
import { ViewToggle } from './ViewToggle';
import { VIEW_CONFIG, type AssetViewMode } from './viewConfig';
import { loadPrefs, savePrefs } from './prefs';
```

Add the mode state alongside the other `useState` hooks (after the `workflow` state line):

```tsx
const [mode, setMode] = useState<AssetViewMode>(() => loadPrefs().viewMode);
const changeMode = (m: AssetViewMode) => {
  setMode(m);
  savePrefs({ viewMode: m });
};
```

Replace the `PanelHeader` line:

```tsx
<PanelHeader label="Asset Board" right={<span className="font-mono">{activeGameId}</span>} />
```

with:

```tsx
<PanelHeader
  label="Asset Board"
  right={
    <span className="flex items-center gap-2">
      <ViewToggle mode={mode} onChange={changeMode} />
      <span className="font-mono">{activeGameId}</span>
    </span>
  }
/>
```

Replace the grid container line:

```tsx
<div className="flex flex-wrap gap-2.5" data-testid="asset-grid">
  {Array.from({ length: assetCount }, (_, i) => (
    <AssetCard key={i} index={i} />
  ))}
</div>
```

with:

```tsx
<div className={VIEW_CONFIG[mode].container} data-testid="asset-grid" data-view-mode={mode}>
  {Array.from({ length: assetCount }, (_, i) => (
    <AssetCard key={i} index={i} mode={mode} />
  ))}
</div>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/plugins/assets/AssetBoardPane.spec.tsx`
Expected: PASS (existing tests + 3 new view-mode tests).

- [ ] **Step 5: Run the full assets unit suite + typecheck**

Run (from `studio/frontend`):

```bash
npx vitest run src/plugins/assets
npx nx typecheck frontend
```

Expected: all green; no TS errors. (vitest passing does NOT prove types — run typecheck too.)

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetBoardPane.tsx studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
git commit -m "feat(assets): wire view-mode toggle, persistence, and grid layout into the board"
```

---

### Task 6: E2e — pin existing tests to Large, add a view-mode spec

**Files:**

- Modify: `studio/frontend/e2e/assets.spec.ts` (seed existing tests to Large; add a new test)

**Interfaces:**

- Consumes: `seedLocalStorage` from `./helpers` (already imported).

**Why pin existing tests to Large:** today's asset e2e tests assert the Generate button is visible by default and click it directly. The new default is Medium, which hides actions until hover — so those tests must either hover first or run in Large. Pinning them to Large (full chrome) keeps them focused on generation behavior with zero behavioral drift; the NEW test exercises Medium/Small/List/hover/persistence. This matches the repo rule that e2e is the source of truth, updated deliberately to the new contract.

- [ ] **Step 1: Seed existing tests to Large mode**

In `studio/frontend/e2e/assets.spec.ts`, edit the `openApp` helper to also seed the asset-board pref to `large` so every existing test keeps full chrome:

```ts
async function openApp(page: Page, username: string) {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await seedLocalStorage(page, 'bloom.studio.assets.prefs', JSON.stringify({ version: 1, data: { viewMode: 'large' } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}
```

- [ ] **Step 2: Add the new view-mode e2e test**

Append to `studio/frontend/e2e/assets.spec.ts`:

```ts
test('view-mode toggle changes density, reveals actions on hover, and persists', async ({ page }) => {
  const name = `View ${Date.now()}`;
  await openApp(page, 'alice'); // seeds large; we switch modes explicitly below
  await createGameViaRoom(page, name);
  await addAsset(page);

  // Switch to Medium: card width shrinks vs Large (denser).
  const card = page.getByTestId(/^asset-card-/).first();
  await page.getByTestId('view-mode-large').click();
  const largeWidth = (await card.boundingBox())!.width;
  await page.getByTestId('view-mode-medium').click();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'medium');
  const mediumWidth = (await card.boundingBox())!.width;
  expect(mediumWidth).toBeLessThan(largeWidth);

  // In Medium the Generate action is hidden until the card is hovered.
  await expect(page.getByTestId('asset-generate')).toHaveCount(0);
  await card.hover();
  await expect(page.getByTestId('asset-generate')).toBeVisible();

  // List mode lays cards out as full-width rows.
  await page.getByTestId('view-mode-list').click();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'list');

  // The chosen mode persists across a reload.
  await page.reload();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'list');
});
```

- [ ] **Step 3: Run the e2e suite against a replay backend**

Start the replay backend first (separate terminal, from repo root, with this worktree's `BLOOM_PORT_OFFSET` exported): `just backend-serve-replay`. Then:

Run: `just e2e`
Expected: all asset tests pass, including the new `view-mode toggle …` test. (Per repo policy this runs locally, not in CI.)

- [ ] **Step 4: Commit**

```bash
git add studio/frontend/e2e/assets.spec.ts
git commit -m "test(assets): e2e for view-mode density, hover actions, and persistence"
```

---

## Final verification (before PR)

- [ ] From `studio/frontend`, run all four gates and confirm green:
  - `npx prettier --check .`
  - `npx nx typecheck frontend`
  - `npx nx test frontend`
  - `npx nx build frontend`
- [ ] `just e2e` green (replay backend running).
- [ ] Push and open a PR: `git push -u origin feat/asset-board-view-modes && gh pr create`.

## Notes for the implementer

- **`AssetViewMode` lives in `viewConfig.ts`** — import it from there everywhere; do not redeclare it in `prefs.ts`.
- **Hover-reveal is React state, not CSS** (`onMouseEnter`/`onMouseLeave` → `hovered`), so it is testable in both jsdom (`fireEvent.mouseEnter`) and Playwright (`locator.hover()`).
- **The status block renders in every mode** — never gate `asset-progress` / `asset-error` / `asset-queued` behind a mode, or a small tile could hide a failure.
- **Semantic Tailwind tokens only** — the new classes (`bg-muted`, `text-muted-foreground`, etc.) already comply; do not introduce raw colors.

```

```

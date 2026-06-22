# Asset Board: workspace-game binding + full-size image viewer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Asset Board always reflect the open workspace's single game (no in-board game picker), and let a click on a generated preview open a full-size in-app image viewer.

**Architecture:** The workspace route (`RoomRoute`) already owns the room lifecycle (`openRoom`/`closeRoom`). We add the symmetric game lifecycle there: `openGame(room.gameId)` on entry and a new `closeGame()` on exit. The Asset Board stops managing games entirely and just renders the new-asset form + grid for the active game. A new `ImageLightbox` (built on the existing shadcn `Dialog`) opens when the selected preview image is clicked; candidate thumbnails keep their select-on-click behavior.

**Tech Stack:** React + TypeScript, Hookstate, dockview, Vitest + Testing Library (unit/component), Playwright (e2e), Radix Dialog via `@/components/ui/dialog`.

## Global Constraints

- TypeScript interfaces use an `I` prefix (`IPlugin`, `IAsset`, `IImageLightboxProps`). Copied from `docs/coding-standards.md`.
- Conventional Commits for every commit (`feat`, `fix`, `test`, `refactor`, …).
- TDD: write the failing test, watch it fail, minimal code to pass, then refactor.
- Frontend CI gates (run before pushing): `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`. Vitest green ≠ types valid — run all four.
- Browser e2e (Playwright) is **never in CI**; run locally via `just e2e` against a replay backend (`just backend-serve-replay` first).
- Backend is unchanged. The room↔game binding already exists (`studio/backend/app/store.py:66-68`).
- All work happens on branch `feat/asset-board-game-binding` (already created; the spec is committed there).
- Run all `npx`/`nx`/`git` commands from `studio/frontend` unless noted. On a fresh PowerShell, refresh PATH first:
  `$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")`

---

### Task 1: `closeGame()` action + trim `initAssets()`

**Files:**

- Modify: `studio/frontend/src/plugins/assets/actions.ts`
- Test: `studio/frontend/src/plugins/assets/actions.spec.ts`

**Interfaces:**

- Consumes: existing `assetsSlice()`, `SocketDeps.leaveGame`, `__setDeps` (all in `actions.ts`).
- Produces: `export function closeGame(): void` — leaves the active game's socket room (if any) and resets `activeGameId` → `null`, `assets` → `[]`, `assetsStatus` → `'idle'`. Consumed by Task 2.

- [ ] **Step 1: Write the failing test**

Append to `studio/frontend/src/plugins/assets/actions.spec.ts` inside the `describe('assets actions', …)` block:

```ts
it('closeGame leaves the active game and clears assets', async () => {
  const leaveGame = vi.fn();
  actions.__setDeps({
    rest: {
      getGames: vi.fn(),
      getAssets: vi.fn().mockResolvedValue([asset]),
      createGame: vi.fn(),
      createAsset: vi.fn(),
      updateAsset: vi.fn(),
      deleteAsset: vi.fn(),
      selectGeneration: vi.fn(),
    },
    socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame, generateAsset: vi.fn() },
  });
  await actions.openGame('g1');
  expect(assetsSlice().activeGameId.get()).toBe('g1');

  actions.closeGame();

  expect(leaveGame).toHaveBeenCalledWith('g1');
  expect(assetsSlice().activeGameId.get()).toBeNull();
  expect(assetsSlice().assets.get({ noproxy: true })).toHaveLength(0);
  expect(assetsSlice().assetsStatus.get()).toBe('idle');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/assets/actions.spec.ts`
Expected: FAIL — `actions.closeGame is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `studio/frontend/src/plugins/assets/actions.ts`, add after `openGame` (mirrors `closeRoom` in llm-chat):

```ts
export function closeGame(): void {
  const s = assetsSlice();
  const prev = s.activeGameId.get();
  if (prev) sock().leaveGame(prev);
  s.activeGameId.set(null);
  s.assets.set([]);
  s.assetsStatus.set('idle');
}
```

Then trim `initAssets()` so it only ensures the socket connection (game is opened by the route now):

```ts
export function initAssets(): void {
  ensureConnected();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/plugins/assets/actions.spec.ts`
Expected: PASS (all assets-actions tests, including the new one).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/actions.ts studio/frontend/src/plugins/assets/actions.spec.ts
git commit -m "feat(assets): add closeGame() and trim initAssets to connection-only"
```

---

### Task 2: `RoomRoute` opens/closes the game with the room

**Files:**

- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx`
- Test: `studio/frontend/src/app/routes/RoomRoute.spec.tsx`

**Interfaces:**

- Consumes: `openGame(gameId)` and `closeGame()` from `../../plugins/assets/actions`; `IRoom.gameId` from the room returned by `getRooms()`.
- Produces: behavior only — on entering a valid room, `openGame(room.gameId)` is called (when `gameId` is non-null); on unmount, `closeGame()` is called.

- [ ] **Step 1: Write the failing test**

In `studio/frontend/src/app/routes/RoomRoute.spec.tsx`, add mocks for the assets actions near the other `vi.mock` calls:

```ts
const openGame = vi.fn();
const closeGame = vi.fn();
vi.mock('../../plugins/assets/actions', () => ({
  openGame: (id: string) => openGame(id),
  closeGame: () => closeGame(),
}));
```

Reset them in `beforeEach`:

```ts
openGame.mockReset();
closeGame.mockReset();
```

Add two tests inside `describe('RoomRoute', …)`:

```ts
it('valid room with a gameId → opens that game', async () => {
  getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: 'g1', createdAt: 't' }]);
  render(tree('/room/r1'));
  expect(await screen.findByTestId('workbench')).toBeInTheDocument();
  expect(openGame).toHaveBeenCalledWith('g1');
});

it('unmount → closeGame is called', async () => {
  getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: 'g1', createdAt: 't' }]);
  const { unmount } = render(tree('/room/r1'));
  await screen.findByTestId('workbench');
  unmount();
  expect(closeGame).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/app/routes/RoomRoute.spec.tsx`
Expected: FAIL — `openGame` / `closeGame` not called (mocks register 0 calls).

- [ ] **Step 3: Write minimal implementation**

Edit `studio/frontend/src/app/routes/RoomRoute.tsx`. Add the import:

```ts
import { openGame, closeGame } from '../../plugins/assets/actions';
```

In the validation effect, capture the matched room and open its game (replace the existing `rooms.some(...)` check):

```ts
getRooms()
  .then((rooms) => {
    if (!alive) return;
    const room = rooms.find((r) => r.id === roomId);
    if (room) {
      void openRoom(roomId!);
      if (room.gameId) void openGame(room.gameId);
      setState('valid');
    } else {
      setState('invalid');
    }
  })
  .catch(() => alive && setState('invalid'));
```

Extend the existing unmount cleanup so it also closes the game:

```ts
// Leave the room AND its game when the route unmounts (back to picker / different room).
useEffect(
  () => () => {
    closeRoom();
    closeGame();
  },
  [],
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/app/routes/RoomRoute.spec.tsx`
Expected: PASS (existing + new tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/routes/RoomRoute.tsx studio/frontend/src/app/routes/RoomRoute.spec.tsx
git commit -m "feat(assets): open/close the workspace game with the room route"
```

---

### Task 3: Strip game-management UI from `AssetBoardPane`

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`
- Test: `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx` (rewrite)

**Interfaces:**

- Consumes: `activeGameId` and `assets` from the assets plugin state (set by `openGame`); `createAsset` from `./actions`.
- Produces: a board that renders the new-asset form + grid for the active game and renders **no** `game-select` / `new-game` / `refresh-games` / `games-empty`.

- [ ] **Step 1: Write the failing test (rewrite the spec file)**

Replace the entire contents of `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx` with:

```tsx
// studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
// The board is bound to the workspace's active game (set by the route). It no
// longer offers any game selection/creation UI.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState } from './state';
import { AssetBoardPane } from './AssetBoardPane';

vi.mock('./actions', () => ({
  createAsset: vi.fn(),
}));

const fakeProps = {} as Parameters<typeof AssetBoardPane>[0];

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  window.__renderCounts = {};
});

describe('AssetBoardPane', () => {
  it('renders no game-management UI', () => {
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.queryByTestId('game-select')).toBeNull();
    expect(screen.queryByTestId('new-game')).toBeNull();
    expect(screen.queryByTestId('refresh-games')).toBeNull();
    expect(screen.queryByTestId('games-empty')).toBeNull();
  });

  it('renders the new-asset form and empty hint for the active game with no assets', () => {
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.getByTestId('new-asset-form')).toBeTruthy();
    expect(screen.getByTestId('assets-empty')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/assets/AssetBoardPane.spec.tsx`
Expected: FAIL — `game-select` (etc.) still in the DOM.

- [ ] **Step 3: Write minimal implementation**

Replace the entire contents of `studio/frontend/src/plugins/assets/AssetBoardPane.tsx` with:

```tsx
// studio/frontend/src/plugins/assets/AssetBoardPane.tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { assetsHooks } from './state';
import type { Workflow } from './state';
import { createAsset } from './actions';
import { AssetCard } from './AssetCard';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';

const WORKFLOWS: Workflow[] = ['schnell-opaque', 'schnell-transparent', 'dev-transparent'];

export function AssetBoardPane(_props: IDockviewPanelProps) {
  const s = assetsHooks.usePluginState();
  const activeGameId = s.activeGameId.get();
  // Subscribe only to the COUNT so adding/removing assets re-renders the grid, but a
  // progress tick (which mutates one asset node) does not re-render the board shell.
  const assetCount = s.assets.length;
  bumpRenderCount('AssetBoardPane');

  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>('schnell-transparent');

  if (!activeGameId) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground" data-testid="board-no-game">
        Opening game…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3" data-testid="asset-board">
      <Card>
        <CardContent className="pt-4">
          <form
            className="flex flex-wrap items-center gap-2"
            data-testid="new-asset-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim() || !prompt.trim()) return;
              void createAsset({ name, prompt, width: 1024, height: 1024, workflow });
              setName('');
              setPrompt('');
            }}
          >
            <Input data-testid="asset-name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input data-testid="asset-prompt" placeholder="Prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            <Select data-testid="asset-workflow" value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
              {WORKFLOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </Select>
            <Button type="submit">Add asset</Button>
          </form>
        </CardContent>
      </Card>

      {assetCount === 0 && (
        <p className="text-sm text-muted-foreground" data-testid="assets-empty">
          No assets yet — add your first asset above, then press Generate.
        </p>
      )}

      <div className="flex flex-wrap gap-3" data-testid="asset-grid">
        {Array.from({ length: assetCount }, (_, i) => (
          <AssetCard key={i} index={i} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/plugins/assets/AssetBoardPane.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetBoardPane.tsx studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
git commit -m "feat(assets): bind asset board to the workspace game; drop game picker UI"
```

---

### Task 4: `ImageLightbox` component

**Files:**

- Create: `studio/frontend/src/plugins/assets/ImageLightbox.tsx`
- Test: `studio/frontend/src/plugins/assets/ImageLightbox.spec.tsx`

**Interfaces:**

- Consumes: `Dialog`, `DialogContent` from `@/components/ui/dialog`; `DialogPrimitive.Title` from `@radix-ui/react-dialog` (for an accessible, visually-hidden title).
- Produces: `export function ImageLightbox(props: IImageLightboxProps)` where
  `interface IImageLightboxProps { src: string; alt: string; open: boolean; onOpenChange(open: boolean): void; }`.
  When `open`, renders `<img data-testid="image-lightbox-img" src alt />` inside a dialog with `data-testid="image-lightbox"`. Consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `studio/frontend/src/plugins/assets/ImageLightbox.spec.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImageLightbox } from './ImageLightbox';

describe('ImageLightbox', () => {
  it('renders the full image when open', () => {
    render(<ImageLightbox src="/media/g1/a1/gen1.png" alt="Wild" open onOpenChange={vi.fn()} />);
    const img = screen.getByTestId('image-lightbox-img') as HTMLImageElement;
    expect(img.src).toContain('/media/g1/a1/gen1.png');
    expect(img.alt).toBe('Wild');
  });

  it('renders nothing when closed', () => {
    render(<ImageLightbox src="/x.png" alt="x" open={false} onOpenChange={vi.fn()} />);
    expect(screen.queryByTestId('image-lightbox-img')).toBeNull();
  });

  it('calls onOpenChange(false) when Escape is pressed', () => {
    const onOpenChange = vi.fn();
    render(<ImageLightbox src="/x.png" alt="x" open onOpenChange={onOpenChange} />);
    fireEvent.keyDown(screen.getByTestId('image-lightbox-img'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/assets/ImageLightbox.spec.tsx`
Expected: FAIL — cannot resolve `./ImageLightbox`.

- [ ] **Step 3: Write minimal implementation**

Create `studio/frontend/src/plugins/assets/ImageLightbox.tsx`:

```tsx
// studio/frontend/src/plugins/assets/ImageLightbox.tsx
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Dialog, DialogContent } from '@/components/ui/dialog';

export interface IImageLightboxProps {
  src: string;
  alt: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

// A full-size, in-app viewer for a generated image. Built on the shared Dialog so
// it inherits Esc / backdrop-click / close-button dismissal for free.
export function ImageLightbox({ src, alt, open, onOpenChange }: IImageLightboxProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="image-lightbox" className="flex max-w-[90vw] items-center justify-center bg-background/95 p-2 sm:max-w-[90vw]">
        <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
        <img data-testid="image-lightbox-img" src={src} alt={alt} className="max-h-[85vh] max-w-full object-contain" />
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/plugins/assets/ImageLightbox.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/ImageLightbox.tsx studio/frontend/src/plugins/assets/ImageLightbox.spec.tsx
git commit -m "feat(assets): add ImageLightbox full-size image viewer"
```

---

### Task 5: Wire the lightbox into the `AssetCard` preview

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetCard.tsx`
- Test: `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`

**Interfaces:**

- Consumes: `ImageLightbox` from `./ImageLightbox` (Task 4); existing `selected.imageRef`, `BACKEND_URL`.
- Produces: clicking the `asset-selected-image` preview opens `image-lightbox`; candidate thumbnails still call `selectGeneration` and do not open the lightbox.

- [ ] **Step 1: Write the failing test**

Add to `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`. First extend the actions mock at the top so `selectGeneration` is observable:

```ts
// (the existing vi.mock('./actions', …) already mocks selectGeneration with vi.fn();
//  import it to assert calls)
import { selectGeneration } from './actions';
import { fireEvent } from '@testing-library/react';
```

Then add tests inside `describe('AssetCard', …)`:

```ts
it('opens the full-size lightbox when the selected preview is clicked', () => {
  assetsSlice().assets.set([
    mk({
      status: 'done',
      generations: [{ id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' }],
      selectedGenerationId: 'gen1',
      progress: null,
    }),
  ]);
  render(<AssetCard index={0} />);
  expect(screen.queryByTestId('image-lightbox')).toBeNull();
  fireEvent.click(screen.getByTestId('asset-selected-image'));
  const img = screen.getByTestId('image-lightbox-img') as HTMLImageElement;
  expect(img.src).toContain('/media/g1/a1/gen1.png');
});

it('clicking a candidate thumbnail selects it and does not open the lightbox', () => {
  assetsSlice().assets.set([
    mk({
      status: 'done',
      generations: [
        { id: 'gen1', seed: 1, imageRef: '/media/g1/a1/gen1.png', createdAt: '' },
        { id: 'gen2', seed: 2, imageRef: '/media/g1/a1/gen2.png', createdAt: '' },
      ],
      selectedGenerationId: 'gen1',
      progress: null,
    }),
  ]);
  render(<AssetCard index={0} />);
  const thumb = screen.getByTestId('asset-candidates').querySelectorAll('img')[1];
  fireEvent.click(thumb);
  expect(selectGeneration).toHaveBeenCalledWith('a1', 'gen2');
  expect(screen.queryByTestId('image-lightbox')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx nx test frontend -- src/plugins/assets/AssetCard.spec.tsx`
Expected: FAIL — no `image-lightbox` appears on preview click.

- [ ] **Step 3: Write minimal implementation**

Edit `studio/frontend/src/plugins/assets/AssetCard.tsx`. Add imports:

```ts
import { useState } from 'react';
import { ImageLightbox } from './ImageLightbox';
```

Add lightbox state inside the component (near the other hooks):

```ts
const [zoomed, setZoomed] = useState(false);
```

Make the preview clickable — replace the existing selected-preview block:

```tsx
{
  selected && (
    <div className="flex h-32 w-full items-center justify-center overflow-hidden rounded-md bg-muted">
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
  );
}
```

Render the lightbox once (just before the closing `</Card>`), using the selected image:

```tsx
{
  selected && <ImageLightbox src={`${BACKEND_URL}${selected.imageRef}`} alt={a.name.get()} open={zoomed} onOpenChange={setZoomed} />;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx nx test frontend -- src/plugins/assets/AssetCard.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/assets/AssetCard.spec.tsx
git commit -m "feat(assets): open full-size viewer when the asset preview is clicked"
```

---

### Task 6: Remove now-dead game-list code

The board no longer reads the games list, `initAssets` no longer calls `loadGames`, and nothing creates games from the client (the backend auto-creates a game per room). Remove the dead surface so the codebase stays honest.

**Files:**

- Modify: `studio/frontend/src/plugins/assets/actions.ts` (remove `loadGames`, `createGame`)
- Modify: `studio/frontend/src/plugins/assets/state.ts` (remove `games`, `gamesStatus`)
- Modify: `studio/frontend/src/plugins/assets/restClient.ts` (remove `getGames`, `createGame` if unused)
- Modify: `studio/frontend/src/plugins/assets/actions.spec.ts` (remove the `createGame` test; drop `getGames`/`createGame` from `__setDeps` `rest` objects)
- (`index.spec.ts` is a pure manifest test — confirmed it does NOT reference `loadGames`/games, so it needs no change.)

- [ ] **Step 1: Verify the current usages before deleting**

Run (from repo root): `grep -rnE "loadGames|createGame|getGames|\\.games\\b|gamesStatus|IGame" studio/frontend/src --include=*.ts --include=*.tsx`
Expected: matches only in the assets plugin files listed above (plus their specs). If a match appears elsewhere, STOP and reconsider — that consumer must be handled first.

- [ ] **Step 2: Remove `loadGames` and `createGame` from `actions.ts`**

Delete the `loadGames` function and the `createGame` function. Remove `getGames` and `createGame` from the `IRestDeps` interface and from the `realRest` default. Remove the now-unused `IGame` import if present. Keep `getAssets`, `createAsset`, `updateAsset`, `deleteAsset`, `selectGeneration`.

- [ ] **Step 3: Remove `games` / `gamesStatus` from `state.ts`**

In `IAssetsState`, delete the `games: IGame[]` and `gamesStatus: 'idle' | 'loading' | 'error'` fields. In `makeInitialState()`, delete the `games: []` and `gamesStatus: 'idle'` initializers. Keep the `IGame` interface only if `restClient`/other code still references it; otherwise remove it too. (`IAsset.gameId` is a `string`, not `IGame`, so it does not block removal.)

- [ ] **Step 4: Remove dead rest methods**

In `restClient.ts`, delete `getGames` and `createGame` (and any `IGame` import that becomes unused). Leave `getAssets`/`createAsset`/`updateAsset`/`deleteAsset`/`selectGeneration`.

- [ ] **Step 5: Fix the specs**

In `actions.spec.ts`: delete the `createGame creates, appends to games, and selects it` test; remove `getGames` and `createGame` keys from every `__setDeps({ rest: { … } })` object; remove the `type IGame` import if unused. (`index.spec.ts` needs no change — it only asserts the plugin manifest.)

- [ ] **Step 6: Run the full frontend gates**

Run (from `studio/frontend`):

```
npx prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```

Expected: all four PASS. Typecheck is the key signal that no dangling reference to the removed symbols remains.

- [ ] **Step 7: Commit**

```bash
git add studio/frontend/src/plugins/assets
git commit -m "refactor(assets): remove dead client-side game-list code"
```

---

### Task 7: Update the Playwright e2e suite to the bound-game model

The e2e suite is the authoritative behavioral contract. The old helpers
(`selectGameOnBoard`, `createGameOnBoard`) and the `game-select`/`new-game`
flows no longer exist; entering a room now binds the board to that room's game
directly. Update the specs and add coverage for the lightbox.

**Files:**

- Modify: `studio/frontend/e2e/assets.spec.ts`

- [ ] **Step 1: Replace the game-selection helpers**

Delete `selectGameOnBoard` and `createGameOnBoard`. The board is bound on room
entry, so after `createGameViaRoom` the new-asset form is immediately usable. Keep
`openApp`, `createGameViaRoom`, `addAsset`, `addAssetNamed`. Update every test body
that called `selectGameOnBoard(page, name)` / `createGameOnBoard(page, game)` to
simply drop that line (the room entry already bound the game). For the second
client in the shared-game test, after entering the room, wait for the board:
`await expect(b.getByTestId('asset-board')).toBeVisible();` then proceed.

- [ ] **Step 2: Remove obsolete tests/assertions**

Delete the `self-contained journey: create a game on the board…` test and the
`new-game` empty-state assertion (`await expect(page.getByTestId('new-game')).toBeVisible()`),
since on-board game creation is gone. Fold any still-valuable assertions (e.g. the
Generate-control discoverability checks) into the primary
`author a game asset and generate it with live progress` test if not already covered there.

- [ ] **Step 3: Add the lightbox e2e test**

Append to `studio/frontend/e2e/assets.spec.ts`:

```ts
test('clicking a generated preview opens a full-size viewer', async ({ page }) => {
  const name = `Zoom ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  await addAsset(page);

  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // Open the lightbox.
  await page.getByTestId('asset-selected-image').click();
  await expect(page.getByTestId('image-lightbox-img')).toBeVisible();

  // Esc closes it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('image-lightbox-img')).toBeHidden();

  // A candidate thumbnail still SELECTS (does not open the viewer).
  await page.getByTestId('asset-generate').click();
  await expect(async () => {
    const thumbs = await page.getByTestId('asset-candidates').locator('img').count();
    expect(thumbs).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('asset-candidates').locator('img').first().click();
  await expect(page.getByTestId('image-lightbox-img')).toBeHidden();
});
```

- [ ] **Step 4: Run the e2e suite locally (replay backend)**

In one terminal: `just backend-serve-replay`
In another (from `studio/frontend`): `just e2e`
Expected: the assets specs PASS. (Playwright is never run in CI; this is the local gate.)

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/assets.spec.ts
git commit -m "test(assets): e2e for bound-game board + full-size image viewer"
```

---

## Final verification (whole branch)

- [ ] From `studio/frontend`, run all four gates green: `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`.
- [ ] With `just backend-serve-replay` running, `just e2e` passes the assets specs.
- [ ] Manual smoke (live): `just backend-serve` + `just serve-frontend`, open a room from another LAN machine, confirm the board shows that room's game with no picker, generate an image, click it to view full size, Esc to close.
- [ ] Open a PR: `gh pr create` then `gh pr merge --squash --delete-branch`.

## Self-review notes (author)

- **Spec coverage:** workspace-game binding (Tasks 2–3), `closeGame()` on exit (Tasks 1–2), drop selector/new-game/refresh/empty-state + no label (Task 3), full-size viewer on preview click with thumbnails unchanged (Tasks 4–5), dead-code cleanup (Task 6), authoritative e2e (Task 7). All spec sections map to a task.
- **No placeholders:** every code/edit step shows concrete code or exact deletions.
- **Type consistency:** `closeGame()`/`openGame(gameId)` names match across Tasks 1, 2, 6; `IImageLightboxProps` (`src`/`alt`/`open`/`onOpenChange`) is defined in Task 4 and consumed verbatim in Task 5; test ids `image-lightbox` / `image-lightbox-img` are consistent across Tasks 4, 5, 7.

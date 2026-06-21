# Asset Board Premium UX + E2E Validation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Asset Board generate images through a discoverable, premium UI, and lock that behaviour with an exhaustive e2e suite that asserts the human contract (controls visible/enabled/in-viewport, a real image rendered, coherent empty/loading/error states).

**Architecture:** Add a tiny `POST /games` endpoint so the board is self-contained; rebuild `AssetBoardPane` and `AssetCard` on the design system the app already owns (CSS-variable tokens + `components/ui`), introducing thin `Card`/`Input` primitives; drive a deterministic error path through the existing `ReplayComfyProvider`; expand `assets.spec.ts` as the source-of-truth behavioural contract, run replay-primary with a live tier on demand.

**Tech Stack:** FastAPI + Pydantic + Motor (backend), pytest/httpx (backend tests), React + Hookstate + Tailwind v4 + shadcn-style components (frontend), Vitest (frontend unit), Playwright (e2e), Socket.IO (realtime), ComfyUI (image generation).

## Global Constraints

- TypeScript interfaces use an `I` prefix (`IGame`, `IAsset`, `IButtonProps`). (`docs/coding-standards.md`)
- Conventional Commits for every commit (`feat:`, `fix:`, `test:`, `docs:`). Imperative mood, ~50-char subject.
- TDD mandatory: failing test first, watch it fail, minimal code to pass, refactor.
- Browser e2e (Playwright) is **never** run in CI — local only (`just e2e`). Backend pytest and frontend unit are CI-affordable and must stay green.
- E2e requires a backend on `:8000`; replay is the dev loop (`just backend-serve-replay`, `PROVIDER_MODE=replay`). Live tier is on-demand (`just e2e-live`, real ComfyUI on `:8188`).
- Preserve all existing `data-testid` values; new testids only add.
- Style with design tokens only (`bg-background`, `text-foreground`, `bg-primary`, `bg-muted`, `border-border`, `border-input`, `text-muted-foreground`, `ring`) — no hard-coded hex except the existing red error accent.
- `main` is protected; land via branch + PR. Work on branch `feat/asset-board-premium-ux` (already created).
- Notifications go through the existing seam `@/lib/notify` (`notify.error/info`); `<Toaster/>` is already mounted in `main.tsx`.

---

## File Structure

**Backend**

- Modify `studio/backend/app/assets/rest.py` — add `CreateGameBody` + `POST /games` (Task 1).
- Modify `studio/backend/app/assets/comfy.py` — `ReplayComfyProvider` sentinel error path (Task 7).
- Modify `studio/backend/tests/test_assets_rest.py` — `POST /games` tests (Task 1).
- Modify `studio/backend/tests/test_comfy.py` — sentinel-error test (Task 7).

**Frontend data layer**

- Modify `studio/frontend/src/plugins/assets/restClient.ts` — `createGame()` (Task 3).
- Modify `studio/frontend/src/plugins/assets/actions.ts` — `IRestDeps.createGame` + `createGame()` action (Task 3).
- Modify `studio/frontend/src/plugins/assets/actions.spec.ts` — deps + new test (Task 3).

**Frontend UI**

- Create `studio/frontend/src/components/ui/card.tsx` (Task 4).
- Create `studio/frontend/src/components/ui/input.tsx` (Task 4).
- Create `studio/frontend/src/components/ui/card.spec.tsx`, `input.spec.tsx` (Task 4).
- Rewrite `studio/frontend/src/plugins/assets/AssetBoardPane.tsx` (Task 5).
- Rewrite `studio/frontend/src/plugins/assets/AssetCard.tsx` (Task 6).
- Adjust `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx`, `AssetCard.spec.tsx` (Tasks 5–6).

**E2e**

- Modify `studio/frontend/e2e/assets.spec.ts` — RED discoverability test (Task 2), then journey/candidates/error + selector alignment (Task 8).

---

## Task 1: Backend `POST /games` endpoint

**Files:**

- Modify: `studio/backend/app/assets/rest.py`
- Test: `studio/backend/tests/test_assets_rest.py`

**Interfaces:**

- Consumes: `request.app.state.game_store.create_game(name: str) -> Game` (exists in `app/games.py`), `game_wire(game) -> dict` (exists).
- Produces: `POST /games` accepting `{"name": str}` → `201` + `game_wire` dict; blank/whitespace name → `422`.

- [ ] **Step 1: Write the failing tests** — append to `studio/backend/tests/test_assets_rest.py`:

```python
@pytest.mark.asyncio
async def test_create_game_endpoint(mongo_db):
    app = _app(mongo_db)
    async with _client(app) as client:
        resp = await client.post("/games", json={"name": "Neon Slots"})
        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Neon Slots"
        assert body["id"]
        listed = await client.get("/games")
        assert [g["id"] for g in listed.json()] == [body["id"]]


@pytest.mark.asyncio
async def test_create_game_rejects_blank_name(mongo_db):
    app = _app(mongo_db)
    async with _client(app) as client:
        resp = await client.post("/games", json={"name": "   "})
        assert resp.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/backend && uv run --directory . pytest tests/test_assets_rest.py::test_create_game_endpoint tests/test_assets_rest.py::test_create_game_rejects_blank_name -v`
Expected: FAIL — `404 != 201` (route missing).

- [ ] **Step 3: Implement the route** — in `studio/backend/app/assets/rest.py`, change the import line to include `field_validator`, and add the body model + route. Update the top import:

```python
from pydantic import BaseModel, ConfigDict, field_validator
```

Add after the `SelectBody` class:

```python
class CreateGameBody(BaseModel):
    name: str

    @field_validator("name")
    @classmethod
    def _name_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be blank")
        return v.strip()
```

Add a route directly under the existing `@router.get("/games")` handler:

```python
@router.post("/games", status_code=201)
async def create_game(body: CreateGameBody, request: Request) -> dict:
    game = await request.app.state.game_store.create_game(body.name)
    return game_wire(game)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/backend && uv run --directory . pytest tests/test_assets_rest.py -v`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/rest.py studio/backend/tests/test_assets_rest.py
git commit -m "feat(assets): add POST /games endpoint"
```

---

## Task 2: RED diagnostic — assert the Generate control is discoverable

This task captures the failure that motivates the whole effort: it adds a test that asserts the human contract against the **current** UI and runs it to watch it fail. The same test goes green once `AssetCard` is rebuilt (Task 6). Browser e2e is not in CI, so a temporarily-red spec gates nothing.

**Files:**

- Modify: `studio/frontend/e2e/assets.spec.ts`

**Interfaces:**

- Consumes: existing local helpers `openApp`, `createGameViaRoom`, `selectGameOnBoard`, `addAsset` (already in the file).
- Produces: a `test('the Generate control is visible and usable …')` asserting `toBeVisible` + `toBeEnabled` + `toBeInViewport` on the Generate button.

- [ ] **Step 1: Start a replay backend and the frontend** (needed to run e2e)

Run (backend, background): `cd studio/backend && uv run --directory . just backend-serve-replay`
Run (frontend, background): `cd studio/frontend && npx nx serve frontend`
Confirm: `curl -s http://localhost:8000/health` returns JSON with `"providerMode":"replay"`.

- [ ] **Step 2: Write the discoverability test** — append to `studio/frontend/e2e/assets.spec.ts`:

```typescript
// RED diagnostic (added in Task 2): asserts the *human* contract — the Generate
// control must be visible, enabled, and in the viewport, not merely present in the
// DOM. Expected to FAIL against the un-redesigned card; turns green after the
// AssetCard redesign (Task 6).
test('the Generate control is visible and usable on an asset card', async ({ page }) => {
  const name = `Discover ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  await selectGameOnBoard(page, name);
  await addAsset(page);

  const gen = page.getByRole('button', { name: 'Generate' });
  await expect(gen).toBeVisible();
  await expect(gen).toBeEnabled();
  await expect(gen).toBeInViewport();
});
```

- [ ] **Step 3: Run it and record the failure mode**

Run: `cd studio/frontend && npx playwright test assets.spec.ts -g "Generate control is visible"`
Expected: FAIL. Record which assertion fails — `getByRole(... 'Generate')` not found (button absent from DOM) vs `toBeInViewport` false (present but off-screen/clipped). This observation is the deliverable: it tells us whether the screenshot symptom is "not rendered" or "not visible," and the redesign in Task 6 addresses the confirmed cause.

- [ ] **Step 4: Commit the RED test with the observation**

```bash
git add studio/frontend/e2e/assets.spec.ts
git commit -m "test(assets): add discoverability assertion for Generate (RED)"
```

Include the observed failure mode in the commit body.

---

## Task 3: Frontend `createGame` (restClient + action)

**Files:**

- Modify: `studio/frontend/src/plugins/assets/restClient.ts`
- Modify: `studio/frontend/src/plugins/assets/actions.ts`
- Test: `studio/frontend/src/plugins/assets/actions.spec.ts`

**Interfaces:**

- Consumes: `okJson`, `BACKEND_URL`, `IGame` (existing); `openGame(gameId)` (existing action) for auto-select.
- Produces: `createGame(name: string): Promise<IGame>` (restClient); `createGame(name: string): Promise<void>` (action) that POSTs, appends the game to `games`, and selects it; `IRestDeps` gains `createGame: typeof realRest.createGame`.

- [ ] **Step 1: Write the failing test** — in `studio/frontend/src/plugins/assets/actions.spec.ts`, add `createGame: vi.fn(),` to the `rest` object of **each existing test** (3 occurrences) so the type stays satisfied, then add this test inside the `describe` block:

```typescript
it('createGame creates, appends to games, and selects it', async () => {
  const created = { id: 'g2', name: 'New', createdAt: 't' };
  actions.__setDeps({
    rest: {
      getGames: vi.fn(),
      getAssets: vi.fn().mockResolvedValue([]),
      createGame: vi.fn().mockResolvedValue(created),
      createAsset: vi.fn(),
      updateAsset: vi.fn(),
      deleteAsset: vi.fn(),
      selectGeneration: vi.fn(),
    },
    socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame: vi.fn(), generateAsset: vi.fn() },
  });
  await actions.createGame('New');
  expect(
    assetsSlice()
      .games.get({ noproxy: true })
      .map((g) => g.id),
  ).toContain('g2');
  expect(assetsSlice().activeGameId.get()).toBe('g2');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/actions.spec.ts`
Expected: FAIL — `actions.createGame is not a function` (and TS error on `createGame` in deps until Step 3).

- [ ] **Step 3a: Add the restClient call** — append to `studio/frontend/src/plugins/assets/restClient.ts`:

```typescript
export async function createGame(name: string): Promise<IGame> {
  return okJson<IGame>(
    await fetch(`${BACKEND_URL}/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),
  );
}
```

- [ ] **Step 3b: Wire the action** — in `studio/frontend/src/plugins/assets/actions.ts`:

Extend the state import to include `IGame`:

```typescript
import { assetsSlice, type IAsset, type IGame } from './state';
```

Add `createGame` to `IRestDeps` (after `getAssets`):

```typescript
createGame: typeof realRest.createGame;
```

Add the action (place it above `createAsset`):

```typescript
export async function createGame(name: string): Promise<void> {
  const created = await rest.createGame(name);
  const s = assetsSlice();
  s.games.set([...(s.games.get({ noproxy: true }) as IGame[]), created]);
  await openGame(created.id);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/actions.spec.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/restClient.ts studio/frontend/src/plugins/assets/actions.ts studio/frontend/src/plugins/assets/actions.spec.ts
git commit -m "feat(assets): add createGame action and rest client"
```

---

## Task 4: Shared UI primitives — `Card` and `Input`

**Files:**

- Create: `studio/frontend/src/components/ui/card.tsx`
- Create: `studio/frontend/src/components/ui/input.tsx`
- Test: `studio/frontend/src/components/ui/card.spec.tsx`
- Test: `studio/frontend/src/components/ui/input.spec.tsx`

**Interfaces:**

- Consumes: `cn` from `@/lib/utils` (exists).
- Produces: `Card`, `CardHeader`, `CardContent`, `CardFooter` (div wrappers, token-styled); `Input` (forwardRef `<input>`, token-styled). All accept and merge `className` and forward native props.

- [ ] **Step 1: Write the failing tests**

`studio/frontend/src/components/ui/card.spec.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Card, CardHeader, CardContent, CardFooter } from './card';

describe('Card', () => {
  it('renders children and merges className', () => {
    const { getByText, container } = render(
      <Card className="extra">
        <CardHeader>H</CardHeader>
        <CardContent>C</CardContent>
        <CardFooter>F</CardFooter>
      </Card>,
    );
    expect(getByText('H')).toBeTruthy();
    expect(getByText('C')).toBeTruthy();
    expect(getByText('F')).toBeTruthy();
    expect(container.querySelector('.extra')).toBeTruthy();
  });
});
```

`studio/frontend/src/components/ui/input.spec.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Input } from './input';

describe('Input', () => {
  it('renders an input and forwards props + className', () => {
    const { getByPlaceholderText } = render(<Input placeholder="Name" className="extra" />);
    const el = getByPlaceholderText('Name') as HTMLInputElement;
    expect(el.tagName).toBe('INPUT');
    expect(el.classList.contains('extra')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/frontend && npx vitest run src/components/ui/card.spec.tsx src/components/ui/input.spec.tsx`
Expected: FAIL — cannot resolve `./card` / `./input`.

- [ ] **Step 3: Implement the components**

`studio/frontend/src/components/ui/card.tsx`:

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-background shadow-sm', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-4', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-4 pt-0', className)} {...props} />;
}
```

`studio/frontend/src/components/ui/input.tsx`:

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-9 rounded-md border border-input bg-background px-3 py-1 text-sm outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/components/ui/card.spec.tsx src/components/ui/input.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/components/ui/card.tsx studio/frontend/src/components/ui/input.tsx studio/frontend/src/components/ui/card.spec.tsx studio/frontend/src/components/ui/input.spec.tsx
git commit -m "feat(ui): add Card and Input primitives"
```

---

## Task 5: Redesign `AssetBoardPane` (empty state, inline New Game, styled form)

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`
- Test: `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx`

**Interfaces:**

- Consumes: `assetsHooks`, `IGame`, `Workflow`, `openGame`, `createAsset`, `createGame`, `loadGames`, `AssetCard`, `bumpRenderCount`, `Button`, `Input`, `Card`, `CardContent`, `notify`.
- Produces: a board that renders a centered empty state with `data-testid="new-game"` when there are no games; an inline New Game row (`new-game-name`, `new-game-submit`); the styled new-asset form (existing testids `new-asset-form`, `asset-name`, `asset-prompt`, `asset-workflow`); `game-select`, `refresh-games` preserved; an `assets-empty` hint; the asset grid. Subscribes only to `s.assets.length` (render discipline preserved).

- [ ] **Step 1: Add the failing test** — open `studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx`, keep its existing test(s), and add:

```tsx
it('shows the empty state with a New Game button when there are no games', () => {
  // assumes the spec already resets the plugin state to makeInitialState() in a
  // beforeEach (games: []). If not, set it: assetsSlice().games.set([]).
  const { getByTestId } = render(<AssetBoardPane {...({} as never)} />);
  expect(getByTestId('games-empty')).toBeTruthy();
  expect(getByTestId('new-game')).toBeTruthy();
});
```

If the existing spec lacks the imports/reset used here, mirror the setup already present in `AssetBoardPane.spec.tsx` (it renders `<AssetBoardPane>` and manipulates `assetsSlice()`); reuse those exact imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/AssetBoardPane.spec.tsx`
Expected: FAIL — no `games-empty` / `new-game` testid yet.

- [ ] **Step 3: Rewrite the pane** — replace the entire contents of `studio/frontend/src/plugins/assets/AssetBoardPane.tsx` with:

```tsx
// studio/frontend/src/plugins/assets/AssetBoardPane.tsx
import { useState } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { assetsHooks } from './state';
import type { IGame, Workflow } from './state';
import { openGame, createAsset, createGame, loadGames } from './actions';
import { AssetCard } from './AssetCard';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { notify } from '@/lib/notify';

const WORKFLOWS: Workflow[] = ['schnell-opaque', 'schnell-transparent', 'dev-transparent'];
const selectClass = 'rounded-md border border-input bg-background px-2 py-1 text-sm';

export function AssetBoardPane(_props: IDockviewPanelProps) {
  const s = assetsHooks.usePluginState();
  const games = s.games.get({ noproxy: true }) as IGame[];
  const activeGameId = s.activeGameId.get();
  // Subscribe only to the COUNT so adding/removing assets re-renders the grid, but a
  // progress tick (which mutates one asset node) does not re-render the board shell.
  const assetCount = s.assets.length;
  bumpRenderCount('AssetBoardPane');

  const [creating, setCreating] = useState(false);
  const [gameName, setGameName] = useState('');
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [workflow, setWorkflow] = useState<Workflow>('schnell-transparent');

  async function submitNewGame() {
    const n = gameName.trim();
    if (!n) return;
    try {
      await createGame(n);
      setGameName('');
      setCreating(false);
    } catch {
      notify.error('Could not create game');
    }
  }

  const newGameRow = (
    <div className="flex items-center gap-2" data-testid="new-game-row">
      <Input
        data-testid="new-game-name"
        placeholder="Game name"
        value={gameName}
        onChange={(e) => setGameName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submitNewGame();
        }}
      />
      <Button data-testid="new-game-submit" onClick={() => void submitNewGame()}>
        Create game
      </Button>
      {games.length > 0 && (
        <Button variant="outline" onClick={() => setCreating(false)}>
          Cancel
        </Button>
      )}
    </div>
  );

  if (games.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center" data-testid="games-empty">
        <div>
          <h2 className="text-lg font-semibold">No games yet</h2>
          <p className="text-sm text-muted-foreground">Create a game to start generating assets.</p>
        </div>
        {creating ? (
          newGameRow
        ) : (
          <Button data-testid="new-game" onClick={() => setCreating(true)}>
            + New Game
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3" data-testid="asset-board">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm">
          Game:{' '}
          <select data-testid="game-select" className={selectClass} value={activeGameId ?? ''} onChange={(e) => void openGame(e.target.value)}>
            <option value="" disabled>
              Select a game…
            </option>
            {games.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        {creating ? (
          newGameRow
        ) : (
          <Button data-testid="new-game" variant="outline" onClick={() => setCreating(true)}>
            + New Game
          </Button>
        )}
        <Button data-testid="refresh-games" variant="outline" onClick={() => void loadGames()}>
          ↻ Refresh
        </Button>
      </div>

      {activeGameId && (
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
              <select data-testid="asset-workflow" className={selectClass} value={workflow} onChange={(e) => setWorkflow(e.target.value as Workflow)}>
                {WORKFLOWS.map((w) => (
                  <option key={w} value={w}>
                    {w}
                  </option>
                ))}
              </select>
              <Button type="submit">Add asset</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {activeGameId && assetCount === 0 && (
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

- [ ] **Step 4: Run tests to verify they pass** — and confirm the pre-existing pane tests (game-select option rendering) still pass against the new markup; the `game-select` testid and option list are preserved, so they should. If a prior assertion targeted removed inline-style text, update it to assert the testid/option instead.

Run: `cd studio/frontend && npx vitest run src/plugins/assets/AssetBoardPane.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetBoardPane.tsx studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
git commit -m "feat(assets): premium Asset Board with inline New Game and empty state"
```

---

## Task 6: Redesign `AssetCard` (prominent Generate + styled states)

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetCard.tsx`
- Test: `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`

**Interfaces:**

- Consumes: `assetsHooks`, `IGeneration`, `BACKEND_URL`, `generateAsset`, `deleteAsset`, `selectGeneration`, `bumpRenderCount`, `Button`, `Card`/`CardHeader`/`CardContent`/`CardFooter`.
- Produces: a card that always renders a Generate button at `data-testid="asset-generate"` (label "Generate" when no generations, "Generate again" otherwise), disabled while `queued`/`generating`; preserves testids `asset-card-{id}`, `asset-selected-image`, `asset-progress`, `asset-queued`, `asset-error`, `asset-candidates`. Keeps the scoped-subscription render discipline.

- [ ] **Step 1: Add the failing test** — open `studio/frontend/src/plugins/assets/AssetCard.spec.tsx`, keep its existing render-discipline test, and add:

```tsx
it('always renders a visible, enabled Generate button for an idle asset', () => {
  // Reuse the spec's existing setup that seeds one asset into assetsSlice() and
  // renders <AssetCard index={0} />. Add to that arrangement:
  const { getByTestId } = render(<AssetCard index={0} />);
  const gen = getByTestId('asset-generate') as HTMLButtonElement;
  expect(gen).toBeTruthy();
  expect(gen.disabled).toBe(false);
  expect(gen.textContent).toContain('Generate');
});
```

Mirror the existing spec's imports and asset-seeding (it already renders `AssetCard` against a seeded asset for the render-count test); use that same arrangement so `index={0}` resolves.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/plugins/assets/AssetCard.spec.tsx`
Expected: FAIL — no `asset-generate` testid yet.

- [ ] **Step 3: Rewrite the card** — replace the entire contents of `studio/frontend/src/plugins/assets/AssetCard.tsx` with:

```tsx
// studio/frontend/src/plugins/assets/AssetCard.tsx
import { assetsHooks } from './state';
import type { IGeneration } from './state';
import { BACKEND_URL } from './config';
import { generateAsset, deleteAsset, selectGeneration } from './actions';
import { bumpRenderCount } from '../../app/renderCount';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card';

// Subscribes to ITS OWN asset node (s.assets[index]) and reads individual leaves,
// so an asset_progress tick (scoped node write) re-renders only this card.
export function AssetCard({ index }: { index: number }) {
  const s = assetsHooks.usePluginState();
  const a = s.assets[index];
  bumpRenderCount('AssetCard');

  const id = a.id.get();
  const status = a.status.get();
  const generations = a.generations.get() as IGeneration[];
  const selectedId = a.selectedGenerationId.get();
  const progress = a.progress.get();
  const selected = generations.find((g) => g.id === selectedId);
  const busy = status === 'generating' || status === 'queued';

  return (
    <Card data-testid={`asset-card-${id}`} className="w-64">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <strong className="truncate">{a.name.get()}</strong>
          <span className="text-xs text-muted-foreground">{a.workflow.get()}</span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-2">
        <div className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md bg-muted">
          {selected ? (
            <img
              data-testid="asset-selected-image"
              src={`${BACKEND_URL}${selected.imageRef}`}
              alt={a.name.get()}
              width={a.width.get()}
              height={a.height.get()}
              className="h-full w-full object-contain"
            />
          ) : (
            <span className="text-xs text-muted-foreground">{status === 'generating' ? 'Generating…' : status === 'queued' ? 'Queued…' : 'No image yet'}</span>
          )}
        </div>

        {status === 'generating' && progress && <progress data-testid="asset-progress" className="w-full" value={progress.value} max={progress.max} />}
        {status === 'queued' && (
          <span data-testid="asset-queued" className="text-xs text-muted-foreground">
            queued…
          </span>
        )}
        {status === 'error' && (
          <span data-testid="asset-error" className="text-xs text-red-500">
            {a.error.get() ?? 'Generation failed'}
          </span>
        )}

        {generations.length > 0 && (
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

      <CardFooter className="justify-between">
        <Button data-testid="asset-generate" onClick={() => generateAsset(id)} disabled={busy}>
          {generations.length > 0 ? 'Generate again' : 'Generate'}
        </Button>
        <Button variant="outline" onClick={() => void deleteAsset(id)}>
          Delete
        </Button>
      </CardFooter>
    </Card>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass** — both the new test and the existing render-discipline test (scoped subscription is preserved, so a progress tick still re-renders only this card).

Run: `cd studio/frontend && npx vitest run src/plugins/assets/AssetCard.spec.tsx`
Expected: PASS.

- [ ] **Step 5: Verify the RED test from Task 2 is now GREEN**

Run (with replay backend + frontend still serving): `cd studio/frontend && npx playwright test assets.spec.ts -g "Generate control is visible"`
Expected: PASS — Generate is now visible, enabled, and in viewport.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/plugins/assets/AssetCard.tsx studio/frontend/src/plugins/assets/AssetCard.spec.tsx
git commit -m "feat(assets): premium Asset Card with prominent Generate and styled states"
```

---

## Task 7: Deterministic replay error path (sentinel prompt)

**Files:**

- Modify: `studio/backend/app/assets/comfy.py`
- Test: `studio/backend/tests/test_comfy.py`

**Interfaces:**

- Consumes: graph dict shape `graph["6"]["inputs"]["text"]` (the positive prompt node, per `app/assets/graph.py`).
- Produces: `ReplayComfyProvider.generate(graph)` raises `RuntimeError` when the positive prompt normalizes to the sentinel `"force error"`. Used by the e2e error-state test; the running hub already maps a raised exception to asset status `error`.

- [ ] **Step 1: Write the failing test** — append to `studio/backend/tests/test_comfy.py`:

```python
@pytest.mark.asyncio
async def test_replay_raises_on_force_error_prompt():
    provider = ReplayComfyProvider(progress=[(1, 1)], image=b"\x89PNG\r\n\x1a\n")
    graph = {"6": {"inputs": {"text": "Force Error"}}}
    with pytest.raises(RuntimeError):
        async for _ in provider.generate(graph):
            pass
```

If `ReplayComfyProvider` / `pytest` are not already imported in `test_comfy.py`, add `import pytest` and `from app.assets.comfy import ReplayComfyProvider` to match the file's existing import style.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/backend && uv run --directory . pytest tests/test_comfy.py::test_replay_raises_on_force_error_prompt -v`
Expected: FAIL — no exception raised (the generator yields normally).

- [ ] **Step 3: Implement the sentinel** — in `studio/backend/app/assets/comfy.py`, add a module-level constant near the top (after the imports):

```python
FORCE_ERROR_PROMPT = "force error"  # normalized sentinel: an asset with this prompt makes replay raise
```

Then in `ReplayComfyProvider.generate`, immediately after `self._ensure_loaded()`, insert:

```python
        from app.replay.cassette import normalize_prompt
        positive = graph.get("6", {}).get("inputs", {}).get("text", "")
        if normalize_prompt(positive) == FORCE_ERROR_PROMPT:
            raise RuntimeError("forced replay error")
```

(The existing `for value, maximum in self._progress:` loop follows unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/backend && uv run --directory . pytest tests/test_comfy.py -v`
Expected: PASS (all tests in the file, including the existing ones).

- [ ] **Step 5: Commit**

```bash
git add studio/backend/app/assets/comfy.py studio/backend/tests/test_comfy.py
git commit -m "feat(assets): deterministic replay error via sentinel prompt"
```

---

## Task 8: Expand the e2e contract (self-contained journey, candidates, error)

**Files:**

- Modify: `studio/frontend/e2e/assets.spec.ts`

**Interfaces:**

- Consumes: `openApp`, `createGameViaRoom` (reach the workbench), the board testids from Tasks 5–6 (`new-game`, `new-game-name`, `new-game-submit`, `asset-generate`, `asset-error`, `asset-selected-image`, `asset-candidates`).
- Produces: a `createGameOnBoard(page, name)` helper using the inline New Game flow; a self-contained journey test; an error-state test; the existing two tests aligned to the new `asset-generate` testid where the label changes.

- [ ] **Step 1: Add the `createGameOnBoard` helper** — in `studio/frontend/e2e/assets.spec.ts`, add below the existing helpers:

```typescript
// Creates a game via the board's inline New Game flow and waits for it to be selected.
async function createGameOnBoard(page: Page, name: string) {
  await page.getByTestId('new-game').click();
  await page.getByTestId('new-game-name').fill(name);
  await page.getByTestId('new-game-submit').click();
  // createGame auto-selects the new game, so the select takes a non-empty value.
  await expect(page.getByTestId('game-select')).not.toHaveValue('');
}

async function addAssetNamed(page: Page, name: string, prompt: string) {
  await page.getByTestId('asset-name').fill(name);
  await page.getByTestId('asset-prompt').fill(prompt);
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page.getByTestId(/^asset-card-/)).toBeVisible();
}
```

- [ ] **Step 2: Add the self-contained journey test** — append:

```typescript
test('self-contained journey: create a game on the board, add an asset, generate a real image', async ({ page }) => {
  const room = `Journey ${Date.now()}`;
  const game = `Board Game ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room); // reach the workbench (board lives inside it)

  // empty/landing state on the board offers New Game; the game is created + selected inline.
  await expect(page.getByTestId('new-game')).toBeVisible();
  await createGameOnBoard(page, game);
  await addAssetNamed(page, 'Wild', 'a glowing wild symbol');

  // Discoverability: the Generate control is reachable by a human.
  const gen = page.getByTestId('asset-generate');
  await expect(gen).toBeVisible();
  await expect(gen).toBeEnabled();
  await expect(gen).toBeInViewport();

  await gen.click();
  const img = page.getByTestId('asset-selected-image');
  await expect(img).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    const w = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    const h = await img.evaluate((el) => (el as HTMLImageElement).naturalHeight);
    expect(w).toBeGreaterThan(64);
    expect(h).toBeGreaterThan(64);
  }).toPass({ timeout: 30_000 });
  await expect(gen).toBeEnabled(); // re-enabled after completion

  // Second candidate appears in the strip; selecting it keeps an image shown.
  await gen.click();
  await expect(async () => {
    const thumbs = await page.getByTestId('asset-candidates').locator('img').count();
    expect(thumbs).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('asset-candidates').locator('img').first().click();
  await expect(img).toBeVisible();
});
```

- [ ] **Step 3: Add the error-state test** — append:

```typescript
test('a failed generation shows a styled error and stays retryable', async ({ page }) => {
  const room = `Err ${Date.now()}`;
  const game = `Err Game ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room);
  await createGameOnBoard(page, game);
  // The sentinel prompt makes the replay provider raise (Task 7).
  await addAssetNamed(page, 'Broken', 'force error');

  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('asset-generate')).toBeEnabled(); // retryable
});
```

- [ ] **Step 3b: Add the short-pane reachability test** (guards the real symptom found in Task 2: a short pane clipping the Generate control with no scroll). Append:

```typescript
test('the Generate control stays reachable when the pane is short', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 }); // force the board to overflow its panel
  const room = `Short ${Date.now()}`;
  const game = `Short Game ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room);
  await createGameOnBoard(page, game);
  await addAssetNamed(page, 'Wild', 'a glowing wild symbol');

  // The board must scroll the control into view rather than clip it under overflow:hidden.
  // If the pane clips with no scroll, scrollIntoViewIfNeeded cannot reveal it and this fails.
  const gen = page.getByTestId('asset-generate');
  await gen.scrollIntoViewIfNeeded();
  await expect(gen).toBeVisible();
  await expect(gen).toBeInViewport();
});
```

- [ ] **Step 4: Align the existing two tests to the new testid** — in the first test (`author a game asset and generate it…`) and the multi-client test, replace the second-click locator `page.getByRole('button', { name: 'Generate' })` (which becomes "Generate again" after the first generation) with `page.getByTestId('asset-generate')`. The initial click may stay as-is or also switch to the testid for consistency.

- [ ] **Step 5: Run the full replay suite** (replay backend + frontend serving from Task 2)

Run: `cd studio/frontend && npx playwright test assets.spec.ts`
Expected: PASS — all tests green against the replay backend.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/e2e/assets.spec.ts
git commit -m "test(assets): exhaustive e2e for self-contained generate, candidates, and error"
```

---

## Task 9: Whole-branch verification, live-tier parity, and PR

**Files:** none (verification + integration).

- [ ] **Step 1: Frontend CI gates** (all four — vitest green ≠ types valid)

Run: `cd studio/frontend && npx prettier --check . && npx nx typecheck frontend && npx nx test frontend && npx nx build frontend`
Expected: all PASS.

- [ ] **Step 2: Backend suite**

Run: `cd studio/backend && uv run --directory . pytest`
Expected: PASS.

- [ ] **Step 3: Replay e2e (source of truth)**

Run (replay backend up): `cd studio/frontend && npx playwright test assets.spec.ts`
Expected: PASS.

- [ ] **Step 4: Live-tier parity (on-demand)** — honors `[[test-real-parity]]`. Requires real ComfyUI on `:8188`.

Run: `cd studio/backend && uv run --directory . just backend-serve` (live), confirm `/health` shows `"providerMode":"live"`, then `cd studio/frontend && BLOOM_E2E_TIER=live npx playwright test assets.spec.ts`.
Expected: the journey and multi-client tests PASS against real generation. Note: the `force error` sentinel only triggers in replay; the error-state test is replay-only — skip or expect it to generate normally under live (acceptable; the error contract is covered deterministically in replay). If real ComfyUI is unavailable, record that live-tier was not run and why.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/asset-board-premium-ux
gh pr create --title "feat(studio): premium Asset Board + exhaustive ComfyUI e2e" --body "Self-contained Asset Board (inline New Game via POST /games), premium token-styled board + card with a prominent discoverable Generate control, deterministic replay error path, and an exhaustive Playwright contract (journey, candidates, error, multi-client realtime) that asserts the human UX. Closes the test/real-parity gap where the old e2e was green while the running app showed no usable Generate control.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 6: Request review** — use `superpowers:requesting-code-review` for a whole-branch review before merge. Self-merge (squash) once green per repo policy.

---

## Self-Review

**Spec coverage:**

- Exhaustive replay e2e asserting human contract → Tasks 2, 8 (visible/enabled/in-viewport, real image, empty/error states). ✔
- Premium redesign on existing design system → Tasks 4 (primitives), 5 (board), 6 (card). ✔
- `POST /games` + inline New Game → Tasks 1 (backend), 3 (action), 5 (UI). ✔
- Live-tier parity → Task 9 Step 4. ✔
- RED-first diagnostic → Task 2 (run against current app), verified green in Task 6 Step 5. ✔
- Replay error fixture (deterministic, offline, provider seam) → Task 7. ✔
- Empty/loading/generating/done/error states → Task 6 (card states) + Task 5 (board empty/assets-empty). ✔
- Non-goals respected: chat/settings panes untouched; pipeline/protocol unchanged. ✔

**Placeholder scan:** No TBD/TODO; every code step shows full content; commands have expected output. The two "mirror the existing spec's setup" notes (Tasks 5–6) reference concrete, already-present arrangements in those spec files rather than inventing them. ✔

**Type consistency:** `createGame` signatures match across restClient (`Promise<IGame>`), `IRestDeps` (`typeof realRest.createGame`), action (`Promise<void>`), and the spec mock (`mockResolvedValue(created)`). Testids are consistent between producing tasks (5–6) and consuming e2e (8): `new-game`, `new-game-name`, `new-game-submit`, `asset-generate`, `asset-error`, `asset-candidates`, `asset-selected-image`, `game-select`, `refresh-games`. Sentinel `"force error"` matches between Task 7 (provider) and Task 8 (asset prompt). ✔

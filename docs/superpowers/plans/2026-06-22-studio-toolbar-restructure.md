# Studio Toolbar Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Bloom Studio top toolbar into four deliberate, in-language zones — a "b" monogram brand mark, a `Rooms / <name> [Game]` breadcrumb, de-boxed icon menus, and a ghost switch-user control — with no routing/behavior changes.

**Architecture:** Five small presentational pieces (`BrandMark`, `ToolbarDivider`, `RoomContext`, a Button-based `SwitchUser`, de-boxed `Menubar`) composed by a rezoned `Workbench`. `RoomRoute` already fetches the room; it builds `RoomContext` and passes it to `Workbench` through the existing chrome prop (renamed `leading` → `roomContext`). No `activeRoom.ts` change.

**Tech Stack:** React + TypeScript, Tailwind v4 (token utilities only), Radix Menubar, lucide-react icons, react-router-dom, Vitest + Testing Library, Playwright (local e2e), Nx.

## Global Constraints

- **Design language is authoritative** (`docs/design-language.md`): 4 surfaces · 2 hairlines · 3 text tiers · 1 rationed accent. The brand monogram tile is the **only** accent fill in the toolbar; everything else is neutral.
- **No raw colors.** Use only token utilities (`bg-canvas`, `bg-surface`, `bg-raised`, `bg-raised-hover`, `bg-primary`, `text-primary-foreground`, `text-foreground`, `text-muted-foreground`, `text-faint`, `bg-hairline`, `border-border`, `border-border-strong`). No hex/rgba literals outside `styles.css` — enforced by `src/design-language.guard.spec.ts`.
- **TypeScript interfaces use an `I` prefix** (`IRoomContextProps`).
- **Preserve every test contract** (testids + accessible names): `workbench`, `menu-layout`, `menu-view`, `layout-save`, `layout-apply-*`, `layout-delete-*`, `menu-reset-layout`, `view-open-*`; the `Bloom Studio` heading; a `link` named `/rooms/i` with `href="/"`; a `button` named `/switch user/i`; username text visible. No `menu-file`.
- **Conventional Commits**, imperative mood, scope `studio` (e.g. `feat(studio): …`). Commit at the end of each task.
- **Branch:** `feat/studio-toolbar` (already created off `main`). `main` is protected — land via squash PR.
- **Toolchain:** Node 20 (CI pin). Unit test: `cd studio/frontend && npx vitest run <path>`. Gates: `npx prettier --check .`, `npx nx typecheck frontend`, `npx nx test frontend`, `npx nx build frontend`.

---

### Task 1: BrandMark + ToolbarDivider

**Files:**
- Create: `studio/frontend/src/app/BrandMark.tsx`
- Create: `studio/frontend/src/app/ToolbarDivider.tsx`
- Test: `studio/frontend/src/app/BrandMark.spec.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `BrandMark(): JSX.Element` — the monogram tile + `Bloom Studio` `<h1>`.
  - `ToolbarDivider(): JSX.Element` — a 1px hairline vertical rule, `aria-hidden`.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/app/BrandMark.spec.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('renders the Bloom Studio wordmark as a heading', () => {
    render(<BrandMark />);
    expect(screen.getByRole('heading', { name: 'Bloom Studio' })).toBeInTheDocument();
  });

  it('marks the monogram glyph as decorative (aria-hidden)', () => {
    render(<BrandMark />);
    const glyph = screen.getByText('b');
    expect(glyph).toHaveAttribute('aria-hidden');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/BrandMark.spec.tsx`
Expected: FAIL — `Failed to resolve import "./BrandMark"`.

- [ ] **Step 3: Write minimal implementation**

`studio/frontend/src/app/BrandMark.tsx`:

```tsx
export function BrandMark() {
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-5 w-5 place-items-center rounded-[6px] bg-primary text-[13px] font-bold leading-none text-primary-foreground"
      >
        b
      </span>
      <h1 className="m-0 text-[13px] font-semibold tracking-tight text-foreground">Bloom Studio</h1>
    </div>
  );
}
```

`studio/frontend/src/app/ToolbarDivider.tsx`:

```tsx
export function ToolbarDivider() {
  return <span aria-hidden className="mx-1 h-[18px] w-px flex-shrink-0 bg-hairline" />;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/BrandMark.spec.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify no raw-color regressions**

Run: `cd studio/frontend && npx vitest run src/design-language.guard.spec.ts`
Expected: PASS (zero hex/rgba hits).

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/app/BrandMark.tsx studio/frontend/src/app/ToolbarDivider.tsx studio/frontend/src/app/BrandMark.spec.tsx
git commit -m "feat(studio): add BrandMark monogram + ToolbarDivider primitives"
```

---

### Task 2: RoomContext breadcrumb

**Files:**
- Create: `studio/frontend/src/app/RoomContext.tsx`
- Test: `studio/frontend/src/app/RoomContext.spec.tsx`

**Interfaces:**
- Consumes: `react-router-dom` `Link`, `lucide-react` (`ChevronLeft`, `Gamepad2`).
- Produces:
  - `interface IRoomContextProps { roomName: string; gameLinked: boolean }`
  - `RoomContext(props: IRoomContextProps): JSX.Element` — `Rooms` link (`href="/"`) + `/` + room name + optional Game chip.

- [ ] **Step 1: Write the failing test**

`studio/frontend/src/app/RoomContext.spec.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RoomContext } from './RoomContext';

function renderIn(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe('RoomContext', () => {
  it('links back to the rooms picker', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={false} />);
    expect(screen.getByRole('link', { name: /rooms/i })).toHaveAttribute('href', '/');
  });

  it('shows the room name', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={false} />);
    expect(screen.getByText('Verdant Hollow')).toBeInTheDocument();
  });

  it('shows the Game chip when a game is linked', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={true} />);
    expect(screen.getByText('Game')).toBeInTheDocument();
  });

  it('hides the Game chip when no game is linked', () => {
    renderIn(<RoomContext roomName="Verdant Hollow" gameLinked={false} />);
    expect(screen.queryByText('Game')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/RoomContext.spec.tsx`
Expected: FAIL — `Failed to resolve import "./RoomContext"`.

- [ ] **Step 3: Write minimal implementation**

`studio/frontend/src/app/RoomContext.tsx`:

```tsx
import { Link } from 'react-router-dom';
import { ChevronLeft, Gamepad2 } from 'lucide-react';

export interface IRoomContextProps {
  roomName: string;
  gameLinked: boolean;
}

export function RoomContext({ roomName, gameLinked }: IRoomContextProps) {
  return (
    <div className="flex items-center gap-2">
      <Link
        to="/"
        title="Back to rooms"
        className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronLeft aria-hidden className="h-3.5 w-3.5" />
        Rooms
      </Link>
      <span aria-hidden className="text-faint">
        /
      </span>
      <span className="text-[13px] font-medium text-foreground">{roomName}</span>
      {gameLinked && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-raised px-2 py-0.5 text-[11px] text-muted-foreground">
          <Gamepad2 aria-hidden className="h-3 w-3" />
          Game
        </span>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/RoomContext.spec.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/RoomContext.tsx studio/frontend/src/app/RoomContext.spec.tsx
git commit -m "feat(studio): add RoomContext breadcrumb lockup"
```

---

### Task 3: SwitchUser on the Button primitive

**Files:**
- Modify: `studio/frontend/src/app/SwitchUser.tsx` (full rewrite)
- Test: `studio/frontend/src/app/SwitchUser.spec.tsx` (extend)

**Interfaces:**
- Consumes: `useSession` (`{ username: string; logout(): void }`), `useNavigate`, `Button` (`@/components/ui/button`), `lucide-react` `LogOut`.
- Produces: `SwitchUser(): JSX.Element` — avatar + username + ghost icon `Button` (`aria-label="Switch user"`).

- [ ] **Step 1: Write the failing test (add the Button-primitive assertion)**

Add this `it` block inside the existing `describe('SwitchUser', …)` in `studio/frontend/src/app/SwitchUser.spec.tsx` (keep the two existing tests unchanged):

```tsx
  it('routes Switch user through the ghost Button primitive (not a raw button)', () => {
    saveSession('ada');
    render(tree());
    const btn = screen.getByRole('button', { name: /switch user/i });
    // ghost variant from buttonVariants → token border, not a bare <button>
    expect(btn.className).toContain('border-border-strong');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/SwitchUser.spec.tsx`
Expected: FAIL — the current raw `<button>` has no `border-border-strong` class.

- [ ] **Step 3: Rewrite SwitchUser**

`studio/frontend/src/app/SwitchUser.tsx`:

```tsx
import { useNavigate } from 'react-router-dom';
import { LogOut } from 'lucide-react';
import { useSession } from '../session/SessionContext';
import { Button } from '@/components/ui/button';

export function SwitchUser() {
  const { username, logout } = useSession();
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden
        className="grid h-[18px] w-[18px] place-items-center rounded-full border border-border bg-raised-hover text-[10px] text-muted-foreground"
      >
        {username.slice(0, 1).toLowerCase()}
      </span>
      <span className="text-[13px] text-muted-foreground">{username}</span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Switch user"
        title="Switch user"
        onClick={() => {
          logout();
          navigate('/login', { replace: true });
        }}
      >
        <LogOut aria-hidden className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/app/SwitchUser.spec.tsx`
Expected: PASS (3 tests — username visible, logout→/login + storage cleared, ghost Button).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/SwitchUser.tsx studio/frontend/src/app/SwitchUser.spec.tsx
git commit -m "feat(studio): rebuild SwitchUser on the ghost Button primitive"
```

---

### Task 4: De-box the menus (primitive + Menubar)

**Files:**
- Modify: `studio/frontend/src/components/ui/menubar.tsx` (Root de-box, retoken trigger/item, add `MenubarLabel`, content radius)
- Modify: `studio/frontend/src/app/Menubar.tsx` (trigger icons + "Presets" label + item icons)
- Test: `studio/frontend/src/app/Menubar.spec.tsx` (existing — must stay green)

**Interfaces:**
- Consumes: Radix Menubar primitives, `lucide-react` (`LayoutGrid`, `PanelsTopLeft`, `Save`, `RotateCcw`).
- Produces: a borderless `Menubar` root; `MenubarLabel` export; `AppMenubar` with iconned triggers. **All existing testids unchanged.**

- [ ] **Step 1: Run the existing menu tests to establish the green baseline**

Run: `cd studio/frontend && npx vitest run src/app/Menubar.spec.tsx`
Expected: PASS (2 tests). This is the safety net for the styling refactor.

- [ ] **Step 2: De-box and retoken `components/ui/menubar.tsx`**

Replace the `Menubar` root `className` (line ~14) — drop the box and height:

```tsx
const Menubar = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Root>, IMenubarProps>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Root ref={ref} className={cn('flex items-center gap-1', className)} {...props} />
));
```

Replace the `MenubarTrigger` `className` — borderless hover-highlight, neutral hover/open (no accent-named classes), icon-friendly:

```tsx
<MenubarPrimitive.Trigger
  ref={ref}
  className={cn(
    'flex h-7 cursor-default select-none items-center gap-1.5 rounded-md px-2 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:bg-raised-hover hover:text-foreground focus:bg-raised-hover focus:text-foreground data-[state=open]:bg-raised-hover data-[state=open]:text-foreground',
    className,
  )}
  {...props}
/>
```

Replace the `MenubarItem` `className` — neutral focus + icon gap:

```tsx
<MenubarPrimitive.Item
  ref={ref}
  className={cn(
    'relative flex cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground outline-none focus:bg-raised-hover focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
    inset && 'pl-8',
    className,
  )}
  {...props}
/>
```

In `MenubarContent`, change `rounded-md` → `rounded-[9px]` (keep everything else).

Add a `MenubarLabel` (Radix `Label`) just before the `export {` line:

```tsx
export interface IMenubarLabelProps extends React.ComponentPropsWithoutRef<typeof MenubarPrimitive.Label> {}

const MenubarLabel = React.forwardRef<React.ComponentRef<typeof MenubarPrimitive.Label>, IMenubarLabelProps>(({ className, ...props }, ref) => (
  <MenubarPrimitive.Label
    ref={ref}
    className={cn('px-2 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground', className)}
    {...props}
  />
));
MenubarLabel.displayName = MenubarPrimitive.Label.displayName;
```

Add `MenubarLabel` to the final `export { … }` list.

- [ ] **Step 3: Add icons + Presets label in `app/Menubar.tsx`**

Add to the imports:

```tsx
import { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator, MenubarLabel } from '@/components/ui/menubar';
import { LayoutGrid, PanelsTopLeft, Save, RotateCcw } from 'lucide-react';
```

Give the triggers leading icons (text + testids unchanged):

```tsx
<MenubarTrigger data-testid="menu-layout">
  <LayoutGrid aria-hidden className="h-3.5 w-3.5" />
  Layout
</MenubarTrigger>
```
```tsx
<MenubarTrigger data-testid="menu-view">
  <PanelsTopLeft aria-hidden className="h-3.5 w-3.5" />
  View
</MenubarTrigger>
```

Add a `Save` icon to the save item, a `Presets` label above the preset list, and a `RotateCcw` icon to reset:

```tsx
<MenubarItem data-testid="layout-save" onClick={() => setSaveOpen(true)}>
  <Save aria-hidden className="h-3.5 w-3.5" />
  Save arrangement…
</MenubarItem>
<MenubarSeparator />
<MenubarLabel>Presets</MenubarLabel>
{all.map((p) => (
  // …unchanged…
))}
```
```tsx
<MenubarItem data-testid="menu-reset-layout" onClick={() => host.resetLayout()}>
  <RotateCcw aria-hidden className="h-3.5 w-3.5" />
  Reset layout
</MenubarItem>
```

- [ ] **Step 4: Run menu tests + guard**

Run: `cd studio/frontend && npx vitest run src/app/Menubar.spec.tsx src/design-language.guard.spec.ts`
Expected: PASS — testids/text intact (icons are additive), zero raw-color hits.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/components/ui/menubar.tsx studio/frontend/src/app/Menubar.tsx
git commit -m "feat(studio): de-box menubar into borderless icon triggers"
```

---

### Task 5: Rezone the Workbench toolbar

**Files:**
- Modify: `studio/frontend/src/app/Workbench.tsx`

**Interfaces:**
- Consumes: `BrandMark`, `ToolbarDivider` (Task 1), `AppMenubar` (Task 4), `SwitchUser` (Task 3), `ModeBadge`.
- Produces: `Workbench({ roomContext }: { roomContext?: ReactNode })` — `h-10` four-zone toolbar. **Renames the prop `leading` → `roomContext`.**

- [ ] **Step 1: Rewrite Workbench**

`studio/frontend/src/app/Workbench.tsx`:

```tsx
import { type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { bloomTheme } from './bloomTheme';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';
import { BrandMark } from './BrandMark';
import { ToolbarDivider } from './ToolbarDivider';

export function Workbench({ roomContext }: { roomContext?: ReactNode }) {
  const app = useApp();
  useApplyTheme();

  return (
    <div data-testid="workbench" className="flex h-screen flex-col bg-canvas font-sans text-foreground">
      <div className="flex h-10 flex-shrink-0 items-center gap-2 bg-canvas px-3">
        <BrandMark />
        <ToolbarDivider />
        <AppMenubar />
        <div className="flex-1" />
        {roomContext && (
          <>
            {roomContext}
            <ToolbarDivider />
          </>
        )}
        <ModeBadge />
        <SwitchUser />
      </div>
      <CommandPalette />
      <div className="flex-1 overflow-hidden">
        <DockviewReact theme={bloomTheme} components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck (catches the prop rename across call sites)**

Run: `npx nx typecheck frontend`
Expected: One error in `RoomRoute.tsx` — `leading` no longer exists on `Workbench` props. **That is expected and fixed in Task 6.** No other errors.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/src/app/Workbench.tsx
git commit -m "feat(studio): rezone toolbar into four deliberate zones at 40px"
```

---

### Task 6: Wire RoomContext through RoomRoute (capstone)

**Files:**
- Modify: `studio/frontend/src/app/routes/RoomRoute.tsx`
- Test: `studio/frontend/src/app/routes/RoomRoute.spec.tsx` (update the `Workbench` mock; existing assertions stay)

**Interfaces:**
- Consumes: `RoomContext` (Task 2), `Workbench` `roomContext` prop (Task 5), `IRoom` (`../../plugins/llm-chat/state`).
- Produces: `RoomRoute` renders `<Workbench roomContext={<RoomContext … />} />`.

- [ ] **Step 1: Update the test's Workbench mock to the renamed prop**

In `studio/frontend/src/app/routes/RoomRoute.spec.tsx`, replace the `vi.mock('../Workbench', …)` block:

```tsx
vi.mock('../Workbench', () => ({
  Workbench: ({ roomContext }: { roomContext?: React.ReactNode }) => <div data-testid="workbench">{roomContext}WB</div>,
}));
```

(Leave every `it(…)` unchanged — the back-link test still finds the `Rooms` link, now sourced from `RoomContext`.)

- [ ] **Step 2: Run RoomRoute tests to verify the back-link test now fails**

Run: `cd studio/frontend && npx vitest run src/app/routes/RoomRoute.spec.tsx`
Expected: FAIL on "renders a back-to-rooms link" — the real `RoomRoute` still passes `leading`, so the mock (now reading `roomContext`) renders no link.

- [ ] **Step 3: Update RoomRoute to build + pass RoomContext**

`studio/frontend/src/app/routes/RoomRoute.tsx` (note: drop the `Link` import, add `RoomContext` + `IRoom` + room state):

```tsx
import { useEffect, useState, type ReactNode } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { getRooms } from '../../plugins/llm-chat/restClient';
import type { IRoom } from '../../plugins/llm-chat/state';
import { openRoom, closeRoom } from '../../plugins/llm-chat/actions';
import { openGame, closeGame } from '../../plugins/assets/actions';
import { notify } from '../../lib/notify';
import { ActiveRoomProvider } from './activeRoom';
import { Workbench } from '../Workbench';
import { RoomContext } from '../RoomContext';

type Validation = 'checking' | 'valid' | 'invalid';

export function RoomRoute({ children }: { children?: ReactNode }) {
  const { roomId } = useParams<{ roomId: string }>();
  const [state, setState] = useState<Validation>('checking');
  const [room, setRoom] = useState<IRoom | null>(null);

  useEffect(() => {
    let alive = true;
    setState('checking');
    getRooms()
      .then((rooms) => {
        if (!alive) return;
        const found = rooms.find((r) => r.id === roomId);
        if (found) {
          setRoom(found);
          void openRoom(roomId!);
          if (found.gameId) void openGame(found.gameId);
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

  // Leave the room AND its game when the route unmounts (back to picker / different room).
  useEffect(
    () => () => {
      closeRoom();
      closeGame();
    },
    [],
  );

  useEffect(() => {
    if (state === 'invalid') notify.error('That room no longer exists.');
  }, [state]);

  if (state === 'checking') return <div data-testid="room-loading">Opening room…</div>;
  if (state === 'invalid' || !roomId) return <Navigate to="/" replace />;
  return (
    <ActiveRoomProvider roomId={roomId}>
      <Workbench roomContext={<RoomContext roomName={room?.name ?? ''} gameLinked={!!room?.gameId} />} />
      {children}
    </ActiveRoomProvider>
  );
}
```

- [ ] **Step 4: Run RoomRoute tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/app/routes/RoomRoute.spec.tsx`
Expected: PASS (all 6 — valid/openRoom/context, back-link `href="/"`, unknown→picker, gameId open, no-gameId no-open, unmount→closeGame).

- [ ] **Step 5: Typecheck clean**

Run: `npx nx typecheck frontend`
Expected: PASS — the Task 5 prop-rename error is now resolved.

- [ ] **Step 6: Commit**

```bash
git add studio/frontend/src/app/routes/RoomRoute.tsx studio/frontend/src/app/routes/RoomRoute.spec.tsx
git commit -m "feat(studio): surface room name + game chip via RoomContext"
```

---

### Task 7: Full verification, e2e, and PR

**Files:** none (verification + integration).

- [ ] **Step 1: Run the four Frontend CI gates**

```bash
npx prettier --check .
npx nx typecheck frontend
npx nx test frontend
npx nx build frontend
```
Expected: all PASS. (`nx test frontend` runs the whole Vitest suite incl. the guard, BrandMark, RoomContext, SwitchUser, Menubar, RoomRoute, smoke-level specs.)

- [ ] **Step 2: Run the browser e2e against a replay backend**

Per `MEMORY.md` (Always run e2e before PR): ensure a replay backend is on `:8000` (`just backend-serve-replay`), confirm `/health` reports replay, then:

```bash
just e2e
```
Expected: PASS — including `routing.spec.ts` (Rooms link → picker), `chrome.spec.ts` / `styling.spec.ts` / `panes.spec.ts` / `layout-presets.spec.ts` (menu testids), `smoke.spec.ts` (Bloom Studio heading), and `theme.spec.ts` (which re-shoots `docs/design-language/reference-workbench.png`). Restore the `:8000` backend to its prior state afterward.

- [ ] **Step 3: Eyeball the reference screenshot**

Open `docs/design-language/reference-workbench.png` and confirm the new toolbar reads as intended: monogram brand, de-boxed menus, `Rooms / <name> [Game]` breadcrumb, ghost switch-user. Commit the re-shot artifact if changed.

```bash
git add docs/design-language/reference-workbench.png
git commit -m "test(studio): re-shoot toolbar reference screenshot"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/studio-toolbar
gh pr create --fill
```

- [ ] **Step 5: Merge once checks pass**

```bash
gh pr merge --squash --delete-branch
```

---

## Notes for the implementer

- **Why the `leading` → `roomContext` rename:** the prop now feeds the *right* zone, not a left-leading slot; the name keeps the toolbar self-documenting. Only `Workbench.tsx` (def) and `RoomRoute.tsx` (call) + the `RoomRoute.spec` mock reference it.
- **Accent discipline:** if you find yourself reaching for orange anywhere except the `BrandMark` tile, stop — that's a design-language violation the reviewer will reject.
- **Icons are decorative:** every lucide icon in the toolbar/menus is `aria-hidden` so it never pollutes an accessible name or heading text.
- **Typecheck fallback:** if `npx nx typecheck frontend` reports no such target in this environment, use `cd studio/frontend && npx tsc --noEmit` instead — same gate.

# Visual Identity (Dark Game-Editor) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Bloom Studio's default-shadcn look with a cohesive dark game-editor visual identity — cool-slate neutrals on a 3-elevation model, a fire-orange accent, compact density, connected Dockview tabs, and IBM Plex typography — without changing any behavior.

**Architecture:** A token-first re-skin. We rewrite `styles.css` so the existing shadcn token names (`--background`, `--primary`, `--muted`, `--accent`, …) are remapped onto the new dark identity (so most existing utility classes inherit the new colors with zero churn), add a handful of new tokens (`--surface`, `--raised`, `--accent-text`, `--success`…), retune the `components/ui` primitives to compact sizing, add the missing editor chrome (`PanelHeader`, `StatusPill`, a custom Dockview theme with connected tabs), then re-skin each pane. Dark-only now; a light theme is a future second value-set for the same token names.

**Tech Stack:** React 18, TypeScript, Tailwind CSS v4 (`@theme inline`), Vitest + Testing Library, Dockview v6, Hookstate v4, `@fontsource` for self-hosted fonts. Nx project name: `frontend`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-21-visual-identity-dark-editor-design.md`. Where this plan and the spec disagree, the spec wins.
- **No backend / protocol / state-shape / reducer changes.** Pure presentation. `studio/frontend` only.
- **Preserve every load-bearing test hook and all behavior:** all existing `data-testid`, `data-role`, `data-state`, `data-status`, `data-mode`, `role`, ARIA, placeholders, button names, and option labels. Existing unit + Playwright specs must stay green (update a spec only where this plan explicitly says so).
- **Render-isolation invariant:** do NOT add any new pane-level subscription to message/asset content. Keep the `ChatRoomPane → MessageList → ChatMessageBubble` split and every `bumpRenderCount('…')` call with its current name. The test "appending a token re-renders only that bubble" must stay green.
- **TypeScript:** interfaces use the `I` prefix (`IPanelHeaderProps`). Per `docs/coding-standards.md`.
- **Colors are tokens-only** — no raw hex / Tailwind palette names in components (`text-red-500` etc.). Hex literals live ONLY in `styles.css` token definitions.
- **Tooling/PATH:** Node is not always on the shell PATH. Prepend it for every command in this plan: in Git Bash `export PATH="/c/Program Files/nodejs:$PATH"`. Run commands from the repo root `C:/code/bloom` unless noted.
- **Per-task hygiene:** before each commit run `npx prettier --write <changed files>`; commits use Conventional Commits; work on branch `feat/visual-identity-dark-editor` (create from `main`). `main` is protected — land via squash PR at the end.
- **Test commands:** whole suite `npx nx test frontend`; a single file `npx nx test frontend -- <relativePathFromRepoRoot>`; typecheck `npx nx run frontend:typecheck`; build `npx nx build frontend`.

---

## Task 0: Branch

- [ ] **Step 1: Create the working branch**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
git checkout main && git pull --ff-only
git checkout -b feat/visual-identity-dark-editor
```

(No commit; subsequent tasks commit onto this branch.)

---

## Task 1: Token system + scrollbars (`styles.css`)

Rewrite the token layer. This is CSS-only (not unit-testable directly); it is verified by the primitive specs in Tasks 3–7 and a build. Hex literals are authoritative (they match the approved mockups); oklch is acceptable if preferred but keep the exact colors.

**Files:**

- Modify: `studio/frontend/src/styles.css`

**Interfaces:**

- Produces (Tailwind utilities other tasks consume): `bg-bg`, `bg-surface`, `bg-raised`, `bg-raised-hover`, `border-border-strong`, `text-accent-text`, `bg-success`, `bg-warning`, `text-success`, plus the existing `bg-background`/`bg-primary`/`bg-muted`/`text-muted-foreground`/`hover:bg-accent`/`border-border`/`text-destructive`/`ring-ring` (now remapped to the dark identity). Font tokens `--font-sans`/`--font-mono` (Tailwind `font-sans`/`font-mono`).

- [ ] **Step 1: Replace the contents of `styles.css`**

(The `@fontsource` imports on lines 3–8 depend on Task 2's install; that install runs before this file is built, and Tasks are committed in order, so add them now.)

```css
@import 'tailwindcss';
@import 'dockview-react/dist/styles/dockview.css';
@import '@fontsource/ibm-plex-sans/400.css';
@import '@fontsource/ibm-plex-sans/500.css';
@import '@fontsource/ibm-plex-sans/600.css';
@import '@fontsource/ibm-plex-sans/700.css';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';

@custom-variant dark (&:is(.dark *));

/*
  Bloom dark game-editor identity. DARK-ONLY today; a future light theme supplies a
  second value-set for these same names (no component changes). Hex values match the
  approved design mockups and are authoritative.
*/
:root {
  /* Neutral ramp — cool slate, three elevations */
  --bg: #0d1014; /* gutter: app bg, gaps between panels, tab-strip gutter, inset fields */
  --surface: #161b22; /* working pane surface; active tab shares this */
  --raised: #1c222b; /* controls, tiles, cards-on-a-surface */
  --raised-hover: #232a34; /* hover for raised elements */
  --border-strong: #313a47; /* emphasized separators / resizers */
  --faint: #5c6573; /* disabled / placeholder */

  /* Fire-orange accent extras */
  --primary-hover: #ff7a33; /* hover/active of accent fills */
  --accent-text: #ff8a4d; /* orange text/icons on dark surfaces */
  --selection: rgba(240, 100, 30, 0.15); /* selected-row / active tint */
  --selection-text: #ffb98c;

  /* Status */
  --success: #3ec28b;
  --warning: #e7b549;

  /* Type */
  --font-sans: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'Cascadia Code', monospace;

  /* ===== Legacy shadcn token names, remapped onto the dark ramp =====
     Existing utilities (bg-background, bg-muted, hover:bg-accent, bg-primary,
     text-muted-foreground, border-border, text-destructive, ring-ring …) keep
     working and inherit the new identity. */
  --background: var(--surface); /* Card/Input/Select surfaces */
  --foreground: #e7eaef;
  --primary: #f0641e; /* fire orange */
  --primary-foreground: #2a1002;
  --border: #283039; /* hairline */
  --popover: var(--surface);
  --popover-foreground: var(--foreground);
  --muted: var(--raised); /* bg-muted = raised surface */
  --muted-foreground: #8a93a2;
  --accent: var(--raised-hover); /* hover:bg-accent = neutral hover */
  --accent-foreground: var(--foreground);
  --ring: var(--primary); /* orange focus ring */
  --input: var(--border);
  --destructive: #e5484d; /* clear red on slate */
  --destructive-foreground: #ffffff;
}

@theme inline {
  /* new tokens */
  --color-bg: var(--bg);
  --color-surface: var(--surface);
  --color-raised: var(--raised);
  --color-raised-hover: var(--raised-hover);
  --color-border-strong: var(--border-strong);
  --color-faint: var(--faint);
  --color-primary-hover: var(--primary-hover);
  --color-accent-text: var(--accent-text);
  --color-selection: var(--selection);
  --color-selection-text: var(--selection-text);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);

  /* legacy names */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-border: var(--border);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
}

body {
  background: var(--bg);
  color: var(--foreground);
  margin: 0;
  font-family: var(--font-sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}

/* Thin editor scrollbars */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--raised) transparent;
}
*::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
*::-webkit-scrollbar-thumb {
  background: var(--raised);
  border-radius: 4px;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--raised-hover);
}
*::-webkit-scrollbar-track {
  background: transparent;
}
```

(The Dockview `.dockview-theme-bloom` block is added in Task 8.)

- [ ] **Step 2: Verify the build compiles the tokens**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
npx nx build frontend
```

Expected: build succeeds. (If it fails on the `@fontsource` imports, do Task 2 Step 1 first, then re-run.)

- [ ] **Step 3: Commit**

```bash
npx prettier --write studio/frontend/src/styles.css
git add studio/frontend/src/styles.css
git commit -m "feat(studio): dark game-editor token system (slate + fire orange)"
```

---

## Task 2: Self-host IBM Plex fonts

**Files:**

- Modify: `package.json` (dependencies), `package-lock.json` (generated)
- (Imports already added in `styles.css` Task 1)

- [ ] **Step 1: Install the font packages**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
npm install @fontsource/ibm-plex-sans@^5 @fontsource/ibm-plex-mono@^5
```

Expected: both appear under `dependencies` in `package.json`.

- [ ] **Step 2: Verify the font CSS resolves in a build**

```bash
npx nx build frontend
```

Expected: build succeeds; no "Failed to resolve import '@fontsource/...'" error.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(studio): self-host IBM Plex Sans + Mono via @fontsource"
```

---

## Task 3: Retune `Button` to compact sizes

Colors already come from tokens (Task 1 made `--primary` orange). This task only changes sizing/radius and updates the size assertion in the existing spec.

**Files:**

- Modify: `studio/frontend/src/components/ui/button.tsx`
- Test: `studio/frontend/src/components/ui/button.spec.tsx`

**Interfaces:**

- Produces: `Button` with sizes `default` (h-7), `sm` (h-6), `icon` (h-7 w-7); variants unchanged (`default`/`outline`/`ghost`/`destructive`). `IButtonProps` unchanged.

- [ ] **Step 1: Update the spec's size expectation (write the failing test)**

In `button.spec.tsx`, change the `sm` test and add a `default`-size check:

```tsx
it('applies the sm size', () => {
  const { getByRole } = render(<Button size="sm">Small</Button>);
  expect(getByRole('button').className).toContain('h-6');
});

it('applies the compact default height', () => {
  const { getByRole } = render(<Button>Go</Button>);
  expect(getByRole('button').className).toContain('h-7');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/button.spec.tsx
```

Expected: FAIL — current `sm` is `h-8`, default is `h-9`.

- [ ] **Step 3: Retune `button.tsx`**

```tsx
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'border border-border bg-transparent hover:bg-raised-hover',
        ghost: 'bg-transparent hover:bg-accent',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
      },
      size: { default: 'h-7 px-3 text-[13px]', sm: 'h-6 px-2.5 text-xs', icon: 'h-7 w-7' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface IButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: IButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/button.spec.tsx
```

Expected: PASS (all four tests, including the unchanged `destructive`/`ghost` ones).

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/button.tsx studio/frontend/src/components/ui/button.spec.tsx
git add studio/frontend/src/components/ui/button.tsx studio/frontend/src/components/ui/button.spec.tsx
git commit -m "feat(studio): compact Button sizing"
```

---

## Task 4: Retune `Input` and `Select` to compact

**Files:**

- Modify: `studio/frontend/src/components/ui/input.tsx`, `studio/frontend/src/components/ui/select.tsx`
- Test: `studio/frontend/src/components/ui/input.spec.tsx` (add height assertion)

- [ ] **Step 1: Add a failing height assertion to `input.spec.tsx`**

```tsx
it('renders at the compact height', () => {
  const { getByPlaceholderText } = render(<Input placeholder="h" />);
  expect((getByPlaceholderText('h') as HTMLInputElement).className).toContain('h-7');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/input.spec.tsx
```

Expected: FAIL — current height is `h-9`.

- [ ] **Step 3: Retune `input.tsx`**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-7 rounded border border-input bg-bg px-2.5 text-[13px] outline-none placeholder:text-faint',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
```

- [ ] **Step 4: Retune `select.tsx` to match**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-7 rounded border border-input bg-bg px-2 text-[13px] outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
```

- [ ] **Step 5: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/input.spec.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/input.tsx studio/frontend/src/components/ui/select.tsx studio/frontend/src/components/ui/input.spec.tsx
git add studio/frontend/src/components/ui/input.tsx studio/frontend/src/components/ui/select.tsx studio/frontend/src/components/ui/input.spec.tsx
git commit -m "feat(studio): compact Input and Select"
```

---

## Task 5: Retune `Card` — surface, no shadow, compact padding

**Files:**

- Modify: `studio/frontend/src/components/ui/card.tsx`
- Test: `studio/frontend/src/components/ui/card.spec.tsx`

- [ ] **Step 1: Add a failing assertion to `card.spec.tsx`**

Append inside the existing `describe('Card', …)` (keep existing tests):

```tsx
it('uses the surface token and drops the drop-shadow', () => {
  const { container } = render(<Card>x</Card>);
  const cls = (container.firstChild as HTMLElement).className;
  expect(cls).toContain('bg-surface');
  expect(cls).not.toContain('shadow');
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/card.spec.tsx
```

Expected: FAIL — current Card has `bg-background shadow-sm`.

- [ ] **Step 3: Retune `card.tsx`**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-md border border-border bg-surface', className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1 p-2.5', className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-2.5 pt-0', className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-2 p-2.5 pt-0', className)} {...props} />;
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/card.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/card.tsx studio/frontend/src/components/ui/card.spec.tsx
git add studio/frontend/src/components/ui/card.tsx studio/frontend/src/components/ui/card.spec.tsx
git commit -m "feat(studio): compact flat Card on the surface token"
```

---

## Task 6: New `PanelHeader` component

**Files:**

- Create: `studio/frontend/src/components/ui/PanelHeader.tsx`
- Create: `studio/frontend/src/components/ui/PanelHeader.spec.tsx`

**Interfaces:**

- Produces: `PanelHeader({ label, right?, className? }: IPanelHeaderProps)` → a `div[data-testid="panel-header"]` with an uppercase muted label and optional right-aligned slot.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PanelHeader } from './PanelHeader';

describe('PanelHeader', () => {
  it('renders an uppercase label and the testid', () => {
    const { getByTestId, getByText } = render(<PanelHeader label="Asset Board" />);
    expect(getByTestId('panel-header')).toBeTruthy();
    expect(getByText('Asset Board').className).toContain('uppercase');
  });

  it('renders the right slot when provided', () => {
    const { getByText } = render(<PanelHeader label="L" right={<span>game: skybloom</span>} />);
    expect(getByText('game: skybloom')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/PanelHeader.spec.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `PanelHeader.tsx`**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface IPanelHeaderProps {
  label: string;
  right?: React.ReactNode;
  className?: string;
}

export function PanelHeader({ label, right, className }: IPanelHeaderProps) {
  return (
    <div data-testid="panel-header" className={cn('flex items-center gap-2 border-b border-border px-2.5 py-1.5', className)}>
      <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
      {right && <span className="ml-auto text-[11px] text-muted-foreground">{right}</span>}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/PanelHeader.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/PanelHeader.tsx studio/frontend/src/components/ui/PanelHeader.spec.tsx
git add studio/frontend/src/components/ui/PanelHeader.tsx studio/frontend/src/components/ui/PanelHeader.spec.tsx
git commit -m "feat(studio): PanelHeader component"
```

---

## Task 7: New `StatusPill` component

**Files:**

- Create: `studio/frontend/src/components/ui/StatusPill.tsx`
- Create: `studio/frontend/src/components/ui/StatusPill.spec.tsx`

**Interfaces:**

- Produces: `StatusPill({ tone?, children, className?, ...rest }: IStatusPillProps)` — `tone` ∈ `'neutral' | 'success' | 'warning' | 'danger'` (default `'neutral'`); spreads `...rest` onto the root `<span>` so callers can pass `data-testid` / `data-state`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  it('renders children and forwards arbitrary props', () => {
    const { getByTestId } = render(
      <StatusPill tone="success" data-testid="p" data-state="connected">
        connected
      </StatusPill>,
    );
    const el = getByTestId('p');
    expect(el.textContent).toContain('connected');
    expect(el.getAttribute('data-state')).toBe('connected');
  });

  it('applies a tone dot class', () => {
    const { getByTestId } = render(
      <StatusPill tone="warning" data-testid="p">
        x
      </StatusPill>,
    );
    expect(getByTestId('p').querySelector('.bg-warning')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/StatusPill.spec.tsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `StatusPill.tsx`**

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface IStatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
}

const dotClass: Record<StatusTone, string> = {
  neutral: 'bg-muted-foreground',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export function StatusPill({ tone = 'neutral', children, className, ...rest }: IStatusPillProps) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted-foreground', className)} {...rest}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dotClass[tone])} />
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/components/ui/StatusPill.spec.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/components/ui/StatusPill.tsx studio/frontend/src/components/ui/StatusPill.spec.tsx
git add studio/frontend/src/components/ui/StatusPill.tsx studio/frontend/src/components/ui/StatusPill.spec.tsx
git commit -m "feat(studio): StatusPill component"
```

---

## Task 8: Dockview "bloom" theme — connected tabs

The connected-tab look is driven by Dockview's `--dv-*` CSS variables. Variable names vary by version, so this task starts by reading the installed stylesheet, then maps our tokens, then wires the theme class. Fallback (per spec risk): if a needed seam isn't reachable via a variable, add a scoped rule on Dockview's stable class names.

**Files:**

- Modify: `studio/frontend/src/styles.css` (append the theme block)
- Modify: `studio/frontend/src/app/useApplyTheme.ts`

- [ ] **Step 1: Discover the real variable + class names**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
grep -oE '\-\-dv-[a-z-]+' node_modules/dockview-core/dist/styles/dockview.css | sort -u
grep -oE 'dv-(active-tab|inactive-tab|tab)\b' node_modules/dockview-core/dist/styles/dockview.css | sort -u
```

Expected: a list of `--dv-*` variable names and the active-tab class. Use the actual names from this output in Step 2 (the names below are the v6 defaults — adjust if the grep shows different ones).

- [ ] **Step 2: Append the theme block to `styles.css`**

```css
/* === Dockview "bloom" theme: connected tabs over a recessed gutter === */
.dockview-theme-bloom {
  --dv-background-color: var(--bg);
  --dv-group-view-background-color: var(--surface);
  --dv-tabs-and-actions-container-background-color: var(--bg);
  --dv-activegroup-visiblepanel-tab-background-color: var(--surface);
  --dv-activegroup-hiddenpanel-tab-background-color: transparent;
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--surface);
  --dv-inactivegroup-hiddenpanel-tab-background-color: transparent;
  --dv-activegroup-visiblepanel-tab-color: var(--foreground);
  --dv-activegroup-hiddenpanel-tab-color: var(--muted-foreground);
  --dv-inactivegroup-visiblepanel-tab-color: var(--foreground);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--muted-foreground);
  --dv-tab-divider-color: var(--bg);
  --dv-separator-border: var(--border);
  --dv-paneview-active-outline-color: var(--primary);
  --dv-icon-hover-background-color: var(--raised-hover);
  color: var(--foreground);
}
/* Active tab: 2px orange cap; share the pane surface so tab + pane read as one shape */
.dockview-theme-bloom .dv-active-tab {
  box-shadow: inset 0 2px 0 var(--primary);
}
.dockview-theme-bloom .dv-tab {
  font-size: 12px;
}
```

- [ ] **Step 3: Apply the theme (dark-only) in `useApplyTheme.ts`**

Replace the file with an always-dark, bloom-themed version (drops the light/dark toggle; keeps the `dockEl` wiring):

```ts
import { useEffect } from 'react';

export function useApplyTheme(dockEl: HTMLElement | null): void {
  useEffect(() => {
    document.documentElement.classList.add('dark');
    if (dockEl) dockEl.classList.add('dockview-theme-bloom');
  }, [dockEl]);
}
```

- [ ] **Step 4: Verify build + existing shell tests**

```bash
npx nx build frontend
npx nx test frontend -- studio/frontend/src/state/persistence.spec.ts
```

Expected: build succeeds; persistence spec passes (it references theme state, which is untouched). If `persistence.spec.ts` asserts a `dockview-theme-dark` class, update that assertion to `dockview-theme-bloom`.

- [ ] **Step 5: Visual check (manual)**

```bash
npx nx serve frontend
```

Open the app, confirm: active tab carries the orange cap and merges into its pane; inactive tabs sit on the darker gutter; panels float over the gutter. Adjust variable names from Step 1 if any seam is wrong. Stop the server when done.

- [ ] **Step 6: Commit**

```bash
npx prettier --write studio/frontend/src/styles.css studio/frontend/src/app/useApplyTheme.ts
git add studio/frontend/src/styles.css studio/frontend/src/app/useApplyTheme.ts
git commit -m "feat(studio): connected-tab Dockview theme (dark-only)"
```

---

## Task 9: Workbench titlebar + remove ThemeToggle

**Files:**

- Modify: `studio/frontend/src/app/Workbench.tsx`
- Delete: `studio/frontend/src/app/ThemeToggle.tsx` and its spec if present
- Possibly modify: any file referencing `ThemeToggle` / a theme-toggle command (found via grep)

- [ ] **Step 1: Find every ThemeToggle reference**

```bash
export PATH="/c/Program Files/nodejs:$PATH"
grep -rn "ThemeToggle\|theme-toggle\|toggle.*theme" studio/frontend/src
ls studio/frontend/src/app/ThemeToggle.spec.tsx 2>/dev/null || echo "no spec"
```

Expected: references in `Workbench.tsx` (import + `<ThemeToggle />`) and possibly a command registration. Remove each in the following steps.

- [ ] **Step 2: Update `Workbench.tsx`** (compact titlebar, drop ThemeToggle)

```tsx
import { useState, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';

export function Workbench({ leading }: { leading?: ReactNode }) {
  const app = useApp();
  const [dockEl, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme(dockEl);

  return (
    <div data-testid="workbench" className="flex h-screen flex-col bg-bg font-sans text-foreground">
      <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-border bg-bg px-2.5">
        <div className="flex items-center gap-2">
          {leading}
          <h1 className="m-0 text-[13px] font-semibold tracking-tight">Bloom Studio</h1>
          <AppMenubar />
        </div>
        <div className="flex items-center gap-2">
          <ModeBadge />
          <SwitchUser />
        </div>
      </div>
      <CommandPalette />
      <div ref={setDockEl} className="flex-1 overflow-hidden">
        <DockviewReact components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Delete ThemeToggle and any command reference**

```bash
git rm studio/frontend/src/app/ThemeToggle.tsx
git rm studio/frontend/src/app/ThemeToggle.spec.tsx 2>/dev/null || true
```

If Step 1 found a theme-toggle command registration (e.g. in `CommandPalette.tsx`, `commandRegistry`, or `workbenchSetup.ts`), remove that command and its import there.

- [ ] **Step 4: Typecheck + run shell tests**

```bash
npx nx run frontend:typecheck
npx nx test frontend -- studio/frontend/src/app/Menubar.spec.tsx
```

Expected: typecheck passes (no dangling `ThemeToggle` import); Menubar spec passes. If a test referenced `theme-toggle`, update it to match removal.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/app/Workbench.tsx
git add -A studio/frontend/src/app
git commit -m "feat(studio): compact titlebar; remove ThemeToggle (dark-only)"
```

---

## Task 10: ModeBadge → tokens via StatusPill

**Files:**

- Modify: `studio/frontend/src/app/ModeBadge.tsx`
- Test: `studio/frontend/src/app/ModeBadge.spec.tsx`

- [ ] **Step 1: Add a failing assertion** (keep existing tests). Open `ModeBadge.spec.tsx` and add, inside its `describe`:

```tsx
it('renders without inline background styles (token-driven)', async () => {
  const { findByTestId } = render(<ModeBadge />);
  const el = await findByTestId('mode-badge');
  expect(el.getAttribute('style')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx nx test frontend -- studio/frontend/src/app/ModeBadge.spec.tsx
```

Expected: FAIL — current ModeBadge sets an inline `style`.

- [ ] **Step 3: Reimplement `ModeBadge.tsx`** using `StatusPill` (preserve `data-testid`, `data-mode`, `title`, and the `…`/`live`/`replay` text)

```tsx
import { useEffect, useState } from 'react';
import { getHealth } from '../host/health';
import { StatusPill } from '@/components/ui/StatusPill';

export function ModeBadge() {
  const [mode, setMode] = useState<'live' | 'replay' | 'unknown'>('unknown');

  useEffect(() => {
    let alive = true;
    getHealth()
      .then((h) => alive && setMode(h.providerMode))
      .catch(() => alive && setMode('unknown'));
    return () => {
      alive = false;
    };
  }, []);

  const isReplay = mode === 'replay';
  return (
    <StatusPill
      data-testid="mode-badge"
      data-mode={mode}
      tone={isReplay ? 'warning' : 'success'}
      title={isReplay ? 'Recorded-real fixtures — not live providers' : 'Live providers'}
      className="uppercase tracking-wide"
    >
      {mode === 'unknown' ? '…' : mode}
    </StatusPill>
  );
}
```

- [ ] **Step 4: Run to verify pass**

```bash
npx nx test frontend -- studio/frontend/src/app/ModeBadge.spec.tsx
```

Expected: PASS (existing tests + the new one). If an existing test asserted the old inline `background`, update it to assert `data-mode`/`tone` text instead.

- [ ] **Step 5: Commit**

```bash
npx prettier --write studio/frontend/src/app/ModeBadge.tsx studio/frontend/src/app/ModeBadge.spec.tsx
git add studio/frontend/src/app/ModeBadge.tsx studio/frontend/src/app/ModeBadge.spec.tsx
git commit -m "feat(studio): token-driven ModeBadge via StatusPill"
```

---

## Task 11: Re-skin the Chat pane

Density + status pills, preserving every testid, `data-*`, the caret, `text-destructive` error class, and render isolation. No structural/subscription changes.

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`
- Test (must stay green): `studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx`

- [ ] **Step 1: Apply the re-skin.** Make exactly these className/structure changes in `ChatRoomPane.tsx`:

1. **`ConnectionIndicator`** — replace the hand-rolled pill `<span>` with `StatusPill`, preserving testid + `data-state`:

```tsx
import { StatusPill } from '@/components/ui/StatusPill';
// ...
function ConnectionIndicator() {
  const s = llmChatHooks.usePluginState();
  const state = s.connection.get();
  const connected = state === 'connected';
  return (
    <StatusPill data-testid="chat-connection" data-state={state} tone={connected ? 'success' : 'warning'}>
      {connected ? 'connected' : `${state}…`}
    </StatusPill>
  );
}
```

2. **`AiStatusLine`** — same treatment, preserving testid + `data-state`:

```tsx
function AiStatusLine() {
  const s = llmChatHooks.usePluginState();
  const st = s.aiStatus.get();
  return (
    <StatusPill data-testid="chat-ai-status" data-state={st.state} tone={st.state === 'idle' ? 'neutral' : 'warning'}>
      AI: {st.state}
      {st.queueDepth > 0 ? ` (${st.queueDepth} queued)` : ''}
    </StatusPill>
  );
}
```

3. **Pane shell** — tighten spacing: change the root `div` className from `flex h-full flex-col gap-3 p-3` to `flex h-full flex-col gap-2 bg-surface p-2.5`.

4. **`MessageList`** — change `gap-3` to `gap-2.5` (keep `data-testid="chat-messages"`, the length-only subscription, and `overflow-auto`).

5. **`PresenceLine` / `TypingLine`** — leave logic; ensure they keep `text-xs text-muted-foreground` (already do). No change required beyond what remains after step 3.

6. **Empty state** — keep `data-testid="chat-empty"`; change `p-8`→`p-6` and `text-lg`→`text-base` for the heading. Leave copy unchanged.

Leave `ChatMessageBubble` (avatar `bg-primary` now renders orange via tokens; caret `bg-primary` likewise), `ErrorBanner` (keeps `text-destructive`), and the composer (`Input` is already compact) unchanged in structure.

- [ ] **Step 2: Run the chat spec — must stay green**

```bash
npx nx test frontend -- studio/frontend/src/plugins/llm-chat/ChatRoomPane.spec.tsx
```

Expected: PASS — all 10 tests (empty state, message render, send, connection `data-state`, **render-isolation count**, author label, caret present/absent, destructive error class).

- [ ] **Step 3: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx
git add studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx
git commit -m "feat(studio): re-skin chat pane (compact + status pills)"
```

---

## Task 12: Re-skin the Settings pane

**Files:**

- Modify: `studio/frontend/src/plugins/llm-chat/SettingsPane.tsx`
- Test (must stay green): `studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx`

- [ ] **Step 1: Re-skin** — add a `PanelHeader` and tighten, preserving `data-testid="chat-settings-pane"`, `data-testid="settings-model"`, the label text "Model (active room)", and the loading/empty option text:

```tsx
import { useEffect, useState } from 'react';
import { getModels, type IModelOption } from './restClient';
import { Card, CardContent } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { PanelHeader } from '@/components/ui/PanelHeader';
import { bumpRenderCount } from '../../app/renderCount';

export function SettingsPane() {
  const [models, setModels] = useState<IModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  bumpRenderCount('SettingsPane');

  useEffect(() => {
    let cancelled = false;
    void getModels()
      .then((m) => {
        if (!cancelled) setModels(m);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="chat-settings-pane" className="flex h-full flex-col overflow-auto bg-surface">
      <PanelHeader label="Settings" />
      <div className="p-2.5">
        <Card>
          <CardContent className="flex flex-col gap-2 pt-2.5">
            <label className="flex flex-col gap-1 text-[13px]">
              Model (active room)
              <Select data-testid="settings-model" defaultValue="">
                <option value="" disabled>
                  {loading ? 'Loading models…' : 'Select a model…'}
                </option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </label>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run the spec — must stay green**

```bash
npx nx test frontend -- studio/frontend/src/plugins/llm-chat/SettingsPane.spec.tsx
```

Expected: PASS. If a test asserted the old `<CardHeader><h2>Settings</h2>` heading text, it still finds "Settings" via the `PanelHeader` label; if it queried the `h2` specifically, update it to `getByText('Settings')`.

- [ ] **Step 3: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/llm-chat/SettingsPane.tsx
git add studio/frontend/src/plugins/llm-chat/SettingsPane.tsx
git commit -m "feat(studio): re-skin Settings pane with PanelHeader"
```

---

## Task 13: Re-skin Asset Board + AssetCard

**Files:**

- Modify: `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`, `studio/frontend/src/plugins/assets/AssetCard.tsx`
- Tests (must stay green): the assets specs under `studio/frontend/src/plugins/assets/`

- [ ] **Step 1: Re-skin `AssetBoardPane.tsx`** — add a `PanelHeader` (label + game id), tighten spacing. Preserve `data-testid` values `asset-board`, `board-no-game`, `new-asset-form`, `asset-name`, `asset-prompt`, `asset-workflow`, `assets-empty`, `asset-grid`.

Change the returned JSX (the `activeGameId` branch) to:

```tsx
import { PanelHeader } from '@/components/ui/PanelHeader';
// ...
return (
  <div className="flex h-full flex-col bg-surface" data-testid="asset-board">
    <PanelHeader label="Asset Board" right={<span className="font-mono">{activeGameId}</span>} />
    <div className="flex flex-1 flex-col gap-2.5 overflow-auto p-2.5">
      <Card>
        <CardContent className="pt-2.5">
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
        <p className="text-xs text-muted-foreground" data-testid="assets-empty">
          No assets yet — add your first asset above, then press Generate.
        </p>
      )}

      <div className="flex flex-wrap gap-2.5" data-testid="asset-grid">
        {Array.from({ length: assetCount }, (_, i) => (
          <AssetCard key={i} index={i} />
        ))}
      </div>
    </div>
  </div>
);
```

Keep the `board-no-game` early-return branch; change its className text size to `text-xs`.

- [ ] **Step 2: Re-skin `AssetCard.tsx`** — compact width, mono workflow chip, keep all testids (`asset-card-${id}`, `asset-selected-image`, `asset-progress`, `asset-generating`, `asset-queued`, `asset-error`, `asset-candidates`, `asset-generate`) and the `text-destructive` error class. Make these className edits:

- Root `Card`: `className="w-64"` → `className="w-56"`.
- Workflow label span: `className="text-xs text-muted-foreground"` → `className="font-mono text-[11px] text-muted-foreground"`.
- Selected-image wrapper: `bg-muted` stays (now the raised token) — no change needed.
- Generate `Button`: keep as-is (now compact + orange).
- Leave the `data-testid="asset-error"` span with `text-xs text-destructive` unchanged.

- [ ] **Step 3: Run the assets specs — must stay green**

```bash
npx nx test frontend -- studio/frontend/src/plugins/assets/AssetCard.spec.tsx
npx nx test frontend -- studio/frontend/src/plugins/assets/index.spec.ts
```

Expected: PASS. (If `AssetCard.spec.tsx` doesn't exist, run the directory: `npx nx test frontend -- studio/frontend/src/plugins/assets`.)

- [ ] **Step 4: Commit**

```bash
npx prettier --write studio/frontend/src/plugins/assets/AssetBoardPane.tsx studio/frontend/src/plugins/assets/AssetCard.tsx
git add studio/frontend/src/plugins/assets/AssetBoardPane.tsx studio/frontend/src/plugins/assets/AssetCard.tsx
git commit -m "feat(studio): re-skin Asset Board + cards (compact, PanelHeader, mono)"
```

---

## Task 14: Re-skin RoomPicker

**Files:**

- Modify: `studio/frontend/src/app/routes/RoomPicker.tsx`
- Test (must stay green): `studio/frontend/src/app/routes/RoomPicker.spec.tsx` (if present) + the `llm-chat.spec.ts` e2e selectors

- [ ] **Step 1: Re-skin** — tighten density only; preserve `data-testid="room-picker"`, the placeholder matching `/new room/i` ("New room name…"), the Create button (`/create/i`), the ghost room rows clickable by exact name, and the loading/error/empty states. Change:

- Root: `className="mx-auto mt-12 w-full max-w-xl p-4"` → `className="mx-auto mt-16 w-full max-w-md p-4"`.
- Heading: `className="mb-4 text-xl font-semibold"` → `className="mb-3 text-base font-semibold"`.
- Loading/error/empty `<p>`: `text-sm` → `text-xs`.
- `CardContent` rooms wrapper: `gap-1 pt-4` → `gap-1 pt-2.5`.

Leave all `Input`/`Button`/`Card` usages and logic unchanged.

- [ ] **Step 2: Run any unit spec + typecheck**

```bash
npx nx test frontend -- studio/frontend/src/app/routes/RoomPicker.spec.tsx 2>/dev/null || echo "no unit spec; covered by e2e"
npx nx run frontend:typecheck
```

Expected: pass / no spec. (The `/new room/i` and `/create/i` e2e selectors are unchanged.)

- [ ] **Step 3: Commit**

```bash
npx prettier --write studio/frontend/src/app/routes/RoomPicker.tsx
git add studio/frontend/src/app/routes/RoomPicker.tsx
git commit -m "feat(studio): re-skin RoomPicker (compact)"
```

---

## Task 15: Re-skin LoginScreen onto tokens + primitives

`LoginScreen` is currently all inline styles. Convert to token classes + primitives; preserve `data-testid="login-screen"`, the `#username` input, "Your name" label, and the "Continue" submit behavior.

**Files:**

- Modify: `studio/frontend/src/app/routes/LoginScreen.tsx`
- Test (must stay green): `studio/frontend/src/app/routes/LoginScreen.spec.tsx`

- [ ] **Step 1: Reimplement**

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useSession } from '../../session/SessionContext';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

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
    <div data-testid="login-screen" className="grid h-screen place-items-center bg-bg font-sans text-foreground">
      <Card className="w-72">
        <CardContent className="pt-2.5">
          <form onSubmit={onSubmit} className="flex flex-col gap-2.5">
            <h1 className="m-0 text-base font-semibold">Bloom Studio</h1>
            <label htmlFor="username" className="text-xs text-muted-foreground">
              Your name
            </label>
            <Input id="username" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. ada" />
            <Button type="submit">Continue</Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Run the spec — must stay green**

```bash
npx nx test frontend -- studio/frontend/src/app/routes/LoginScreen.spec.tsx
```

Expected: PASS (testid, username field, Continue submit, navigation). If a test selected the submit by `getByRole('button', { name: /continue/i })`, it still matches.

- [ ] **Step 3: Commit**

```bash
npx prettier --write studio/frontend/src/app/routes/LoginScreen.tsx
git add studio/frontend/src/app/routes/LoginScreen.tsx
git commit -m "feat(studio): re-skin LoginScreen onto tokens + primitives"
```

---

## Task 16: Full verification + e2e + review + PR

**Files:** none (verification only)

- [ ] **Step 1: Run the full frontend gate** (all four must pass — per the repo's CI gates)

```bash
export PATH="/c/Program Files/nodejs:$PATH"
npx prettier --check .
npx nx run frontend:typecheck
npx nx test frontend
npx nx build frontend
```

Expected: all green. Fix any failure before proceeding; do not claim success without this output.

- [ ] **Step 2: Backend sanity (no changes expected)**

```bash
just preflight
```

Expected: exits 0 (backend not in replay for a human session) — or start the replay backend for e2e per Step 3. (If `just` is unavailable, skip; no backend code changed.)

- [ ] **Step 3: Run the Playwright e2e contract (replay tier, local-only)**

```bash
just backend-serve-replay   # in a separate terminal; leave running
just e2e
```

Expected: all specs green — `llm-chat.spec.ts`, `routing.spec.ts`, `layout*.spec.ts`, `dockview.spec.ts`, asset-board specs. These assert testids/roles/structure, all preserved. Fix any drift.

- [ ] **Step 4: Dark contrast eyeball pass**

```bash
npx nx serve frontend
```

Walk every surface (titlebar, connected tabs, chat, Asset Board + a generation, Settings, RoomPicker, Login). Confirm: fire-orange reserved for active/primary; text legible at 11–13px; no stray light-theme remnants, raw shadows, or oversized controls. Note and fix any token contrast issues (nudge the hex in `styles.css`). Stop the server.

- [ ] **Step 5: Whole-branch code review**

Use the **superpowers:requesting-code-review** skill against the full branch diff. Address findings (token leaks, missed testids, density inconsistencies, render-isolation regressions).

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/visual-identity-dark-editor
gh pr create --fill --base main --title "feat(studio): dark game-editor visual identity"
```

Then `gh pr merge --squash --delete-branch` once checks pass (self-merge OK; `main` requires 0 approvals).

---

## Self-Review (author checklist — completed)

**1. Spec coverage:**

- Tokens / 3-elevation ramp / accent / status / dark-only-light-ready → Task 1. ✓
- Density + radius + type scale → Tasks 1 (base) + 3–5 (control sizing). ✓
- Shape/surface/connected tabs/PanelHeader → Tasks 6, 8. ✓
- Chrome components (PanelHeader, StatusPill, Dockview theme, scrollbars, status pills) → Tasks 1, 6, 7, 8, 10. ✓
- Type delivery (self-host Plex) → Task 2. ✓
- Pane re-skins (chat, assets, settings, room-picker, login, titlebar, ModeBadge) → Tasks 9–15. ✓
- Remove ThemeToggle, keep light-ready seam → Task 9 + token structure in Task 1. ✓
- Testing (TDD units, preserved e2e, full gate) → per-task specs + Task 16. ✓
- Risks (Dockview limits, token-rename churn, render isolation, fonts, contrast) → Task 8 Step 1 discovery + alias mapping in Task 1 + render-isolation constraint + Task 2 + Task 16 Step 4. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases"; every code step shows full code. Reskin steps name exact elements + exact className strings. ✓

**3. Type consistency:** `IButtonProps`, `IPanelHeaderProps`, `IStatusPillProps`, `StatusTone` consistent across tasks; `StatusPill` spreads `...rest` so `data-testid`/`data-state` pass through (used by ConnectionIndicator/AiStatusLine/ModeBadge). Token utility names (`bg-bg`, `bg-surface`, `bg-raised`, `bg-success`, `bg-warning`, `text-faint`, `placeholder:text-faint`, `hover:bg-primary-hover`, `hover:bg-raised-hover`) all defined in the Task 1 `@theme inline` block. ✓

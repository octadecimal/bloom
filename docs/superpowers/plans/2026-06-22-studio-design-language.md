# Studio Design Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace three drifting visual passes with one enforced Linear/floating-card design language — a tiny ruled token set, a native floating-card Dockview model, retokened primitives, a committed source of truth, and a fidelity gate that prevents future drift.

**Architecture:** All work is in `studio/frontend`. The token layer in `styles.css` becomes the single machine source of truth (4 surfaces, 2 hairline weights, 3 text tiers, 1 rationed accent), with the legacy shadcn vars re-pointed onto it so the existing `components/ui/*` layer inherits the language for free. Dockview switches from class-only theming to a typed `DockviewTheme` object (native `gap` + wrapped tab indicator) derived from the official `themeAbyssSpaced`. Components already route through primitives (`Button`/`Card`/`Input`/`StatusPill`/`PanelHeader`), so migration is mostly retokening + removing stray raw colors. A vitest guard plus extended Playwright assertions plus a committed reference screenshot enforce both adherence and fidelity.

**Tech Stack:** React + TypeScript, Tailwind v4 (`@theme inline`), shadcn-style primitives + CVA, dockview-react 6.6.1, Hookstate, Vitest (unit), Playwright (e2e, local-only).

## Global Constraints

- **Scope:** `studio/frontend` only. No backend / protocol / state / reducer / behavior changes.
- **TypeScript interfaces use an `I` prefix** (`IButtonProps`) — repo coding standard.
- **Tokens are authoritative; values copied verbatim from the spec.** Surfaces: `--canvas #08090a`, `--surface #131417`, `--raised #1b1c1f`, `--raised-hover #232427`. Hairlines: `--hairline rgba(255,255,255,0.07)`, `--hairline-strong rgba(255,255,255,0.12)`. Text: `--text-1 #ededef`, `--text-2 #9b9ba4`, `--text-3 #62626b`. Accent: `--accent #f0641e`, `--accent-hover #ff7a33`, `--accent-text #ff8a4d`, `--accent-fg #160a02`, `--selection rgba(240,100,30,0.14)`. Status: `--success #3ec28b`, `--warning #e7b549`, `--danger #f0574d`.
- **The four rules:** (1) only the 4 surfaces, (2) every border is a hairline, (3) accent rationed (active-tab underline · focus ring · selected row · exactly one primary action per region; everything else ghost), (4) 3 text tiers only.
- **Dockview:** `gap: 8`, `tabGroupIndicator: 'wrap'`, theme `className: 'dockview-theme-bloom'`, derived from `themeAbyssSpaced`.
- **TDD mandatory** (RED → GREEN → REFACTOR). Frequent commits, Conventional Commits format.
- **Pre-PR gate (frontend CI parity):** `npx prettier --check .`, `nx typecheck`, `nx test`, `nx build` must all pass, then `just e2e` against a replay backend (start `just backend-serve-replay` first). Browser e2e is NOT in CI — run locally.
- **Environment:** Windows + PowerShell; `node` may not be on PATH in a fresh shell (`export PATH="/c/Program Files/nodejs:$PATH"` in bash if needed).
- Work on branch `docs/studio-design-language` (already created, holds the spec + mockups).

---

### Task 1: Rewrite the token layer in `styles.css`

**Files:**

- Modify: `studio/frontend/src/styles.css:17-103` (the `:root` block, `@theme inline` block, and `body`)
- Test: `studio/frontend/src/styles.tokens.spec.ts` (create)

**Interfaces:**

- Produces: CSS custom properties on `:root` — `--canvas`, `--surface`, `--raised`, `--raised-hover`, `--hairline`, `--hairline-strong`, `--text-1`, `--text-2`, `--text-3`, `--accent`, `--accent-hover`, `--accent-text`, `--accent-fg`, `--selection`, `--success`, `--warning`, `--danger`. Tailwind color utilities exposed via `@theme inline`: `bg-canvas`, `bg-surface`, `bg-raised`, `bg-raised-hover`, `text-1`/`text-2`/`text-3` (as `--color-text-1` etc.), `border-hairline`, `border-hairline-strong`, `bg-accent`/`text-accent`, `text-accent-text`, `text-danger`, `text-success`, `text-warning`. Legacy shadcn names remapped: `--background→--surface`, `--foreground→--text-1`, `--muted→--raised`, `--muted-foreground→--text-2`, `--accent(util)→--raised-hover`, `--border→--hairline`, `--input→--hairline`, `--primary→--accent`, `--primary-foreground→--accent-fg`, `--ring→--accent`, `--destructive→--danger`, `--faint→--text-3`, `--primary-hover→--accent-hover`. Also keeps `--bg` as an alias of `--canvas` and `--surface` unchanged-named so existing `bg-bg`/`bg-surface`/`bg-raised`/`text-faint`/`text-muted-foreground` utilities keep compiling.

- [ ] **Step 1: Write the failing test**

This test locks the authoritative values (machine source of truth) so they can't silently drift.

```ts
// studio/frontend/src/styles.tokens.spec.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');

const EXPECTED: Record<string, string> = {
  '--canvas': '#08090a',
  '--surface': '#131417',
  '--raised': '#1b1c1f',
  '--raised-hover': '#232427',
  '--hairline': 'rgba(255, 255, 255, 0.07)',
  '--hairline-strong': 'rgba(255, 255, 255, 0.12)',
  '--text-1': '#ededef',
  '--text-2': '#9b9ba4',
  '--text-3': '#62626b',
  '--accent': '#f0641e',
  '--accent-hover': '#ff7a33',
  '--accent-text': '#ff8a4d',
  '--accent-fg': '#160a02',
  '--selection': 'rgba(240, 100, 30, 0.14)',
  '--success': '#3ec28b',
  '--warning': '#e7b549',
  '--danger': '#f0574d',
};

describe('design-language token layer', () => {
  for (const [name, value] of Object.entries(EXPECTED)) {
    it(`declares ${name}: ${value}`, () => {
      // Match `  --name: value;` allowing any whitespace run after the colon.
      const re = new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*${value.replace(/[().]/g, (m) => '\\' + m)}\\s*;`);
      expect(css).toMatch(re);
    });
  }

  it('re-points the legacy shadcn names onto the new ramp', () => {
    expect(css).toMatch(/--background:\s*var\(--surface\)\s*;/);
    expect(css).toMatch(/--border:\s*var\(--hairline\)\s*;/);
    expect(css).toMatch(/--primary:\s*var\(--accent\)\s*;/);
    expect(css).toMatch(/--destructive:\s*var\(--danger\)\s*;/);
    expect(css).toMatch(/--muted-foreground:\s*var\(--text-2\)\s*;/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/styles.tokens.spec.ts`
Expected: FAIL — current `styles.css` declares `--bg: #0d1014` etc., none of the new names match.

- [ ] **Step 3: Replace the `:root`, `@theme inline`, and `body` with the new token layer**

Replace `studio/frontend/src/styles.css` lines 17–103 (the comment + `:root {…}` + `@theme inline {…}` + `body {…}`) with:

```css
/*
  Bloom design language — Linear/floating-card. DARK-ONLY today; a future light theme
  supplies a second value-set for these same names (no component changes). Values are
  authoritative and locked by src/styles.tokens.spec.ts. See docs/design-language.md.
*/
:root {
  /* Surfaces — 4 elevations, nothing between */
  --canvas: #08090a; /* app bg · the gap between floating panels · inset field wells */
  --surface: #131417; /* the floating panel card body · active tab shares this */
  --raised: #1b1c1f; /* cards / tiles / inputs sitting on a surface */
  --raised-hover: #232427; /* hover state for raised things & menu items */
  --bg: var(--canvas); /* legacy alias: existing bg-bg / body utilities */

  /* Hairlines — translucent white, exactly 2 weights */
  --hairline: rgba(255, 255, 255, 0.07);
  --hairline-strong: rgba(255, 255, 255, 0.12);

  /* Text — 3 tiers */
  --text-1: #ededef;
  --text-2: #9b9ba4;
  --text-3: #62626b;

  /* Accent — fire orange, rationed */
  --accent: #f0641e;
  --accent-hover: #ff7a33;
  --accent-text: #ff8a4d;
  --accent-fg: #160a02;
  --selection: rgba(240, 100, 30, 0.14);
  --selection-text: #ffb98c;

  /* Status */
  --success: #3ec28b;
  --warning: #e7b549;
  --danger: #f0574d;

  /* Type */
  --font-sans: 'IBM Plex Sans', system-ui, -apple-system, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'Cascadia Code', monospace;

  /* ===== Legacy shadcn names, re-pointed onto the new ramp =====
     Existing utilities (bg-background, bg-muted, hover:bg-accent, bg-primary,
     text-muted-foreground, border-border, text-destructive, ring-ring, text-faint …)
     keep working and inherit the new identity. */
  --background: var(--surface);
  --foreground: var(--text-1);
  --primary: var(--accent);
  --primary-hover: var(--accent-hover);
  --primary-foreground: var(--accent-fg);
  --accent-foreground: var(--text-1);
  --border: var(--hairline);
  --border-strong: var(--hairline-strong);
  --popover: var(--surface);
  --popover-foreground: var(--text-1);
  --muted: var(--raised);
  --muted-foreground: var(--text-2);
  --faint: var(--text-3);
  --ring: var(--accent);
  --input: var(--hairline);
  --destructive: var(--danger);
  --destructive-foreground: #ffffff;
}

@theme inline {
  /* new tokens */
  --color-canvas: var(--canvas);
  --color-surface: var(--surface);
  --color-raised: var(--raised);
  --color-raised-hover: var(--raised-hover);
  --color-bg: var(--bg);
  --color-hairline: var(--hairline);
  --color-hairline-strong: var(--hairline-strong);
  --color-text-1: var(--text-1);
  --color-text-2: var(--text-2);
  --color-text-3: var(--text-3);
  --color-accent-text: var(--accent-text);
  --color-accent-fg: var(--accent-fg);
  --color-selection: var(--selection);
  --color-selection-text: var(--selection-text);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);

  /* legacy names */
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-primary: var(--primary);
  --color-primary-hover: var(--primary-hover);
  --color-primary-foreground: var(--primary-foreground);
  --color-border: var(--border);
  --color-border-strong: var(--border-strong);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-faint: var(--faint);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
}

body {
  background: var(--canvas);
  color: var(--text-1);
  margin: 0;
  font-family: var(--font-sans);
  font-size: 13px;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/styles.tokens.spec.ts`
Expected: PASS (all token + remap assertions green).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/styles.css studio/frontend/src/styles.tokens.spec.ts
git commit -m "feat(studio): rewrite token layer onto the Linear design language"
```

---

### Task 2: Define the `bloomTheme` Dockview theme object

**Files:**

- Create: `studio/frontend/src/app/bloomTheme.ts`
- Test: `studio/frontend/src/app/bloomTheme.spec.ts` (create)

**Interfaces:**

- Consumes: `DockviewTheme`, `themeAbyssSpaced` from `dockview-react`.
- Produces: `export const bloomTheme: DockviewTheme` — `{ name: 'bloom', className: 'dockview-theme-bloom', colorScheme: 'dark', gap: 8, tabGroupIndicator: 'wrap', ... }`. Consumed by `Workbench` (Task 4) via `<DockviewReact theme={bloomTheme} />`.

- [ ] **Step 1: Write the failing test**

```ts
// studio/frontend/src/app/bloomTheme.spec.ts
import { describe, it, expect } from 'vitest';
import { bloomTheme } from './bloomTheme';

describe('bloomTheme', () => {
  it('is the floating-card model: 8px gap between groups', () => {
    expect(bloomTheme.gap).toBe(8);
  });
  it('uses the wrapped active-tab indicator', () => {
    expect(bloomTheme.tabGroupIndicator).toBe('wrap');
  });
  it('targets our CSS via the dockview-theme-bloom class and is dark', () => {
    expect(bloomTheme.className).toBe('dockview-theme-bloom');
    expect(bloomTheme.colorScheme).toBe('dark');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd studio/frontend && npx vitest run src/app/bloomTheme.spec.ts`
Expected: FAIL — `Cannot find module './bloomTheme'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// studio/frontend/src/app/bloomTheme.ts
import { themeAbyssSpaced, type DockviewTheme } from 'dockview-react';

// Floating-card model (mockup C): derived from the official "Spaced" theme so the
// gap/border/radius layout is a proven base; we override only the palette via the
// .dockview-theme-bloom CSS in styles.css. `gap` is a LAYOUT value (it changes the
// grid math) so it must travel on the theme object, not just CSS.
export const bloomTheme: DockviewTheme = {
  ...themeAbyssSpaced,
  name: 'bloom',
  className: 'dockview-theme-bloom',
  colorScheme: 'dark',
  gap: 8,
  tabGroupIndicator: 'wrap',
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd studio/frontend && npx vitest run src/app/bloomTheme.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/bloomTheme.ts studio/frontend/src/app/bloomTheme.spec.ts
git commit -m "feat(studio): add bloomTheme dockview theme (floating cards, gap 8, wrap)"
```

---

### Task 3: Wire `bloomTheme` into the Workbench and simplify `useApplyTheme`

**Files:**

- Modify: `studio/frontend/src/app/Workbench.tsx:29-31` (pass `theme={bloomTheme}`)
- Modify: `studio/frontend/src/app/useApplyTheme.ts` (stop hand-adding the dockview class; the theme prop applies it)
- Test: existing `studio/frontend/e2e/dockview.spec.ts` + new assertions in Task 7 cover this at runtime; unit-level there is nothing new to assert beyond Task 2.

**Interfaces:**

- Consumes: `bloomTheme` (Task 2).
- Produces: `<DockviewReact theme={bloomTheme} />`; `useApplyTheme` now only ensures the document `dark` class.

- [ ] **Step 1: Update `useApplyTheme.ts`**

The Dockview theme `className` is applied by the `theme` prop, so `useApplyTheme` only needs to keep the app in dark mode.

```ts
// studio/frontend/src/app/useApplyTheme.ts
import { useEffect } from 'react';

// Dark-only app. The Dockview group classes are applied by the <DockviewReact theme={…}>
// prop (see bloomTheme); this hook only guarantees the document stays in dark mode.
export function useApplyTheme(): void {
  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);
}
```

- [ ] **Step 2: Update `Workbench.tsx`**

Change the import line, the `useApplyTheme` call (no longer needs `dockEl`), and pass the theme. Replace the body of `Workbench`:

```tsx
import { useState, type ReactNode } from 'react';
import { DockviewReact, type DockviewReadyEvent } from 'dockview-react';
import { useApp } from './AppContext';
import { useApplyTheme } from './useApplyTheme';
import { bloomTheme } from './bloomTheme';
import { AppMenubar } from './Menubar';
import { CommandPalette } from './CommandPalette';
import { SwitchUser } from './SwitchUser';
import { ModeBadge } from './ModeBadge';

export function Workbench({ leading }: { leading?: ReactNode }) {
  const app = useApp();
  const [, setDockEl] = useState<HTMLElement | null>(null);
  useApplyTheme();

  return (
    <div data-testid="workbench" className="flex h-screen flex-col bg-canvas font-sans text-foreground">
      <div className="flex h-9 flex-shrink-0 items-center justify-between border-b border-hairline bg-canvas px-2.5">
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
        <DockviewReact theme={bloomTheme} components={app.components as never} onReady={(e: DockviewReadyEvent) => app.attachDockview(e.api)} />
      </div>
    </div>
  );
}
```

Note: `text-foreground` is the existing text-color utility (remapped to `--text-1` in Task 1); `bg-canvas`/`border-hairline` are the new surface/hairline utilities from Task 1. Do NOT use a `text-1` class — Tailwind v4 would generate the primary-text utility as `text-text-1`, so use the remapped `text-foreground`/`text-muted-foreground`/`text-faint` instead. (If the project's existing `dockview.spec.ts` asserts the `dockview-theme-bloom` class is present, it still passes because the theme prop applies it.)

- [ ] **Step 3: Typecheck**

Run: `cd studio/frontend && npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS (no type errors; `theme` is a valid `DockviewReact` prop).

- [ ] **Step 4: Smoke the unit suite**

Run: `cd studio/frontend && npx vitest run src/app`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/app/Workbench.tsx studio/frontend/src/app/useApplyTheme.ts
git commit -m "feat(studio): drive dockview via the bloomTheme prop (native gap + wrap)"
```

---

### Task 4: Style the Dockview group as a floating card

**Files:**

- Modify: `studio/frontend/src/styles.css:125-156` (the `.dockview-theme-bloom` block)
- Test: covered at runtime by Task 7's Playwright invariants (group border = hairline, radius 9px, gap visible, active-tab underline = accent).

**Interfaces:**

- Consumes: tokens from Task 1; the `dockview-theme-bloom` class applied by `bloomTheme`.
- Produces: per-group floating-card CSS.

- [ ] **Step 1: Replace the `.dockview-theme-bloom` block**

Replace lines 125–156 of `styles.css` with:

```css
/* === Dockview "bloom" theme: floating panel cards on the canvas (mockup C) === */
.dockview-theme-bloom {
  --dv-group-view-background-color: var(--surface);
  --dv-tabs-and-actions-container-background-color: var(--surface);
  --dv-activegroup-visiblepanel-tab-background-color: var(--surface);
  --dv-activegroup-hiddenpanel-tab-background-color: transparent;
  --dv-inactivegroup-visiblepanel-tab-background-color: var(--surface);
  --dv-inactivegroup-hiddenpanel-tab-background-color: transparent;
  --dv-activegroup-visiblepanel-tab-color: var(--text-1);
  --dv-activegroup-hiddenpanel-tab-color: var(--text-2);
  --dv-inactivegroup-visiblepanel-tab-color: var(--text-1);
  --dv-inactivegroup-hiddenpanel-tab-color: var(--text-2);
  --dv-tab-divider-color: transparent;
  --dv-separator-border: transparent;
  --dv-paneview-active-outline-color: var(--accent);
  --dv-icon-hover-background-color: var(--raised-hover);
  --dv-activegroup-visiblepanel-tab-border-color: var(--accent);
  --dv-tab-font-size: 12px;
  background: var(--canvas); /* shows through the 8px gap between groups */
  color: var(--text-1);
}

/* Each group is a rounded, hairline-bordered card floating on the canvas. */
.dockview-theme-bloom .dv-groupview {
  border: 1px solid var(--hairline);
  border-radius: 9px;
  overflow: hidden;
}

/* The wrapped active-tab indicator is the accent underline (model C signal). */
.dockview-theme-bloom .dv-active-tab .dv-default-tab-content {
  color: var(--text-1);
}

/* Resizer sash is invisible until hovered; the canvas gap provides the separation. */
.dockview-theme-bloom .dv-sash {
  background: transparent;
}
.dockview-theme-bloom .dv-sash:hover {
  background: var(--hairline-strong);
}
```

- [ ] **Step 2: Manually verify the build compiles the CSS**

Run: `cd studio/frontend && npx vite build`
Expected: build succeeds (Tailwind + CSS compile, no unresolved `var()` errors). Full visual verification happens in Task 7.

- [ ] **Step 3: Commit**

```bash
git add studio/frontend/src/styles.css
git commit -m "feat(studio): render dockview groups as floating hairline cards"
```

---

### Task 5: Retoken the UI primitives

**Files:**

- Modify: `studio/frontend/src/components/ui/input.tsx` (raised well, text-3 placeholder, accent ring)
- Modify: `studio/frontend/src/components/ui/button.tsx` (ghost gets a hairline-strong edge; outline uses hairline)
- Modify: `studio/frontend/src/components/ui/StatusPill.tsx` (text-2 label, dot tones onto tokens)
- Modify: `studio/frontend/src/components/ui/card.tsx` (radius 8px; border already `border-border`→hairline)
- Modify: `studio/frontend/src/components/ui/PanelHeader.tsx` (label `text-2`)
- Test: `studio/frontend/src/components/ui/input.spec.tsx`, `button.spec.tsx`, `StatusPill.spec.tsx` (extend existing)

**Interfaces:**

- Consumes: token utilities from Task 1.
- Produces: primitives whose classes reference only token utilities. No signature changes.

- [ ] **Step 1: Write/extend the failing tests**

Add to `studio/frontend/src/components/ui/input.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Input } from './input';

describe('Input is a raised field well with token chrome', () => {
  it('uses the raised surface and a hairline border', () => {
    render(<Input data-testid="f" placeholder="Name" />);
    const el = screen.getByTestId('f');
    expect(el.className).toContain('bg-raised');
    expect(el.className).toContain('border-input'); // → --hairline via remap
    expect(el.className).toContain('placeholder:text-faint'); // → --text-3 via remap
    expect(el.className).toContain('focus-visible:ring-ring'); // → --accent via remap
  });
});
```

Add to `studio/frontend/src/components/ui/button.spec.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Button } from './button';

describe('Button variants follow accent rationing', () => {
  it('primary is the only accent fill', () => {
    render(<Button data-testid="b">Go</Button>);
    expect(screen.getByTestId('b').className).toContain('bg-primary'); // → --accent
  });
  it('ghost carries a hairline-strong edge, no fill', () => {
    render(
      <Button data-testid="g" variant="ghost">
        x
      </Button>,
    );
    const c = screen.getByTestId('g').className;
    expect(c).toContain('bg-transparent');
    expect(c).toContain('border-border-strong');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd studio/frontend && npx vitest run src/components/ui/input.spec.tsx src/components/ui/button.spec.tsx`
Expected: FAIL — Input still uses `bg-bg`; ghost variant lacks `border-border-strong`.

- [ ] **Step 3: Apply the retokens**

`input.tsx` — swap the well surface and keep token border/ring:

```tsx
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-7 rounded border border-input bg-raised px-2.5 text-[13px] outline-none placeholder:text-faint',
        'focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
});
```

`button.tsx` — give `ghost` a hairline-strong edge and point `outline` at the hairline:

```tsx
const buttonVariants = cva(
  'inline-flex items-center justify-center rounded font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary-hover',
        outline: 'border border-border bg-transparent hover:bg-raised-hover',
        ghost: 'border border-border-strong bg-transparent text-foreground hover:bg-raised-hover',
        destructive: 'bg-destructive text-destructive-foreground hover:opacity-90',
        accentOutline: 'border border-primary/45 bg-transparent text-accent-text hover:bg-primary/10',
      },
      size: { default: 'h-7 px-3 text-[13px]', sm: 'h-6 px-2.5 text-xs', icon: 'h-7 w-7' },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
```

`StatusPill.tsx` — the label text moves to `text-muted-foreground` (already `text-2` via remap; no change needed if already `text-muted-foreground`). Confirm the wrapper uses `bg-raised text-muted-foreground`; the file already does — no edit required unless it drifts. If the current `text-[11px] text-muted-foreground` is present, leave it.

`card.tsx` — bump radius to match the spec's 8px tiles: change `rounded-md` to `rounded-lg` on the `Card` root.

```tsx
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-border bg-raised', className)} {...props} />;
}
```

`PanelHeader.tsx` — the label already uses `text-muted-foreground` (→ `--text-2`); no change required. Leave the file unless a raw color is present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd studio/frontend && npx vitest run src/components/ui`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src/components/ui
git commit -m "feat(studio): retoken primitives (raised fields, ghost hairline edge)"
```

---

### Task 6: No-raw-color guard + remove stragglers

**Files:**

- Create: `studio/frontend/src/design-language.guard.spec.ts`
- Modify: any source file the guard flags (expected candidates: inline `style={{ ... }}` colors, leftover hex/`rgb()`/`hsl()` in `.tsx`)
- Test: the guard itself is the test.

**Interfaces:**

- Consumes: nothing.
- Produces: a CI-affordable vitest guard that fails if any `studio/frontend/src` file outside `styles.css` contains a raw color literal without an explicit allow-comment.

- [ ] **Step 1: Write the failing guard**

```ts
// studio/frontend/src/design-language.guard.spec.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative } from 'node:path';
import { globSync } from 'node:fs'; // node >=22; if unavailable use fast-glob
import { describe, it, expect } from 'vitest';

const srcDir = dirname(fileURLToPath(new URL('./design-language.guard.spec.ts', import.meta.url)));

// Raw color literals that must not appear in component code (tokens live in styles.css).
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const FUNC = /\b(?:rgb|rgba|hsl|hsla)\s*\(/;

function listSources(): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: srcDir })
    .filter((p) => !p.endsWith('styles.css'))
    .filter((p) => !p.endsWith('.guard.spec.ts'))
    .filter((p) => !p.endsWith('styles.tokens.spec.ts'));
}

describe('no raw colors outside the token layer', () => {
  it('every component sources its color from a token utility', () => {
    const offenders: string[] = [];
    for (const rel of listSources()) {
      const text = readFileSync(`${srcDir}/${rel}`, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (line.includes('design-allow-color')) return; // explicit escape hatch
        if (HEX.test(line) || FUNC.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(offenders, `Raw colors found (use a token utility or add // design-allow-color):\n${offenders.join('\n')}`).toEqual([]);
  });
});
```

If `node:fs` `globSync` is not available in the project's Node, use the already-installed glob/fast-glob (`import { globSync } from 'fast-glob'`) — check `node_modules` and prefer whichever exists.

- [ ] **Step 2: Run the guard to see the offenders**

Run: `cd studio/frontend && npx vitest run src/design-language.guard.spec.ts`
Expected: FAIL with a list of offending `file:line` entries (e.g. any inline `style` colors, leftover `hsl()` avatar code, candidate-image `outline` literals).

- [ ] **Step 3: Fix each offender**

For every flagged line, replace the raw color with a token utility class, OR — if the value is genuinely dynamic/legitimate (e.g. a backend-provided image tint) — append `// design-allow-color` with a one-line reason. Do NOT blanket-allow; prefer tokens. Example fix for the candidate-image selection outline in `AssetCard.tsx:88` (`outline: '2px solid currentColor'` is already token-free via `currentColor` and passes; no change). Re-run after each fix.

- [ ] **Step 4: Run the guard to verify it passes**

Run: `cd studio/frontend && npx vitest run src/design-language.guard.spec.ts`
Expected: PASS (offenders list empty).

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src
git commit -m "test(studio): guard against raw colors outside the token layer"
```

---

### Task 7: Component migration sweep (visible surfaces onto tokens)

**Files:**

- Modify (only where a raw color or off-token utility exists): `studio/frontend/src/plugins/assets/AssetBoardPane.tsx`, `studio/frontend/src/plugins/assets/AssetCard.tsx`, `studio/frontend/src/plugins/llm-chat/ChatRoomPane.tsx`, `studio/frontend/src/plugins/llm-chat/SettingsPane.tsx`, `studio/frontend/src/app/Menubar.tsx`, `studio/frontend/src/app/CommandPalette.tsx`, `studio/frontend/src/app/SwitchUser.tsx`, `studio/frontend/src/app/ModeBadge.tsx`, `studio/frontend/src/app/SaveLayoutDialog.tsx`, `studio/frontend/src/plugins/demo-counter/CounterPane.tsx`, `studio/frontend/src/plugins/demo-counter/MirrorPane.tsx`, `studio/frontend/src/plugins/demo-scratch/ScratchPane.tsx`
- Test: existing component `*.spec.tsx` suites + the Task 6 guard (already green) + Task 8 e2e.

**Interfaces:**

- Consumes: primitives (Task 5), tokens (Task 1).
- Produces: every visible surface drawing only from tokens; each region has exactly one primary (accent) action.

- [ ] **Step 1: Audit each file for off-token utilities**

Run: `cd studio/frontend && npx grep -rn "bg-bg\|text-faint" src/plugins src/app` (or use ripgrep). For each hit, decide: is the surface a _field well/gutter_ (keep `bg-canvas`) or a _pane/card_ (`bg-surface`/`bg-raised`)? `AssetBoardPane` root is `bg-surface` (correct — it's a pane body). Confirm panes use `bg-surface`, cards `bg-raised`, inset wells `bg-canvas`.

- [ ] **Step 2: Verify accent rationing per region**

For each pane, confirm at most one accent-filled (`variant="default"`) Button per region. Known good: `AssetBoardPane` "Add asset" = `default` (the form's one primary); `AssetCard` Generate = `accentOutline`, Delete = `ghost`. `ChatRoomPane` Send = `default` (composer's one primary). If any region has two `default` buttons, demote the secondary to `ghost`.

- [ ] **Step 3: Run the full unit suite**

Run: `cd studio/frontend && npx vitest run`
Expected: PASS (token changes don't alter behavior; specs that assert `bg-primary`/`border-input` still hold via the remap).

- [ ] **Step 4: Run the guard**

Run: `cd studio/frontend && npx vitest run src/design-language.guard.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/src
git commit -m "refactor(studio): route all visible surfaces through design tokens"
```

---

### Task 8: Fidelity gate — Playwright computed-style invariants + reference screenshot

**Files:**

- Modify: `studio/frontend/e2e/theme.spec.ts` (add invariants + screenshot step)
- Create: `docs/design-language/reference-workbench.png` (committed artifact, produced by the screenshot step)
- Test: this IS the e2e fidelity test.

**Interfaces:**

- Consumes: the running app (replay backend on :8000) via `gotoWorkbench` from `./helpers`.
- Produces: runtime assertions of the design language + a committed reference screenshot.

- [ ] **Step 1: Add the invariants to `theme.spec.ts`**

Append these tests (keep the existing dark-only test). They assert the language against the REAL shell, not pixels.

```ts
import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('docked groups are floating hairline cards on the canvas', async ({ page }) => {
  await gotoWorkbench(page);
  const group = page.locator('.dockview-theme-bloom .dv-groupview').first();
  await expect(group).toBeVisible();
  const { radius, borderColor, borderWidth } = await group.evaluate((el) => {
    const s = getComputedStyle(el);
    return { radius: s.borderTopLeftRadius, borderColor: s.borderTopColor, borderWidth: s.borderTopWidth };
  });
  expect(radius).toBe('9px');
  expect(borderWidth).toBe('1px');
  // hairline = rgba(255,255,255,0.07)
  expect(borderColor.replace(/\s/g, '')).toBe('rgba(255,255,255,0.07)');
});

test('the canvas token is the near-black app background', async ({ page }) => {
  await gotoWorkbench(page);
  const canvas = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--canvas').trim());
  expect(canvas).toBe('#08090a');
});

test('reference screenshot of the workbench (committed fidelity artifact)', async ({ page }) => {
  await gotoWorkbench(page);
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.screenshot({ path: 'docs/design-language/reference-workbench.png' });
});
```

- [ ] **Step 2: Start a replay backend**

Run (separate terminal): `just backend-serve-replay`
Verify: `http://localhost:8000/health` reports `providerMode: replay`.

- [ ] **Step 3: Run the theme spec**

Run: `just e2e -- e2e/theme.spec.ts` (or `npx playwright test --config=studio/frontend/playwright.config.ts theme.spec.ts`)
Expected: all theme tests PASS; `docs/design-language/reference-workbench.png` is written.

- [ ] **Step 4: Eyeball the screenshot against the mockup**

Open `docs/design-language/reference-workbench.png` next to `docs/design-language/mockup-tokens.html`. Confirm: floating panel cards with gaps, hairline borders, near-black canvas, single accent button per region, underline active tab. If it diverges, fix the CSS (Task 4) and re-shoot before continuing.

- [ ] **Step 5: Commit**

```bash
git add studio/frontend/e2e/theme.spec.ts docs/design-language/reference-workbench.png
git commit -m "test(studio): fidelity gate — dockview invariants + reference screenshot"
```

---

### Task 9: Canonical source of truth — `docs/design-language.md` + AGENTS.md link

**Files:**

- Create: `docs/design-language.md`
- Modify: `AGENTS.md` (add a link under "Coding standards"/"Tooling")
- Test: none (docs) — verified by review.

**Interfaces:**

- Consumes: the committed mockups + reference screenshot.
- Produces: the human/agent source of truth, loaded into every future session via AGENTS.md.

- [ ] **Step 1: Write `docs/design-language.md`**

Contents (fill with the real values from this plan's Global Constraints): intro ("This is the authoritative design language; every studio surface MUST follow it"), the 4 surfaces / 2 hairlines / 3 text tiers / accent tables (copied verbatim), the four rules, the primitive catalog (`Button`/`Card`/`Input`/`StatusPill`/`PanelHeader` and when to use each), the Dockview floating-card model (`bloomTheme`, gap 8, wrap), an embedded `![reference](design-language/reference-workbench.png)`, links to the three mockups, and the fidelity-gate description (no-raw-color guard + Playwright invariants + reference screenshot). End with: "Changing a token value requires updating `src/styles.tokens.spec.ts`; adding a surface/border/text tier is a design change, not an implementation detail — get sign-off."

- [ ] **Step 2: Link it from `AGENTS.md`**

Under the "## Coding standards" section, add:

```markdown
- The **studio visual design language** is authoritative and lives in
  [`docs/design-language.md`](docs/design-language.md) — 4 surfaces, 2 hairlines,
  3 text tiers, 1 rationed accent, floating-card Dockview model. All
  `studio/frontend` UI MUST follow it; raw colors outside `styles.css` are blocked
  by a guard test.
```

- [ ] **Step 3: Format the docs**

Run: `cd /c/code/bloom && npx prettier --write docs/design-language.md AGENTS.md`
Expected: formatted, no errors.

- [ ] **Step 4: Commit**

```bash
git add docs/design-language.md AGENTS.md
git commit -m "docs: add authoritative studio design language + link from AGENTS.md"
```

---

### Task 10: Pre-PR verification gate

**Files:** none (verification only).

- [ ] **Step 1: Prettier**

Run: `cd /c/code/bloom && npx prettier --check .`
Expected: "All matched files use Prettier code style!" (if not, `--write` and re-commit).

- [ ] **Step 2: Typecheck**

Run: `npx nx typecheck frontend` (or `cd studio/frontend && npx tsc -p tsconfig.app.json --noEmit`)
Expected: no type errors.

- [ ] **Step 3: Unit tests**

Run: `npx nx test frontend` (includes `styles.tokens.spec`, `bloomTheme.spec`, primitive specs, the guard)
Expected: all PASS.

- [ ] **Step 4: Build**

Run: `npx nx build frontend`
Expected: build succeeds.

- [ ] **Step 5: Full e2e against replay backend**

Run (with `just backend-serve-replay` up): `just e2e`
Expected: full Playwright suite PASS — confirms no testid/behavior regressions from the retokening, and the fidelity invariants hold.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin docs/studio-design-language
gh pr create --fill
```

---

## Self-Review

**Spec coverage:**

- Token system (4/2/3/1 + values) → Task 1. ✓
- Legacy shadcn remap → Task 1. ✓
- `bloomTheme` (gap 8, wrap, from themeAbyssSpaced) → Task 2; wired via theme prop → Task 3. ✓
- Floating-card group CSS → Task 4. ✓
- Primitive catalog (Card/Field/Button/Pill/PanelHeader) → Task 5. ✓
- Component migration → Task 7 (+ guard-driven cleanup in Task 6). ✓
- No-raw-color check → Task 6. ✓
- Playwright computed-style invariants in theme.spec.ts → Task 8. ✓
- Reference screenshot → Task 8. ✓
- docs/design-language.md linked from AGENTS.md → Task 9. ✓
- CI-cost policy (guard CI-affordable; e2e local) → guard is vitest (CI), screenshot/invariants are Playwright (local). ✓
- Pre-PR gate (prettier/typecheck/test/build + just e2e) → Task 10. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code. Task 7 is an audit-and-fix sweep whose acceptance is the guard (Task 6) staying green + full unit suite — concrete and checkable.

**Type consistency:** `bloomTheme: DockviewTheme` defined in Task 2 is consumed unchanged in Task 3. Token utility names (`bg-canvas`, `text-1`, `border-hairline`, `border-border-strong`, `bg-raised`) introduced in Task 1's `@theme inline` are used consistently in Tasks 3–5. `design-allow-color` escape-hatch string is defined and referenced only in Task 6.

**Risk note:** Task 6's `globSync` import — verify Node version / fall back to `fast-glob` (already a transitive dep of the toolchain). If neither is present, the guard can read the file list via a small recursive `readdirSync` walk; keep the guard itself dependency-free if possible.

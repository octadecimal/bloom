# Preview No-Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the scrollbars in the runtime game-engine preview iframe by sealing its DOM container against overflow, without touching the (correct) viewport fit math.

**Architecture:** The Pixi canvas already sizes to exactly `host.clientWidth × clientHeight`. The scrollbars come from CSS around the canvas: an inline-`<canvas>` baseline descender gap, `100vw` including the scrollbar gutter, and fractional-DPR sub-pixel rounding. Fix is CSS-only in `runtime/client/index.html` (block canvas + `100%` sizing + an `overflow: hidden` backstop), guarded by a new no-overflow e2e assertion.

**Tech Stack:** Vite + TypeScript runtime client, Pixi.js v8 renderer, Playwright e2e.

## Global Constraints

- Scope is `runtime/client` only — the studio outer shell is out of scope (the scrollbars are confirmed to be inside the preview iframe).
- Do not change the viewport fit math (`viewport.ts`, `viewportController.ts`, `pixiRenderer.applyViewport`) — it is correct.
- TypeScript interfaces use an `I` prefix (repo coding standard) — not exercised here but observe it if any type is added.
- Browser e2e is NOT run in CI; it runs locally via the runtime Playwright config. The webServer auto-starts `npx nx serve client`; the runtime port derives from `BLOOM_PORT_OFFSET` (this worktree = offset 1 → `http://localhost:4301`).
- Markdown and source must pass the pinned prettier (`node_modules/.bin/prettier`), not `npx prettier`.

---

### Task 1: No-overflow e2e contract + CSS container seal

The test and the CSS fix are a single reviewable deliverable: the test encodes "the preview never scrolls," and the CSS change is what makes it pass. The assertion checks `scrollHeight/scrollWidth` against `clientHeight/clientWidth` — note that `overflow: hidden` does **not** fake-pass this (it clips but `scrollHeight` still reports true content size), so the test proves the _structural_ fix (block canvas + `100%` sizing), not the backstop masking it.

**Files:**

- Create: `runtime/client/e2e/no-overflow.e2e.spec.ts`
- Modify: `runtime/client/index.html` (the `<style>` block, lines 7–18)

**Interfaces:**

- Consumes: the runtime page's standalone doc-load path — `GET /?doc=data:application/json,<encoded ISceneDocument>` mounts the Pixi canvas (same mechanism the existing `viewport.e2e.spec.ts` relies on). The page exposes a `<canvas>` under `#stage` once mounted.
- Produces: nothing consumed by later tasks (terminal task).

- [ ] **Step 1: Write the failing test**

Create `runtime/client/e2e/no-overflow.e2e.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

// A minimal scene doc so the engine mounts its canvas (mirrors viewport.e2e.spec.ts).
const DOC = encodeURIComponent(
  JSON.stringify({
    version: 1,
    nodes: {
      root: {
        id: 'root',
        type: 'Root',
        props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
      },
    },
    edges: [],
  }),
);

type Overflow = { sh: number; ch: number; sw: number; cw: number };

async function measure(page: import('@playwright/test').Page): Promise<Overflow> {
  return page.evaluate(() => {
    const el = document.scrollingElement as HTMLElement;
    return { sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth };
  });
}

for (const { name, width, height } of [
  { name: 'landscape', width: 1000, height: 450 },
  { name: 'portrait', width: 450, height: 1000 },
]) {
  test(`runtime preview does not overflow in ${name}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/?doc=data:application/json,${DOC}`);

    // Wait for the canvas to mount — the inline-baseline gap (if any) only exists once it's present.
    await expect.poll(() => page.evaluate(() => !!document.querySelector('#stage canvas'))).toBe(true);

    const o = await measure(page);
    expect(o.sh, 'no vertical overflow').toBeLessThanOrEqual(o.ch);
    expect(o.sw, 'no horizontal overflow').toBeLessThanOrEqual(o.cw);
  });
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd runtime/client
npx playwright test e2e/no-overflow.e2e.spec.ts
```

Expected: FAIL — the vertical assertion trips because the inline `<canvas>` adds a ~4–5px baseline descender below the `100vh` `#stage`, so `scrollHeight > clientHeight` (and likely the horizontal assertion too, from `100vw` + the resulting gutter).

- [ ] **Step 3: Apply the CSS container seal**

In `runtime/client/index.html`, replace the `<style>` block (currently lines 7–18) with:

```html
<style>
  html,
  body {
    margin: 0;
    height: 100%;
    overflow: hidden; /* backstop for sub-pixel rounding on fractional DPR */
    background: #0b0b0c;
  }
  #stage {
    width: 100%; /* not 100vw — excludes the scrollbar gutter and matches
                    the clientWidth ViewportController measures */
    height: 100%;
  }
  #stage canvas {
    display: block; /* kill the inline baseline descender gap */
  }
</style>
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd runtime/client
npx playwright test e2e/no-overflow.e2e.spec.ts
```

Expected: PASS — both orientations report `scrollHeight <= clientHeight` and `scrollWidth <= clientWidth`. (If this passes only because of `overflow: hidden`, it would _not_ — `overflow: hidden` clips but does not shrink `scrollHeight`; passing confirms the block-canvas + `100%` structural fix is doing the work.)

- [ ] **Step 5: Run the existing viewport e2e to confirm no regression**

```bash
cd runtime/client
npx playwright test e2e/viewport.e2e.spec.ts
```

Expected: PASS — the fit math is unchanged; canvas still fills the host (the `canvasWidth ≈ host width` assertions hold).

- [ ] **Step 6: Commit**

```bash
git add runtime/client/index.html runtime/client/e2e/no-overflow.e2e.spec.ts
git commit -m "fix(runtime): seal preview container against overflow scrollbars"
```

---

## Self-Review

**Spec coverage:**

- Root cause #1 (inline canvas baseline gap) → `#stage canvas { display: block }` (Task 1, Step 3). ✓
- Root cause #2 (`100vw` scrollbar gutter) → `#stage { width: 100% }` (Task 1, Step 3). ✓
- Root cause #3 (fractional-DPR sub-pixel rounding) → `html, body { overflow: hidden }` backstop (Task 1, Step 3). ✓
- Testing requirement (no-overflow e2e assertion in `runtime/client/e2e/`, multiple sizes/orientations) → `no-overflow.e2e.spec.ts`, landscape + portrait (Task 1, Steps 1–2). ✓
- Out-of-scope guardrails (no studio changes, no fit-math changes) → encoded in Global Constraints and the regression check at Step 5. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full content. ✓

**Type consistency:** The test references only existing runtime surfaces (`#stage`, `<canvas>`, the `?doc=` load path) used identically in `viewport.e2e.spec.ts`. No new types introduced. ✓

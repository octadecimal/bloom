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

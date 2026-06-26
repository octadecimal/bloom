// runtime/client/e2e/reels.e2e.spec.ts
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const RUNTIME_URL = `http://localhost:${4300 + offset}`;

const HARNESS = `
  <iframe id="engine" src="${RUNTIME_URL}/" width="640" height="480" style="border:0"></iframe>
  <script>
    window.__inbound = [];
    const frame = document.getElementById('engine');
    window.addEventListener('message', (e) => window.__inbound.push(e.data));
    window.send = (msg) => frame.contentWindow.postMessage(msg, '*');
    window.engineModel = () => frame.contentWindow.__engineModel.toDocument();
    window.engineModules = () => frame.contentWindow.__engineModules;
  </script>`;

async function bootRoot(page: import('@playwright/test').Page) {
  await page.goto('/');
  await page.setContent(HARNESS);
  await expect.poll(() => page.evaluate(() => (window as any).__inbound.some((m: any) => m.kind === 'ready'))).toBe(true);
  await page.evaluate(() => {
    (window as any).send({ v: 1, kind: 'op', id: 'r', op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
  });
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes.root != null)).toBe(true);
}

test('a spin round projects reels, spins, and settles to the fixture outcome', async ({ page }) => {
  await bootRoot(page);

  // Fixture outcome: 5 reels, 3 rows each.
  const outcome = {
    grid: [
      ['A', 'B', 'C'],
      ['B', 'C', 'D'],
      ['C', 'D', 'E'],
      ['D', 'E', 'A'],
      ['E', 'A', 'B'],
    ],
  };
  await page.evaluate((o) => (window as any).send({ v: 1, kind: 'spin', id: 'spin1', outcome: o }), outcome);

  // Structure plane: reel containers + cells are now persisted nodes in the model.
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:reel:0'] != null)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:cell:0:0'] != null)).toBe(true);

  // Behavior plane: it settles to idle with the fixture grid, and reels:settled fired once.
  await expect.poll(() => page.evaluate(() => (window as any).engineModules().state().phase), { timeout: 5000 }).toBe('idle');
  const grid = await page.evaluate(() => (window as any).engineModules().state().grid);
  expect(grid).toEqual([
    ['A', 'B', 'C'],
    ['B', 'C', 'D'],
    ['C', 'D', 'E'],
    ['D', 'E', 'A'],
    ['E', 'A', 'B'],
  ]);
  const settledCount = await page.evaluate(() => (window as any).engineModules().settled().length);
  expect(settledCount).toBe(1);
});

test('editing config (cols 5 -> 6) reprojects and adds a reel without duplicating', async ({ page }) => {
  await bootRoot(page);

  await page.evaluate(() => (window as any).engineModules().project());
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:reel:4'] != null)).toBe(true);
  const before = await page.evaluate(() => Object.keys((window as any).engineModel().nodes).length);

  await page.evaluate(() => (window as any).engineModules().setConfig({ cols: 6 }));

  // New reel appears; existing reels are not duplicated.
  await expect.poll(() => page.evaluate(() => (window as any).engineModel().nodes['reels:reel:5'] != null)).toBe(true);
  const after = await page.evaluate(() => Object.keys((window as any).engineModel().nodes).length);
  // One extra reel container + (rows+buffer) cells; strictly more, and reel:0 still present.
  expect(after).toBeGreaterThan(before);
  expect(await page.evaluate(() => (window as any).engineModel().nodes['reels:reel:0'] != null)).toBe(true);
});

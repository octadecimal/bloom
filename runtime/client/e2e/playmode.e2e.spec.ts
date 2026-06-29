// runtime/client/e2e/playmode.e2e.spec.ts
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const SERVER = `http://localhost:${9000 + offset}`;
const DEMO_SYMBOLS = ['0', '1', '2', '9'];

test('direct play-mode renders the grid from handshake and settles a server spin', async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}`);

  // Handshake built the scene: the demo presentation is 3 reels x 3 rows.
  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes['reels:reel:2'] != null), { timeout: 15000 }).toBe(true);

  // The Spin button is revealed after a successful handshake.
  await expect(page.locator('#spin')).toBeVisible();

  await page.click('#spin');

  // The reels settle to idle with a server-dictated grid of the right shape.
  // Poll the grid length: settledGrid is populated only by finishSettle() (which also
  // sets phase→idle), so this guard avoids catching the pre-spin idle phase.
  await expect.poll(() => page.evaluate(() => (window as any).__engineModules.state().grid.length), { timeout: 10000 }).toBe(3);

  expect(await page.evaluate(() => (window as any).__engineModules.state().phase)).toBe('idle');
  const grid = await page.evaluate(() => (window as any).__engineModules.state().grid);
  expect(grid.length).toBe(3); // 3 reels
  expect(grid.every((reel: string[]) => reel.length === 3)).toBe(true); // 3 rows
  // Every settled cell is one of the package's declared symbols (server-authoritative).
  expect(grid.flat().every((s: string) => DEMO_SYMBOLS.includes(s))).toBe(true);
});

test('a handshake failure shows an error and no Spin button', async ({ page }) => {
  // Port 1 has nothing listening -> handshake fetch fails.
  await page.goto(`/?server=${encodeURIComponent('http://localhost:1')}`);
  await expect(page.locator('#play-error')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#spin')).toBeHidden();
});

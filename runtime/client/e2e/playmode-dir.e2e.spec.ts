// Dir-mode play: the client selects a package by id against a
// BLOOM_RUNTIME_PACKAGES server and walks the served trace (SP4).
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const SERVER = `http://localhost:${9200 + offset}`;

test('play surface loads a dir-mode package via ?package= and completes a spin', async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}&package=composed`);

  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes['main_reels:reel:2'] != null), { timeout: 15000 }).toBe(true);

  await expect(page.locator('#spin')).toBeVisible();
  await page.click('#spin');
  await expect(page.locator('#spin')).toBeEnabled({ timeout: 60000 });

  const state = await page.evaluate(() => (window as any).__engineModules.state());
  expect(state.phase).toBe('idle');
  await expect(page.locator('#play-error')).toBeHidden();
});

// runtime/client/e2e/playmode-composed.e2e.spec.ts
import { test, expect } from '@playwright/test';

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const SERVER = `http://localhost:${9100 + offset}`;
const DEMO_SYMBOLS = ['0', '1', '2', '9'];

test('composed play-mode renders reels + meter from the handshake and walks a served trace', async ({ page }) => {
  await page.goto(`/?server=${encodeURIComponent(SERVER)}`);

  // Handshake built the scene from the definition's mechanics list: reels nodes
  // keyed by the mechanic instance id, and the meter bar (target 6 -> seg 0..5).
  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes['main_reels:reel:2'] != null), { timeout: 15000 }).toBe(true);
  expect(await page.evaluate(() => (window as any).__engineModel.toDocument().nodes['bonus_meter:seg:5'] != null)).toBe(true);

  await expect(page.locator('#spin')).toBeVisible();
  await page.click('#spin');

  // The button re-enables only when the whole walk settles (multi-state traces
  // replay several reel spins back to back — allow generous time).
  await expect(page.locator('#spin')).toBeEnabled({ timeout: 60000 });

  // Reels settled to a served 3x3 grid of package symbols; no error surfaced.
  const state = await page.evaluate(() => (window as any).__engineModules.state());
  expect(state.phase).toBe('idle');
  expect(state.grid.length).toBe(3);
  expect(state.grid.every((reel: string[]) => reel.length === 3)).toBe(true);
  expect(state.grid.flat().every((s: string) => DEMO_SYMBOLS.includes(s))).toBe(true);
  await expect(page.locator('#play-error')).toBeHidden();
});

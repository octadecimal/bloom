import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Backend must be started in replay mode (`just backend-serve-replay`, i.e. PROVIDER_MODE=replay).
// Local-only; not in CI. Each test uses a UNIQUE room/game name for determinism.

async function openApp(page: Page, username: string, seedViewMode: string | null = 'large') {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  // Seed the asset-board view mode via an init script for tests that need full
  // chrome (default 'large'). Pass null to skip it — required by the persistence
  // test, since the init script otherwise re-applies on every reload and would
  // clobber a mode the app itself saved.
  if (seedViewMode) {
    await seedLocalStorage(page, 'bloom.studio.assets.prefs', JSON.stringify({ version: 1, data: { viewMode: seedViewMode } }));
  }
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}

async function createGameViaRoom(page: Page, name: string) {
  await page.getByPlaceholder(/new room/i).fill(name);
  await page.getByRole('button', { name: /create/i }).click();
  // URL changes to /room/:id and the chat-room-pane appears inside the workbench.
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

async function addAsset(page: Page) {
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page.getByTestId(/^asset-card-/)).toBeVisible();
}

async function addAssetNamed(page: Page, name: string, prompt: string) {
  await page.getByTestId('asset-name').fill(name);
  await page.getByTestId('asset-prompt').fill(prompt);
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page.getByTestId(/^asset-card-/)).toBeVisible();
}

test('author a game asset and generate it with live progress', async ({ page }) => {
  const name = `E2E Slot ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  // Board is bound to the room's game automatically — no selectGameOnBoard needed.
  await addAsset(page);

  // Discoverability: the Generate control is reachable by a human.
  const gen = page.getByTestId('asset-generate');
  await expect(gen).toBeVisible();
  await expect(gen).toBeEnabled();
  await expect(gen).toBeInViewport();

  await gen.click();
  // The progress bar is deterministic under replay (4 ticks paced at 0.05s). Under the
  // live tier real generation can finish before Playwright catches the transient bar, so
  // assert it only in replay; the real rendered image below is the cross-tier proof.
  if (process.env.BLOOM_E2E_TIER !== 'live') {
    await expect(page.getByTestId('asset-progress')).toBeVisible();
  }
  const img = page.getByTestId('asset-selected-image');
  await expect(img).toBeVisible({ timeout: 30_000 });
  // Real image, not a 1x1 fake: natural dimensions are substantial.
  await expect(async () => {
    const w = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    const h = await img.evaluate((el) => (el as HTMLImageElement).naturalHeight);
    expect(w).toBeGreaterThan(64);
    expect(h).toBeGreaterThan(64);
  }).toPass({ timeout: 30_000 });

  // Generate a second candidate and confirm the candidate strip grows to >= 2.
  await gen.click();
  await expect(async () => {
    const thumbs = await page.getByTestId('asset-candidates').locator('img').count();
    expect(thumbs).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
});

test('two clients in the same game both see a generation live', async ({ browser }) => {
  const name = `Shared Slot ${Date.now()}`;
  const a = await browser.newPage();
  const b = await browser.newPage();

  await openApp(a, 'alice');
  await createGameViaRoom(a, name);
  // Board is bound to the room's game automatically.
  await addAsset(a);

  // bob opens the picker, enters the same room by its unique name; the board binds automatically.
  await openApp(b, 'bob');
  await b.getByTestId('room-picker').getByText(name, { exact: true }).click();
  await expect(b.getByTestId('chat-room-pane')).toBeVisible();
  // asset-board visibility confirms the board DOM mounted (mount guard).
  await expect(b.getByTestId('asset-board')).toBeVisible();

  // Wait for an asset card to confirm bob's board has bound to the room's game and fetched assets (data-readiness gate).
  await expect(b.getByTestId(/^asset-card-/)).toBeVisible({ timeout: 10_000 });

  // alice generates; both boards show the produced image (proves real-time fan-out).
  await a.getByTestId('asset-generate').click();
  await expect(a.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });

  await a.close();
  await b.close();
});

test('the Generate control is visible and usable on an asset card', async ({ page }) => {
  const name = `Discover ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  // Board is bound to the room's game automatically.
  await addAsset(page);

  const gen = page.getByRole('button', { name: 'Generate' });
  await expect(gen).toBeVisible();
  await expect(gen).toBeEnabled();
  await expect(gen).toBeInViewport();
});

test('a failed generation shows a styled error and stays retryable', async ({ page }) => {
  const room = `Err ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room);
  // Board is bound to the room's game automatically.
  // The sentinel prompt makes the replay provider raise.
  await addAssetNamed(page, 'Broken', 'force error');

  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('asset-generate')).toBeEnabled(); // retryable
});

test('the Generate control stays reachable when the pane is short', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 }); // force the board to overflow its panel
  const room = `Short ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room);
  // Board is bound to the room's game automatically.
  await addAssetNamed(page, 'Wild', 'a glowing wild symbol');

  // The board must scroll the control into view rather than clip it under overflow:hidden.
  // If the pane clips with no scroll, scrollIntoViewIfNeeded cannot reveal it and this fails.
  const gen = page.getByTestId('asset-generate');
  await gen.scrollIntoViewIfNeeded();
  await expect(gen).toBeVisible();
  await expect(gen).toBeInViewport();
});

test('clicking a generated preview opens a full-size viewer', async ({ page }) => {
  const name = `Zoom ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  await addAsset(page);

  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 30_000 });

  // Open the lightbox.
  await page.getByTestId('asset-selected-image').click();
  await expect(page.getByTestId('image-lightbox-img')).toBeVisible();

  // Esc closes it.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('image-lightbox-img')).toBeHidden();

  // A candidate thumbnail still SELECTS (does not open the viewer).
  await page.getByTestId('asset-generate').click();
  await expect(async () => {
    const thumbs = await page.getByTestId('asset-candidates').locator('img').count();
    expect(thumbs).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('asset-candidates').locator('img').first().click();
  await expect(page.getByTestId('image-lightbox-img')).toBeHidden();
});

test('view-mode toggle changes density, reveals actions on hover, and persists', async ({ page }) => {
  const name = `View ${Date.now()}`;
  // No view-mode seed: start from the real default (medium) so the mode the app
  // persists below survives the reload (an init-script seed would re-apply on reload).
  await openApp(page, 'alice', null);
  await createGameViaRoom(page, name);
  await addAsset(page);

  // Switch to Medium: card width shrinks vs Large (denser).
  const card = page.getByTestId(/^asset-card-/).first();
  await page.getByTestId('view-mode-large').click();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'large');
  const largeWidth = (await card.boundingBox())!.width;
  await page.getByTestId('view-mode-medium').click();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'medium');
  const mediumWidth = (await card.boundingBox())!.width;
  expect(mediumWidth).toBeLessThan(largeWidth);

  // In Medium the Generate action is hidden until the card is hovered.
  await expect(page.getByTestId('asset-generate')).toHaveCount(0);
  await card.hover();
  await expect(page.getByTestId('asset-generate')).toBeVisible();

  // List mode lays cards out as full-width rows.
  await page.getByTestId('view-mode-list').click();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'list');

  // The chosen mode persists across a reload.
  await page.reload();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await expect(page.getByTestId('asset-grid')).toHaveAttribute('data-view-mode', 'list');
});

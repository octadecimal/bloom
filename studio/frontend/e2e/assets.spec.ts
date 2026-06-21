import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Backend must be started in replay mode (`just backend-serve-replay`, i.e. PROVIDER_MODE=replay).
// Local-only; not in CI. Each test uses a UNIQUE room/game name for determinism.

async function openApp(page: Page, username: string) {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
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

async function selectGameOnBoard(page: Page, gameName: string) {
  // The board is in the default layout (added in Task 15). The game was created
  // after the assets plugin booted, so refresh its game list first.
  await page.getByTestId('refresh-games').click();
  await expect(page.getByTestId('game-select').locator('option', { hasText: gameName })).toHaveCount(1);
  await page.getByTestId('game-select').selectOption({ label: gameName });
}

async function addAsset(page: Page) {
  await page.getByTestId('asset-name').fill('Wild');
  await page.getByTestId('asset-prompt').fill('a glowing wild symbol');
  await page.getByTestId('asset-workflow').selectOption('schnell-transparent');
  await page.getByRole('button', { name: 'Add asset' }).click();
  await expect(page.getByTestId(/^asset-card-/)).toBeVisible();
}

// Creates a game via the board's inline New Game flow and waits for it to be selected.
async function createGameOnBoard(page: Page, name: string) {
  await page.getByTestId('new-game').click();
  await page.getByTestId('new-game-name').fill(name);
  await page.getByTestId('new-game-submit').click();
  // createGame auto-selects the new game, so the select takes a non-empty value.
  await expect(page.getByTestId('game-select')).not.toHaveValue('');
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
  await selectGameOnBoard(page, name);
  await addAsset(page);

  await page.getByTestId('asset-generate').click();
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
  await page.getByTestId('asset-generate').click();
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
  await selectGameOnBoard(a, name);
  await addAsset(a);

  // bob opens the picker, enters the same room by its unique name, then uses the board.
  await openApp(b, 'bob');
  await b.getByTestId('room-picker').getByText(name, { exact: true }).click();
  await expect(b.getByTestId('chat-room-pane')).toBeVisible();
  await selectGameOnBoard(b, name);

  // bob's board fetches assets when the game is selected; wait for alice's asset to appear.
  await expect(b.getByTestId(/^asset-card-/)).toBeVisible({ timeout: 10_000 });

  // alice generates; both boards show the produced image (proves real-time fan-out).
  await a.getByTestId('asset-generate').click();
  await expect(a.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });

  await a.close();
  await b.close();
});

// RED diagnostic (added in Task 2): asserts the *human* contract — the Generate
// control must be visible, enabled, and in the viewport, not merely present in the
// DOM. Expected to FAIL against the un-redesigned card; turns green after the
// AssetCard redesign (Task 6).
test('the Generate control is visible and usable on an asset card', async ({ page }) => {
  const name = `Discover ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  await selectGameOnBoard(page, name);
  await addAsset(page);

  const gen = page.getByRole('button', { name: 'Generate' });
  await expect(gen).toBeVisible();
  await expect(gen).toBeEnabled();
  await expect(gen).toBeInViewport();
});

test('self-contained journey: create a game on the board, add an asset, generate a real image', async ({ page }) => {
  const room = `Journey ${Date.now()}`;
  const game = `Board Game ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room); // reach the workbench (board lives inside it)

  // empty/landing state on the board offers New Game; the game is created + selected inline.
  await expect(page.getByTestId('new-game')).toBeVisible();
  await createGameOnBoard(page, game);
  await addAssetNamed(page, 'Wild', 'a glowing wild symbol');

  // Discoverability: the Generate control is reachable by a human.
  const gen = page.getByTestId('asset-generate');
  await expect(gen).toBeVisible();
  await expect(gen).toBeEnabled();
  await expect(gen).toBeInViewport();

  await gen.click();
  const img = page.getByTestId('asset-selected-image');
  await expect(img).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    const w = await img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    const h = await img.evaluate((el) => (el as HTMLImageElement).naturalHeight);
    expect(w).toBeGreaterThan(64);
    expect(h).toBeGreaterThan(64);
  }).toPass({ timeout: 30_000 });
  await expect(gen).toBeEnabled(); // re-enabled after completion

  // Second candidate appears in the strip; selecting it keeps an image shown.
  await gen.click();
  await expect(async () => {
    const thumbs = await page.getByTestId('asset-candidates').locator('img').count();
    expect(thumbs).toBeGreaterThanOrEqual(2);
  }).toPass({ timeout: 15_000 });
  await page.getByTestId('asset-candidates').locator('img').first().click();
  await expect(img).toBeVisible();
});

test('a failed generation shows a styled error and stays retryable', async ({ page }) => {
  const room = `Err ${Date.now()}`;
  const game = `Err Game ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room);
  await createGameOnBoard(page, game);
  // The sentinel prompt makes the replay provider raise (Task 7).
  await addAssetNamed(page, 'Broken', 'force error');

  await page.getByTestId('asset-generate').click();
  await expect(page.getByTestId('asset-error')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('asset-generate')).toBeEnabled(); // retryable
});

test('the Generate control stays reachable when the pane is short', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 }); // force the board to overflow its panel
  const room = `Short ${Date.now()}`;
  const game = `Short Game ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, room);
  await createGameOnBoard(page, game);
  await addAssetNamed(page, 'Wild', 'a glowing wild symbol');

  // The board must scroll the control into view rather than clip it under overflow:hidden.
  // If the pane clips with no scroll, scrollIntoViewIfNeeded cannot reveal it and this fails.
  const gen = page.getByTestId('asset-generate');
  await gen.scrollIntoViewIfNeeded();
  await expect(gen).toBeVisible();
  await expect(gen).toBeInViewport();
});

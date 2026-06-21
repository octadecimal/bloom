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

test('author a game asset and generate it with live progress', async ({ page }) => {
  const name = `E2E Slot ${Date.now()}`;
  await openApp(page, 'alice');
  await createGameViaRoom(page, name);
  await selectGameOnBoard(page, name);
  await addAsset(page);

  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByTestId('asset-progress')).toBeVisible();
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
  await page.getByRole('button', { name: 'Generate' }).click();
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
  await a.getByRole('button', { name: 'Generate' }).click();
  await expect(a.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });
  await expect(b.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });

  await a.close();
  await b.close();
});

import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Backend must be started with BOTH fake providers:
//   cd studio/backend && LLM_BACKEND=fake COMFY_BACKEND=fake uv run uvicorn app.main:app --port 8000
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

  // Live progress appears, then the produced image (fake provider returns a PNG fast).
  await expect(page.getByTestId('asset-progress')).toBeVisible();
  await expect(page.getByTestId('asset-selected-image')).toBeVisible({ timeout: 15_000 });

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

  // bob opens the same game on his board.
  await openApp(b, 'bob');
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

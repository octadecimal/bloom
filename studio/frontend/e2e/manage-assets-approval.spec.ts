import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';
import { seedAsset, removeSeed } from './seed';

// Drives the real UI against a running backend (:8000, replay mode) + frontend (:4200).
// Local-only; never in CI (see AGENTS.md). Exercises the destructive delete_asset
// approval gate end-to-end.
//
// Replay cassette (studio/backend/tests/fixtures/replay/run/default.json) holds both a
// generate_asset and a delete_asset call. Because the replay model filters cassette
// tool-calls by the BOUND tools (Task 5), the `manage-assets` skill (binds list_assets +
// delete_asset) replays ONLY the delete_asset call, which targets the fixed id below.
const DOOMED_ID = 'e2e-doomed-asset';

// Create a room via the API (to learn its gameId), seed the doomed asset onto that game,
// then open the room through the picker so the app loads rooms + opens the game (which
// REST-fetches the seeded asset onto the board).
async function openSeededRoom(page: Page, request: APIRequestContext, username: string, roomName: string): Promise<{ id: string; gameId: string }> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  await seedAsset(room.gameId, DOOMED_ID, 'doomed');

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room;
}

// Serial: both cases seed the SAME fixed asset id, so they must not run concurrently.
test.describe.serial('manage-assets approval gate', () => {
  test.afterEach(async () => {
    await removeSeed(DOOMED_ID);
  });

  test('Approve removes the asset from the board', async ({ page, request }) => {
    await openSeededRoom(page, request, 'alice', `MA Approve ${Date.now()}`);

    const card = page.getByTestId(`asset-card-${DOOMED_ID}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('chat-composer').fill(`/manage-assets ${DOOMED_ID}`);
    await page.getByTestId('chat-composer').press('Enter');

    const approval = page.getByTestId('approval-card');
    await expect(approval).toBeVisible({ timeout: 15_000 });
    await expect(approval).toContainText(/can't be undone/i);

    await approval.getByRole('button', { name: /approve/i }).click();

    // The destructive delete runs, emits asset_deleted, and the board drops the card.
    await expect(card).toHaveCount(0, { timeout: 15_000 });
  });

  test('pressing Enter on the approval card approves (#72)', async ({ page, request }) => {
    await openSeededRoom(page, request, 'alice', `MA Enter ${Date.now()}`);

    const card = page.getByTestId(`asset-card-${DOOMED_ID}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('chat-composer').fill(`/manage-assets ${DOOMED_ID}`);
    await page.getByTestId('chat-composer').press('Enter');

    const approval = page.getByTestId('approval-card');
    await expect(approval).toBeVisible({ timeout: 15_000 });
    await expect(approval).toContainText(/can't be undone/i);

    // The card autofocuses while pending — Enter approves without clicking a button.
    await page.keyboard.press('Enter');

    await expect(card).toHaveCount(0, { timeout: 15_000 });
  });

  test('Deny leaves the asset on the board', async ({ page, request }) => {
    await openSeededRoom(page, request, 'alice', `MA Deny ${Date.now()}`);

    const card = page.getByTestId(`asset-card-${DOOMED_ID}`);
    await expect(card).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('chat-composer').fill(`/manage-assets ${DOOMED_ID}`);
    await page.getByTestId('chat-composer').press('Enter');

    const approval = page.getByTestId('approval-card');
    await expect(approval).toBeVisible({ timeout: 15_000 });

    await approval.getByRole('button', { name: /deny/i }).click();

    // Denied: the run concludes and the asset remains on the board.
    await expect(approval).toContainText(/denied/i, { timeout: 10_000 });
    await expect(card).toBeVisible();
  });
});

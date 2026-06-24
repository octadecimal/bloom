import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000, replay mode) + frontend (:4200).
// Local-only; never in CI (see AGENTS.md). Exercises the design-game skill end-to-end:
//   1. Invoke `/design-game …` in chat.
//   2. The 7-section GDD skeleton seeds in the viewer pane.
//   3. An ask_user_question interrupt fires → a question-card appears.
//   4. Click the first suggestion → card collapses to the answered state (shows "→").
//
// Replay cassette (studio/backend/tests/fixtures/replay/run/default.json) was extended in
// Task 8 to include the ask_user_question call bound to the design-game skill.

const BACKEND = process.env.VITE_BLOOM_BACKEND_URL ?? 'http://localhost:8000';

// Create a room via the API (to learn its gameId), then open it through the picker so the
// app routes to RoomRoute → openGameDocs(gameId), which subscribes the GDD viewer to the game.
async function openRoom(page: Page, request: APIRequestContext, username: string, roomName: string): Promise<{ id: string; gameId: string }> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };

  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room;
}

/** Open the GDD viewer pane via the View menu. */
async function openGddViewer(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-gdd/viewer')).toBeVisible();
  await page.getByTestId('view-open-gdd/viewer').click();
  // Pane may land in a non-active tab — just wait for attachment.
  await page
    .getByTestId('gdd-no-game')
    .waitFor({ state: 'attached', timeout: 5_000 })
    .catch(() => {
      // If gdd-no-game isn't there it means the pane already has a game context — that's fine too.
    });
}

test('design-game seeds the GDD skeleton and asks a question in chat', async ({ page, request }) => {
  await openRoom(page, request, 'alice', `GDD ${Date.now()}`);

  // Open the GDD viewer pane via the View menu.
  await openGddViewer(page);

  // Kick off the design-game skill.
  await page.getByTestId('chat-composer').fill('/design-game A neon cyberpunk slot with a free-spins bonus.');
  await page.getByTestId('chat-composer').press('Enter');

  // The 7-section GDD skeleton should seed into the viewer (seeding happens on run start).
  await expect(page.getByTestId('gdd-aspect-theme')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('gdd-aspect-math-model')).toBeVisible({ timeout: 15_000 });

  // A question-card interrupt should appear in the chat feed.
  const card = page.getByTestId('question-card').first();
  await expect(card).toBeVisible({ timeout: 15_000 });

  // Click the first suggestion chip.
  await card.getByRole('button').first().click();

  // Card collapses to answered state — shows the chosen value prefixed with "→".
  await expect(page.getByTestId('question-card').first()).toContainText('→', { timeout: 10_000 });
});

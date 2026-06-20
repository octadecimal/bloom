import { test, expect, type Page } from '@playwright/test';

// Requires: `just backend-serve-fake` running on :8000 (fake provider streams
// deterministic tokens) and the frontend dev server (Playwright starts it).

async function openChat(page: Page, displayName: string) {
  // Seed the display name so connect uses it deterministically.
  await page.addInitScript(
    ([k, v]) => localStorage.setItem(k, v),
    ['bloom.studio.llm-chat.prefs', JSON.stringify({ version: 1, data: { displayName, activeRoomId: null } })],
  );
  await page.goto('/');
  await expect(page.getByTestId('room-list-pane')).toBeVisible();
}

test('create a room, send a prompt, and watch the assistant stream', async ({ page }) => {
  await openChat(page, 'alice');
  await page.getByTestId('new-room-input').fill('E2E Room');
  await page.getByTestId('new-room-create').click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();

  await page.getByTestId('chat-composer').fill('Hello there');
  await page.getByTestId('chat-send').click();

  // user message appears, then the assistant message streams to non-empty content
  await expect(page.getByTestId('chat-messages')).toContainText('Hello there');
  const assistant = page.locator('[data-role="assistant"]').last();
  await expect(assistant).not.toHaveText('', { timeout: 10_000 });
  await expect(assistant).toHaveAttribute('data-status', 'complete', { timeout: 10_000 });
});

test('two clients in one room both see the stream and each other in presence', async ({ browser }) => {
  const a = await browser.newPage();
  const b = await browser.newPage();
  await openChat(a, 'alice');

  // alice creates + opens a room
  await a.getByTestId('new-room-input').fill('Shared');
  await a.getByTestId('new-room-create').click();
  await expect(a.getByTestId('chat-room-pane')).toBeVisible();

  // bob opens the same room from his Room List
  await openChat(b, 'bob');
  await b.getByTestId('room-open-' + (await firstRoomId(b))).click();
  await expect(b.getByTestId('chat-room-pane')).toBeVisible();

  // presence on alice's side eventually includes bob
  await expect(a.getByTestId('chat-presence')).toContainText('bob', { timeout: 10_000 });

  // alice sends; both see the assistant stream
  await a.getByTestId('chat-composer').fill('Ping');
  await a.getByTestId('chat-send').click();
  await expect(a.locator('[data-role="assistant"]').last()).not.toHaveText('', { timeout: 10_000 });
  await expect(b.locator('[data-role="assistant"]').last()).not.toHaveText('', { timeout: 10_000 });

  await a.close();
  await b.close();
});

// Helper: read the id of the first room from the Room List open button.
async function firstRoomId(page: Page): Promise<string> {
  const btn = page.locator('[data-testid^="room-open-"]').first();
  const testId = await btn.getAttribute('data-testid');
  return testId!.replace('room-open-', '');
}

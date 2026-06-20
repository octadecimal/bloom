import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Best run against the fake provider for speed/determinism (`just backend-serve-fake`),
// but it works against any backend. Each test uses a UNIQUE room name so it is
// deterministic regardless of rooms already present in the backend's datastore.

async function openChat(page: Page, username: string) {
  // Seed the session so the app navigates to the room-picker directly.
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}

async function createRoom(page: Page, name: string) {
  await page.getByPlaceholder(/new room/i).fill(name);
  await page.getByRole('button', { name: /create/i }).click();
  // URL changes to /room/:id and the chat-room-pane appears inside the workbench.
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

test('create a room, send a prompt, and watch the assistant stream', async ({ page }) => {
  await openChat(page, 'alice');
  await createRoom(page, `E2E ${Date.now()}`);

  await page.getByTestId('chat-composer').fill('Hello there');
  await page.getByTestId('chat-send').click();

  // user message appears, then the assistant message streams to non-empty content
  await expect(page.getByTestId('chat-messages')).toContainText('Hello there');
  const assistant = page.locator('[data-role="assistant"]').last();
  await expect(assistant).not.toHaveText('', { timeout: 15_000 });
  await expect(assistant).toHaveAttribute('data-status', 'complete', { timeout: 15_000 });
});

test('two clients in one room both see the stream and each other in presence', async ({ browser }) => {
  const room = `Shared ${Date.now()}`;
  const a = await browser.newPage();
  const b = await browser.newPage();

  // alice creates + opens the room
  await openChat(a, 'alice');
  await createRoom(a, room);

  // bob seeds session, navigates to the picker, then clicks the room by its unique name
  await seedLocalStorage(b, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'bob' } }));
  await b.goto('/');
  await expect(b.getByTestId('room-picker')).toBeVisible();
  await b.getByTestId('room-picker').getByText(room, { exact: true }).click();
  await expect(b.getByTestId('chat-room-pane')).toBeVisible();

  // presence on alice's side eventually includes bob
  await expect(a.getByTestId('chat-presence')).toContainText('bob', { timeout: 10_000 });

  // alice sends; both clients see the assistant stream
  await a.getByTestId('chat-composer').fill('Ping');
  await a.getByTestId('chat-send').click();
  await expect(a.locator('[data-role="assistant"]').last()).not.toHaveText('', {
    timeout: 15_000,
  });
  await expect(b.locator('[data-role="assistant"]').last()).not.toHaveText('', {
    timeout: 15_000,
  });

  await a.close();
  await b.close();
});

import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Best run against replay mode for speed/determinism (`just backend-serve-replay`,
// i.e. PROVIDER_MODE=replay), but it works against any backend. Each test uses a
// UNIQUE room name so it is deterministic regardless of rooms already present in the backend's datastore.

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

  await page.getByTestId('chat-composer').fill('Reply with exactly: PONG');
  await page.getByTestId('chat-send').click();

  await expect(page.getByTestId('chat-messages')).toContainText('Reply with exactly: PONG');
  // Game-room plain chat runs the design-router agent, so a chit-chat prompt streams
  // its plain-text final into an assistant run-turn block ([data-role="assistant"]).
  // Wait for the reply, then for the run to finish (AI status returns to idle).
  const assistant = page.locator('[data-role="assistant"]').last();
  await expect(assistant).toContainText('PONG', { timeout: 15_000 });
  await expect(page.getByTestId('chat-ai-status')).toHaveAttribute('data-state', 'idle', { timeout: 15_000 });
  const text = (await assistant.textContent())?.toLowerCase() ?? '';
  expect(text).not.toContain('echo:'); // would catch the degenerate fake
  expect(text).toContain('pong'); // real (or recorded-real) answer
});

test('chat pane renders the premium author-labeled feed with a styled composer', async ({ page }) => {
  await openChat(page, 'alice');
  await createRoom(page, `Premium ${Date.now()}`);

  // Composer is the shared Input primitive (token border compiled by Tailwind).
  const composer = page.getByTestId('chat-composer');
  await expect(composer).toBeVisible();
  const borderWidth = await composer.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(borderWidth).not.toBe('0px');

  // Message list is a scrollable region.
  await expect(page.getByTestId('chat-messages')).toBeVisible();
  const overflowY = await page.getByTestId('chat-messages').evaluate((el) => getComputedStyle(el).overflowY);
  expect(['auto', 'scroll']).toContain(overflowY);

  // Send a prompt; the user bubble shows the author label.
  await composer.fill('Reply with exactly: PONG');
  await page.getByTestId('chat-send').click();
  const userBubble = page.locator('[data-role="user"]').last();
  await expect(userBubble).toContainText('alice');

  // The reply renders as an assistant run-turn block (design-router plain-text final).
  // Once the run finishes, AI status is idle and no streaming step caret remains.
  const assistant = page.locator('[data-role="assistant"]').last();
  await expect(assistant).toContainText('PONG', { timeout: 15_000 });
  await expect(page.getByTestId('chat-ai-status')).toHaveAttribute('data-state', 'idle', { timeout: 15_000 });
  await expect(assistant.locator('[data-testid^="run-step-caret-"]')).toHaveCount(0);
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

test('feed sticks to the bottom while pinned, and offers jump-to-latest when scrolled up', async ({ page }) => {
  await openChat(page, 'alice');
  await createRoom(page, `Scroll ${Date.now()}`);

  const feed = page.getByTestId('chat-messages');

  // Fill the feed past one viewport so it becomes scrollable.
  for (let i = 0; i < 12; i++) {
    await page.getByTestId('chat-composer').fill(`message number ${i}`);
    await page.getByTestId('chat-send').click();
    await expect(feed).toContainText(`message number ${i}`);
  }

  // Pinned: the latest message is at/near the bottom and no jump button shows.
  await expect(page.getByTestId('chat-jump-latest')).toHaveCount(0);
  const atBottom = await feed.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
  expect(atBottom).toBe(true);

  // Scroll up → the jump button appears.
  await feed.evaluate((el) => (el.scrollTop = 0));
  await expect(page.getByTestId('chat-jump-latest')).toBeVisible();

  // Click it → feed returns to the bottom and the button hides again.
  await page.getByTestId('chat-jump-latest').click();
  await expect(page.getByTestId('chat-jump-latest')).toHaveCount(0);
  const backAtBottom = await feed.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
  expect(backAtBottom).toBe(true);
});

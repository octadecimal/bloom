import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

const ROOM = { id: 'r1', name: 'Alpha', model: 'm', gameId: null, createdAt: 't' };

async function stubRooms(page: Page, initialRooms = [ROOM]) {
  // Keep a mutable list so that after POST /rooms, subsequent GET /rooms includes the new room.
  const rooms = [...initialRooms];
  await page.route('**/rooms', async (route) => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { name?: string };
      const created = { ...ROOM, id: 'r-new', name: body.name ?? 'Beta' };
      rooms.push(created);
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(created),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(rooms),
    });
  });
  await page.route('**/rooms/*/messages', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
}

function loggedIn(page: Page, username = 'ada') {
  return seedLocalStorage(
    page,
    'bloom.studio.session',
    JSON.stringify({ version: 1, data: { username } }),
  );
}

test('unauthenticated → /login', async ({ page }) => {
  await stubRooms(page);
  await page.goto('/');
  await expect(page.getByTestId('login-screen')).toBeVisible();
});

test('login → picker → create → workbench', async ({ page }) => {
  await stubRooms(page);
  await page.goto('/login');
  await page.getByLabel(/name/i).fill('ada');
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByPlaceholder(/new room/i).fill('Beta');
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\/r-new$/);
  await expect(page.getByTestId('workbench')).toBeVisible();
});

test('deep-link before login preserves destination', async ({ page }) => {
  await stubRooms(page);
  await page.goto('/room/r1');
  await expect(page.getByTestId('login-screen')).toBeVisible();
  await page.getByLabel(/name/i).fill('ada');
  await page.getByRole('button', { name: /continue/i }).click();
  await expect(page).toHaveURL(/\/room\/r1$/);
  await expect(page.getByTestId('workbench')).toBeVisible();
});

test('shareable link opens directly when logged in', async ({ page }) => {
  await loggedIn(page);
  await stubRooms(page);
  await page.goto('/room/r1');
  await expect(page.getByTestId('workbench')).toBeVisible();
});

test('stale link → picker', async ({ page }) => {
  await loggedIn(page);
  await stubRooms(page, []);
  await page.goto('/room/r1');
  await expect(page.getByTestId('room-picker')).toBeVisible();
});

import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// Drives the Game Config editor against a running backend + frontend.
// Asserts the persisted end-state via GET (not just UI echoes) per repo testing rules.

const MODEL = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 1, role: 'wild' },
    { id: 9, role: 'scatter' },
  ],
  reels: [
    [0, 1, 9, 0, 0],
    [0, 0, 1, 9, 0],
    [9, 0, 1, 0, 0],
  ],
  rows: 3,
  paylines: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  paytable: {
    entries: [
      { symbol: 0, count: 3, payout: 5 },
      { symbol: 9, count: 3, payout: 2 },
    ],
  },
  bonuses: [
    {
      FreeSpins: {
        trigger: { symbol: 9, min_count: 3 },
        config: { spins_awarded: 5, retrigger: true, multiplier: 2, feature_reels: null },
      },
    },
  ],
};

const MODEL_B = { ...MODEL, rows: 4 };

async function getModelDoc(request: APIRequestContext, gameId: string) {
  const resp = await request.get(`${BACKEND}/games/${gameId}/slot-model`);
  expect(resp.ok()).toBeTruthy();
  return (await resp.json()) as { model: typeof MODEL; presentation?: { symbols?: Record<string, { label: string; color: string }> } };
}

async function setupGame(page: Page, request: APIRequestContext, username: string, roomName: string): Promise<string> {
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  const put = await request.put(`${BACKEND}/games/${room.gameId}/slot-model`, { data: { model: MODEL } });
  expect(put.ok()).toBeTruthy();
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openGameConfig(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game-config/editor')).toBeVisible();
  await page.getByTestId('view-open-game-config/editor').click();
  await expect(page.getByTestId('gc-tab-symbols')).toBeVisible();
}

test('header stats reflect the seeded model', async ({ page, request }) => {
  await setupGame(page, request, 'alice', `gc ${Date.now()}`);
  await openGameConfig(page);
  await expect(page.getByTestId('gc-stat-window')).toHaveText('3 × 3');
  await expect(page.getByTestId('gc-stat-symbols')).toHaveText('3');
  await expect(page.getByTestId('gc-stat-lines')).toHaveText('2');
  await expect(page.getByTestId('gc-stat-strips')).toHaveText('5, 5, 5');
});

test('symbol label edit persists presentation and pill returns to saved', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'bob', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-symbol-label-0').fill('Ace');
  await page.getByTestId('gc-symbol-label-0').blur();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  const doc = await getModelDoc(request, gameId);
  expect(doc.presentation?.symbols?.['0']?.label).toBe('Ace');
});

test('composition stepper edits the strip and persists', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'cara', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-reels').click();
  await page.getByTestId('gc-lens-composition').click();
  await page.getByTestId('gc-comp-count-0-0-inc').click();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  const doc = await getModelDoc(request, gameId);
  expect(doc.model.reels[0]).toHaveLength(6);
  expect(doc.model.reels[0].filter((s: number) => s === 0)).toHaveLength(4);
});

test('payline painter persists the repainted line', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'dan', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-paylines').click();
  await page.getByTestId('gc-pl-cell-0-1-2').click();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  const doc = await getModelDoc(request, gameId);
  expect(doc.model.paylines[0]).toEqual([0, 2, 0]);
});

test('JSON Apply replaces the model; invalid JSON persists nothing', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'eve', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-tab-json').click();
  await page.getByTestId('gc-json-textarea').fill(JSON.stringify(MODEL_B, null, 2));
  await page.getByTestId('gc-json-apply').click();
  await expect(page.getByTestId('gc-stat-window')).toHaveText('4 × 3');
  await expect(page.getByTestId('gc-sync-pill')).toContainText('saved', { timeout: 5_000 });
  let doc = await getModelDoc(request, gameId);
  expect(doc.model.rows).toBe(4);

  await page.getByTestId('gc-json-textarea').fill('not json at all');
  await page.getByTestId('gc-json-apply').click();
  await expect(page.getByTestId('gc-json-error')).toBeVisible();
  doc = await getModelDoc(request, gameId);
  expect(doc.model.rows).toBe(4); // unchanged
});

test('an external REST write re-hydrates the open pane and flashes the source', async ({ page, request }) => {
  const gameId = await setupGame(page, request, 'fay', `gc ${Date.now()}`);
  await openGameConfig(page);
  await expect(page.getByTestId('gc-stat-window')).toHaveText('3 × 3');
  const put = await request.put(`${BACKEND}/games/${gameId}/slot-model`, {
    data: { model: MODEL_B, source: 'tuner' },
  });
  expect(put.ok()).toBeTruthy();
  await expect(page.getByTestId('gc-sync-pill')).toContainText('updated externally · tuner', { timeout: 5_000 });
  await expect(page.getByTestId('gc-stat-window')).toHaveText('4 × 3'); // converged to the store
});

test('deleting a referenced symbol flags issues on the referencing tabs', async ({ page, request }) => {
  await setupGame(page, request, 'gil', `gc ${Date.now()}`);
  await openGameConfig(page);
  await page.getByTestId('gc-symbol-delete-9').click(); // scatter still used by reels/paytable/trigger
  await expect(page.getByTestId('gc-issues-pill')).toBeVisible();
  await expect(page.getByTestId('gc-tab-dot-paytable')).toBeVisible();
  await expect(page.getByTestId('gc-tab-dot-reels')).toBeVisible();
  await expect(page.getByTestId('gc-tab-dot-bonus')).toBeVisible();
  await page.getByTestId('gc-tab-paytable').click();
  await expect(page.getByTestId('gc-pt-issue-1')).toContainText('unknown symbol');
});

test('simulator pane has no textarea and links to Game Config', async ({ page, request }) => {
  await setupGame(page, request, 'hal', `gc ${Date.now()}`);
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-simulator/viewer').click();
  await expect(page.getByTestId('curate-button')).toBeVisible();
  await expect(page.getByTestId('simulator-model-json')).toHaveCount(0);
  await page.getByTestId('open-game-config-hint').click();
  await expect(page.getByTestId('gc-tab-symbols')).toBeVisible();
});

test('a fresh game is born with the default template (never empty)', async ({ page, request }) => {
  // No slot-model PUT: the doc must self-seed with video-5x3 on first read.
  const roomName = `gc-seeded ${Date.now()}`;
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'eve' } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  await openGameConfig(page);

  // video-5x3: 5 reels x 3 rows, 7 symbols (6 normals + scatter).
  // Window stat renders `rows × reelCount` (see GameConfigPane), so 3 rows × 5 reels → '3 × 5'.
  await expect(page.getByTestId('gc-stat-window')).toHaveText('3 × 5');
  await expect(page.getByTestId('gc-stat-symbols')).toHaveText('7');

  // Persisted end-state, not just the UI echo (repo testing rule).
  const doc = await getModelDoc(request, room.gameId);
  expect(doc.model.reels).toHaveLength(5);
  expect(doc.model.paytable.entries.length).toBeGreaterThan(0);
});

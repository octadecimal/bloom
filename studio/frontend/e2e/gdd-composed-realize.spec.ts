import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage, BACKEND_URL as BACKEND } from './helpers';

// SP-D: a GDD that declares game_family composed@1 + structured feature rows
// realizes into a seeded GameDefinition (states/transitions/mechanics + the
// model_id join-key write-back), visible in game-structure, with the composed
// pay constraint compiled into the math pane's target chips.

async function enterRoom(page: Page, username: string, roomName: string): Promise<void> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

test('GDD-declared composed game realizes: states in game-structure, constraint chips in math', async ({ page, request }) => {
  const roomName = `sp-d realize ${Date.now()}`;
  const resp = await request.post(`${BACKEND}/rooms`, { data: { name: roomName } });
  expect(resp.ok()).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  const g = room.gameId;

  // GDD intent: composed family + one free-spins + one meter feature.
  const mm = await request.put(`${BACKEND}/games/${g}/gdd/math-model`, {
    data: { fields: { game_family: 'composed@1', rtp: '96%', volatility: 'low', reels: 3, rows: 3, payline_count: 3 } },
  });
  expect(mm.ok()).toBeTruthy();
  const sr = await request.put(`${BACKEND}/games/${g}/gdd/symbols-reels`, {
    data: {
      fields: {
        symbols: [
          { slot: 'high1', name: 'Dragon', kind: 'high' },
          { slot: 'low1', name: 'Ten', kind: 'low' },
          { slot: 'scat', name: 'Coin', kind: 'scatter' },
        ],
      },
    },
  });
  expect(sr.ok()).toBeTruthy();
  const bf = await request.put(`${BACKEND}/games/${g}/gdd/bonus-features`, {
    data: {
      fields: {
        features: [
          { name: 'Free Spins', trigger: '3 scatters', description: '', kind: 'free-spins', retrigger: 'yes', budget: 8 },
          { name: 'Coin Meter', trigger: 'meter fills', description: '', kind: 'meter', budget: 6 },
        ],
      },
    },
  });
  expect(bf.ok()).toBeTruthy();

  // Realize: seeds the definition + writes the model_id join keys back.
  const realize = await request.post(`${BACKEND}/games/${g}/slot-model/realize`);
  expect(realize.ok()).toBeTruthy();
  expect(((await realize.json()) as { realized: boolean }).realized).toBe(true);

  const defWire = (await (await request.get(`${BACKEND}/games/${g}/game-definition`)).json()) as {
    definition: { family: string; states: { id: string }[] };
  };
  expect(defWire.definition.family).toBe('composed@1');
  expect(defWire.definition.states.map((s) => s.id)).toEqual(['base', 'fs_1', 'meter_2_bonus']);

  // Pay constraint AFTER realize (it resolves via the just-written join keys).
  const pc = await request.put(`${BACKEND}/games/${g}/gdd/paytable`, {
    data: { fields: { pay_constraints: [{ symbol: 'high1', relation: 'top-paying', count: '', value: '' }] } },
  });
  expect(pc.ok()).toBeTruthy();

  await enterRoom(page, 'sp-d-user', roomName);

  // game-structure renders the realized states.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-game-structure/editor').click();
  await page.getByTestId('gs-tab-states').click(); // pane defaults to the Mechanics tab
  await expect(page.getByTestId('gs-state-card-fs_1')).toBeVisible();
  await expect(page.getByTestId('gs-state-card-meter_2_bonus')).toBeVisible();

  // math pane compiles the composed pay constraint into the target chips.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-math/viewer').click();
  await expect(page.getByTestId('target-chip-pay-0')).toBeVisible();
  await expect(page.getByTestId('target-chip-pay-0')).toContainText('top-paying');
});

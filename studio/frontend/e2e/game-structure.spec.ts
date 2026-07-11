import { expect, test, type Page } from '@playwright/test';
import { BACKEND_URL, seedLocalStorage } from './helpers';

// Drives the Game Structure editor (composed@1 authoring) against a running
// backend + frontend + dir-mode runtime server. Asserts persisted end-state
// via REST (not just UI echoes) per repo testing rules.

const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
const RUNTIME = `http://localhost:${9300 + offset}`;

async function setupGame(page: Page): Promise<string> {
  const roomName = `gs ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const resp = await fetch(`${BACKEND_URL}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: roomName }),
  });
  expect(resp.ok).toBeTruthy();
  const room = (await resp.json()) as { id: string; gameId: string };
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: `gs-${Date.now()}` } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
  await page.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
  return room.gameId;
}

async function openGameStructure(page: Page) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId('view-open-game-structure/editor')).toBeVisible();
  await page.getByTestId('view-open-game-structure/editor').click();
  await expect(page.getByTestId('gs-tab-mechanics')).toBeVisible();
}

test('edit meter target -> saved -> persisted in the game-definition doc', async ({ page }) => {
  const gameId = await setupGame(page);
  await openGameStructure(page);
  await page.getByTestId('gs-meter-target-bonus_meter-inc').click(); // 6 -> 7
  await expect(page.getByTestId('gs-sync-pill')).toContainText('saved');
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`);
  const doc = (await res.json()) as { definition: { mechanics: Array<{ id: string; config: { target?: number } }> } };
  expect(doc.definition.mechanics.find((m) => m.id === 'bonus_meter')?.config.target).toBe(7);
});

test('kernel validation surfaces inline and clears on fix', async ({ page }) => {
  await setupGame(page);
  await openGameStructure(page);
  // Break it: retarget a transition at a nonexistent state via the JSON tab.
  await page.getByTestId('gs-tab-json').click();
  const draft = await page.getByTestId('gs-json-textarea').inputValue();
  const doc = JSON.parse(draft);
  doc.definition.start = 'no-such-state';
  await page.getByTestId('gs-json-textarea').fill(JSON.stringify(doc));
  await page.getByTestId('gs-json-apply').click();
  await expect(page.getByTestId('gs-validation-pill')).toContainText('issue', { timeout: 120_000 }); // first cargo run may compile
  await expect(page.getByTestId('gs-validation-errors')).toContainText('UnknownState');
  // Fix it back.
  doc.definition.start = 'base';
  await page.getByTestId('gs-json-textarea').fill(JSON.stringify(doc));
  await page.getByTestId('gs-json-apply').click();
  await expect(page.getByTestId('gs-validation-pill')).toContainText('valid', { timeout: 120_000 });
});

test('build produces metrics and a package the runtime server plays', async ({ page }) => {
  const gameId = await setupGame(page);
  await openGameStructure(page);
  await page.getByTestId('gs-build').click();
  await expect(page.getByTestId('gs-metrics')).toBeVisible({ timeout: 300_000 }); // 10k-seed build + possible compile
  await expect(page.getByTestId('gs-metric-rtp')).toContainText('rtp');
  // Play link points at the play surface with the package id.
  const href = await page.getByTestId('gs-play').getAttribute('href');
  expect(href).toContain(`?package=${gameId}`);
  // Authoritative round-trip: the dir-mode server serves the authored package.
  const hs = await fetch(`${RUNTIME}/handshake?package=${gameId}`);
  expect(hs.status).toBe(200);
  const handshake = (await hs.json()) as { package_id: string; mechanic: string };
  expect(handshake.package_id).toBe(gameId);
  expect(handshake.mechanic).toBe('composed@1');
  const spin = await fetch(`${RUNTIME}/spin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bet: 1, package: gameId }),
  });
  expect(spin.status).toBe(200);
  const round = (await spin.json()) as { trace: Array<{ t: string }> };
  expect(round.trace.at(-1)?.t).toBe('round_end');
});

test('external write flags the pane and rehydrates', async ({ page }) => {
  const gameId = await setupGame(page);
  await openGameStructure(page);
  const res = await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`);
  const doc = (await res.json()) as { definition: Record<string, unknown> };
  await fetch(`${BACKEND_URL}/games/${gameId}/game-definition`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ definition: { ...doc.definition, start: 'fs1' }, source: 'api' }),
  });
  await expect(page.getByTestId('gs-sync-pill')).toContainText('updated externally · api');
  await page.getByTestId('gs-tab-transitions').click();
  await expect(page.getByTestId('gs-start-select')).toHaveValue('fs1');
});

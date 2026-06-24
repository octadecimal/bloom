import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Local-only (browser e2e is never in CI). Requires the full stack:
//   engine :4300 (nx serve client), backend :8000 (replay), studio :4200.
// Drives ops through the real socket-dispatch path (window.__gameApplyInbound)
// so the reducer + ProtocolBridge + engine-iframe render run without an LLM.

async function openAppAtRoom(page: Page, username: string): Promise<string> {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await page.getByPlaceholder(/new room/i).fill(`Scene E2E ${Date.now()}`);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('workbench')).toBeVisible();
  return page.url();
}

test('ops mutate the engine iframe scene live and keep hookstate in sync', async ({ page }) => {
  await openAppAtRoom(page, 'ada');

  // Open the Game Scene pane via the host openPane helper exposed in dev.
  await page.evaluate(() => (window as any).__host?.openPane?.('game/preview'));
  const frame = page.getByTestId('game-engine-frame');
  await expect(frame).toBeVisible();

  // Wait for the engine iframe to boot and the bridge to be ready.
  await expect
    .poll(async () => page.evaluate(() => !!(document.querySelector('[data-testid=game-engine-frame]') as HTMLIFrameElement)?.contentWindow))
    .toBe(true);

  const gameId = await page.evaluate(() => (window as any).__gameActiveId ?? null);

  // Drive ops through the real socket-dispatch path.
  await page.evaluate((gid) => {
    const apply = (window as any).__gameApplyInbound as (e: string, p: unknown) => void;
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    apply('scene_op', { gameId: gid, op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    apply('scene_op', {
      gameId: gid,
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  }, gameId);

  // The engine iframe's model reflects the ops (proves cross-frame render, no reload).
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const f = document.querySelector('[data-testid=game-engine-frame]') as HTMLIFrameElement;
        const model = (f.contentWindow as any)?.__engineModel;
        return model ? Object.keys(model.toDocument().nodes).length : 0;
      }),
    )
    .toBeGreaterThanOrEqual(2);
});

import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('a plugin whose init throws is skipped; the workbench still boots (row 11)', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __injectPlugins?: unknown[] }).__injectPlugins = [
      {
        id: 'bad',
        title: 'Bad',
        panes: [],
        init: () => {
          throw new Error('boom');
        },
      },
    ];
  });
  // The session + route stubs are set by gotoWorkbench, which also waits for the workbench.
  // Visibility of the workbench proves the bad plugin was skipped and good ones loaded.
  await gotoWorkbench(page);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible(); // good plugins (llm-chat) still loaded
});

test('a corrupt persisted plugin slice falls back to initialState (row 12)', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bloom.studio.demo-counter', '{bad json'));
  await gotoWorkbench(page);
  // Open the counter pane via the View menu to observe the initialState value.
  await page.getByTestId('menu-view').click();
  await page.getByTestId('view-open-demo-counter/editor').click();
  await expect(page.getByTestId('counter-value')).toHaveText('0'); // initialState, no crash
});

test('an unknown command id is a no-op, no crash (row 13)', async ({ page }) => {
  await gotoWorkbench(page);
  const result = await page.evaluate(() => {
    const host = (window as unknown as { __host?: { runCommand(id: string): void } }).__host;
    if (!host) return 'no-host';
    try {
      host.runCommand('does/not-exist');
      return 'ok';
    } catch {
      return 'threw';
    }
  });
  expect(result).toBe('ok');
  await expect(page.getByTestId('chat-room-pane')).toBeVisible(); // app still alive after no-op
});

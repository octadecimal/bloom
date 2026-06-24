import { test, expect, type Page } from '@playwright/test';
import { gotoWorkbench } from './helpers';

/** Open a pane via the View menu and wait for it to be attached in the DOM. */
async function openPane(page: Page, itemTestId: string, paneTestId: string) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId(itemTestId)).toBeVisible();
  await page.getByTestId(itemTestId).click();
  await page.getByTestId(paneTestId).waitFor({ state: 'attached' });
}

/** Activate a dockview tab by its visible text label. */
async function activateTab(page: Page, tabText: string) {
  await page.locator('.dv-tab', { hasText: tabText }).first().click();
}

test('shadcn Button renders with Tailwind utility classes applied', async ({ page }) => {
  await gotoWorkbench(page);
  // The chat composer's Send button is a primary Button; its compiled utilities
  // (bg-primary fill + the compact h-7 height) prove Tailwind built the Button variants.
  const send = page.getByTestId('chat-send');
  await expect(send).toBeVisible();
  const { bg, height } = await send.evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, height: s.height };
  });
  // bg-primary compiled to a real, non-transparent fill.
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  expect(bg).not.toBe('transparent');
  // h-7 compiled to the compact 28px height.
  expect(height).toBe('28px');
});

test('drag-and-drop preview overlay resolves to the on-palette selection wash', async ({ page }) => {
  await gotoWorkbench(page);
  // Dockview paints the drop preview (.dv-drop-target-anchor) with
  // var(--dv-drag-over-background-color). That overlay element only exists mid-drag,
  // and dockview's native HTML5 DnD is unreliable to simulate — so probe the cascade
  // directly: a throwaway element inside the bloom-themed root consuming that variable
  // must resolve to a real color, not transparent. This is the exact regression: when
  // the variable is orphaned the overlay paints rgba(0, 0, 0, 0) (invisible).
  const themeRoot = page.locator('.dockview-theme-bloom').first();
  await expect(themeRoot).toBeVisible();
  const bg = await themeRoot.evaluate((root) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = 'var(--dv-drag-over-background-color)';
    root.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
  // The design language's --selection token: rgba(240, 100, 30, 0.14), the rationed
  // orange "targeted region" wash. Non-transparent proves the overlay is visible again.
  expect(bg).toBe('rgba(240, 100, 30, 0.14)');
});

test('drop-preview animation speed is halved from dockview defaults (150ms / 35ms)', async ({ page }) => {
  await gotoWorkbench(page);
  // The drop-preview slide timing is dockview's --dv-transition-duration, declared by the
  // library directly on .dv-drop-target-container (300ms, the cross-group anchor move — the
  // dominant, most visible duration) and .dv-drop-target (70ms, the in-target quadrant slide).
  // Those elements only exist mid-drag and native DnD is unreliable to simulate, so probe the
  // cascade directly — same technique as the overlay-color test above — with a throwaway element
  // carrying each class so it resolves the value our theme override sets.
  const themeRoot = page.locator('.dockview-theme-bloom').first();
  await expect(themeRoot).toBeVisible();
  const durations = await themeRoot.evaluate((root) => {
    const read = (className: string) => {
      const probe = document.createElement('div');
      probe.className = className;
      root.appendChild(probe);
      const value = getComputedStyle(probe).getPropertyValue('--dv-transition-duration').trim();
      probe.remove();
      return value;
    };
    return { container: read('dv-drop-target-container'), target: read('dv-drop-target') };
  });
  // Halved from dockview's 300ms / 70ms defaults via the bloom theme override.
  expect(durations.container).toBe('150ms');
  expect(durations.target).toBe('35ms');
});

test('settings pane select renders inside card chrome with token borders', async ({ page }) => {
  // Stub the models endpoint so this test is hermetic.
  await page.route('**/models', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'gpt-4o', label: 'GPT-4o', free: false }]) }),
  );
  await gotoWorkbench(page);
  // Open the settings pane via the View menu — proven pattern from panes.spec.ts.
  await openPane(page, 'view-open-llm-chat/settings', 'chat-settings-pane');
  // Activate the "Chat Settings" tab in case it shares a tab group.
  await activateTab(page, 'Chat Settings');
  const select = page.getByTestId('settings-model');
  await expect(select).toBeVisible();
  // The Select primitive applies `border border-input`; a non-zero borderTopWidth
  // confirms the Tailwind token border compiled correctly.
  const borderWidth = await select.evaluate((el) => getComputedStyle(el).borderTopWidth);
  expect(borderWidth).not.toBe('0px');
});

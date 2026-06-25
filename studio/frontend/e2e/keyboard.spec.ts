import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage, gotoWorkbench } from './helpers';

// Keyboard affordances for the chat surface:
//   #71 — Ctrl/Cmd+L focuses the chat composer regardless of current focus.
//   #72 — pressing Enter in a tool prompt (SkillForm field) submits it.
//
// The Ctrl+L case is hermetic (gotoWorkbench stubs rooms/messages). The SkillForm
// case drives the real UI against a running replay backend (:8000+offset) + frontend,
// reusing the generate-background cassette (see skill-editor.spec.ts).

async function openApp(page: Page, username: string) {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}

async function createRoom(page: Page, name: string) {
  await page.getByPlaceholder(/new room/i).fill(name);
  await page.getByRole('button', { name: /create/i }).click();
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

test.describe('Ctrl+L focuses the chat composer (#71)', () => {
  test('focuses the composer even when focus is on another control', async ({ page }) => {
    await gotoWorkbench(page);
    await expect(page.getByTestId('chat-room-pane')).toBeVisible();

    // Move focus off the composer onto the Send button.
    await page.getByTestId('chat-send').focus();
    await expect(page.getByTestId('chat-composer')).not.toBeFocused();

    await page.keyboard.press('Control+l');
    await expect(page.getByTestId('chat-composer')).toBeFocused();
  });

  test('focuses the composer when focus sits in an unrelated pane', async ({ page }) => {
    await gotoWorkbench(page);
    await expect(page.getByTestId('chat-room-pane')).toBeVisible();

    // Open a demo pane via the View menu and put focus inside it.
    await page.getByTestId('menu-view').click();
    await page.getByTestId('view-open-demo-scratch/main').click();
    const scratch = page.getByTestId('scratch-input');
    await scratch.waitFor({ state: 'attached' });
    await scratch.click();
    await expect(page.getByTestId('chat-composer')).not.toBeFocused();

    await page.keyboard.press('Control+l');
    await expect(page.getByTestId('chat-composer')).toBeFocused();
  });
});

test.describe('SkillForm submits on Enter (#72)', () => {
  test('pressing Enter in a form field starts the run (no button click)', async ({ page }) => {
    const roomName = `Form Enter ${Date.now()}`;
    await openApp(page, 'alice');
    await createRoom(page, roomName);

    await expect(page.getByTestId('asset-board')).toBeVisible({ timeout: 10_000 });

    // Open the typed SkillForm: type the slash prefix, Tab to complete the name,
    // bare Enter (no prose) opens the form.
    await page.getByTestId('chat-composer').fill('/generate-background');
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('chat-composer').press('Tab');
    await page.getByTestId('chat-composer').press('Enter');

    await expect(page.getByTestId('skill-form')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('skill-form-field-description').fill('a misty forest at dawn');

    // Submit via Enter in the field — the run must start without touching the button.
    await page.getByTestId('skill-form-field-description').press('Enter');

    const timeline = page.getByTestId('chat-messages');
    await expect(timeline).toBeVisible({ timeout: 10_000 });
    await expect(timeline).toContainText('generate_asset', { timeout: 15_000 });
  });
});

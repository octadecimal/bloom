import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

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

test.describe('skill autocomplete keyboard navigation', () => {
  test('arrow keys move the active option', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/gen');
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible();
    // Matches are backend-ordered (sorted *.md glob): generate-background sorts before
    // generate-sprite, so the first (index 0) is active by default.
    await expect(page.getByTestId('skill-option-generate-background')).toHaveAttribute('data-active', 'true');
    await composer.press('ArrowDown');
    await expect(page.getByTestId('skill-option-generate-sprite')).toHaveAttribute('data-active', 'true');
  });

  test('Tab completes the highlighted name and hides the popup', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/generate-sprite');
    await composer.press('Tab');
    await expect(composer).toHaveValue('/generate-sprite ');
    await expect(page.getByTestId('skill-autocomplete')).toBeHidden();
  });

  test('Tab-complete then prose then Enter runs the skill', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/generate-sprite');
    await composer.press('Tab');
    await composer.type('a knight');
    await composer.press('Enter');
    await expect(page.getByTestId('run-timeline')).toContainText('generate_asset', { timeout: 20_000 });
  });

  test('Tab-complete then bare Enter opens the form', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/generate-sprite');
    await composer.press('Tab');
    await composer.press('Enter');
    await expect(page.getByTestId('skill-form')).toBeVisible();
  });

  test('Escape dismisses the popup', async ({ page }) => {
    await openApp(page, 'alice');
    await createRoom(page, `AC ${Date.now()}`);
    const composer = page.getByTestId('chat-composer');
    await composer.fill('/gen');
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible();
    await composer.press('Escape');
    await expect(page.getByTestId('skill-autocomplete')).toBeHidden();
  });
});

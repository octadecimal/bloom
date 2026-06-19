import type { Page } from '@playwright/test';

export async function seedLocalStorage(page: Page, key: string, value: string) {
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [key, value]);
}

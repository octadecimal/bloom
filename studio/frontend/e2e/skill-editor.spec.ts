import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Backend must be in replay mode (`just backend-serve-replay`, PROVIDER_MODE=replay).
// Local-only; not in CI.
//
// Flow 1: invoke the shipped `generate-background` skill via the autocomplete form.
// Flow 2: author a throwaway skill via the Skill Editor pane, then confirm it
//         becomes invocable via autocomplete. The skill file is deleted in afterAll.

// ---------------------------------------------------------------------------
// Helpers (mirrors skill-run.spec.ts patterns)
// ---------------------------------------------------------------------------

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

/** Open a pane via the View menu. Mirrors panes.spec.ts's openDemoPane pattern. */
async function openPane(page: Page, paneId: string, paneTestId: string) {
  await page.getByTestId('menu-view').click();
  await expect(page.getByTestId(`view-open-${paneId}`)).toBeVisible();
  await page.getByTestId(`view-open-${paneId}`).click();
  await page.getByTestId(paneTestId).waitFor({ state: 'attached' });
}

// ---------------------------------------------------------------------------
// Teardown state for Flow 2
// ---------------------------------------------------------------------------

// skills/ is at the repo root: studio/frontend/e2e/ → ../../../skills/
const SKILLS_DIR = path.resolve(__dirname, '../../../skills');
const TEMP_SKILL_FILE = path.join(SKILLS_DIR, 'e2e-temp-skill.md');

// ---------------------------------------------------------------------------
// Flow 1 — invoke generate-background via the autocomplete FORM
// ---------------------------------------------------------------------------

test.describe('generate-background via form', () => {
  test('fills the skill form and sees a run timeline + asset on the Asset Board', async ({ page }) => {
    const roomName = `BG Form ${Date.now()}`;
    await openApp(page, 'alice');
    await createRoom(page, roomName);

    // Confirm the Asset Board is present before triggering the run.
    await expect(page.getByTestId('asset-board')).toBeVisible({ timeout: 10_000 });

    // Type the slash prefix into the composer to trigger autocomplete.
    await page.getByTestId('chat-composer').fill('/generate-background');

    // The autocomplete dropdown must appear and contain the generate-background option.
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('skill-option-generate-background').click();

    // The SkillForm replaces autocomplete — fill the required `description` field.
    await expect(page.getByTestId('skill-form')).toBeVisible({ timeout: 5_000 });
    await page.getByTestId('skill-form-field-description').fill('a misty forest at dawn');

    // Leave mood and aspect at their defaults (neutral, wide).
    // Submit the form.
    await page.getByTestId('skill-form-submit').click();

    // --- Run timeline must appear and contain the tool call ---
    const timeline = page.getByTestId('run-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });
    await expect(timeline).toContainText('generate_asset', { timeout: 15_000 });

    // --- Final confirming text from the cassette ---
    await expect(timeline).toContainText('Asset Board', { timeout: 20_000 });

    // --- An asset card should appear on the Asset Board ---
    await expect(page.getByTestId(/^asset-card-/)).toBeVisible({ timeout: 10_000 });
  });
});

// ---------------------------------------------------------------------------
// Flow 2 — author a throwaway skill via the Skill Editor, confirm invocability
// ---------------------------------------------------------------------------

test.describe('skill-editor pane — author and invoke a custom skill', () => {
  test.afterAll(() => {
    // Clean up the file written to skills/ by the Save action.
    // The spec must leave the repo clean.
    try {
      if (fs.existsSync(TEMP_SKILL_FILE)) {
        fs.unlinkSync(TEMP_SKILL_FILE);
      }
    } catch {
      // Best-effort; don't mask test failures.
    }
  });

  test('author e2e-temp-skill via the editor and see it appear in autocomplete', async ({ page }) => {
    const roomName = `Skill Editor ${Date.now()}`;
    await openApp(page, 'alice');
    await createRoom(page, roomName);

    // Open the Skill Editor pane via the View menu (same pattern as panes.spec.ts).
    await openPane(page, 'llm-chat/skill-editor', 'skill-editor-pane');

    // Activate the tab if the pane landed behind another tab.
    const editorTab = page.locator('.dv-tab', { hasText: 'Skill Editor' }).first();
    if (await editorTab.isVisible()) {
      await editorTab.click();
    }
    await expect(page.getByTestId('skill-editor-pane')).toBeVisible({ timeout: 5_000 });

    // Fill in the skill metadata.
    await page.getByTestId('skill-editor-name').fill('e2e-temp-skill');
    await page.getByTestId('skill-editor-description').fill('E2E throwaway skill for testing the editor');
    await page.getByTestId('skill-editor-body').fill('Call generate_asset with the provided description and return the result.');

    // Check the generate_asset tool.
    // The checkbox is rendered once the backend /tools list loads; wait for it.
    await expect(page.getByTestId('skill-editor-tool-generate_asset')).toBeVisible({ timeout: 10_000 });
    const toolCheckbox = page.getByTestId('skill-editor-tool-generate_asset');
    if (!(await toolCheckbox.isChecked())) {
      await toolCheckbox.click();
    }

    // Save — this POSTs to the backend which writes skills/e2e-temp-skill.md.
    await page.getByTestId('skill-editor-save').click();

    // Assert the success status message contains the skill name.
    const status = page.getByTestId('skill-editor-status');
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status).toContainText('e2e-temp-skill');

    // Back in the composer: type the slash prefix and confirm the new skill is listed.
    await page.getByTestId('chat-composer').fill('/e2e-temp-skill');
    await expect(page.getByTestId('skill-autocomplete')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('skill-option-e2e-temp-skill')).toBeVisible({ timeout: 5_000 });
  });
});

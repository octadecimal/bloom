import { test, expect, type Page } from '@playwright/test';
import { seedLocalStorage } from './helpers';

// Drives the real UI against a running backend (:8000) + frontend (:4200).
// Backend must be in replay mode (`just backend-serve-replay`, PROVIDER_MODE=replay).
// Local-only; not in CI. Each test uses a UNIQUE room name for determinism.
//
// Replay cassette (studio/backend/tests/fixtures/replay/run/default.json):
//   tool_calls: [{ name: "generate_asset", args: { description: "a knight", style: "pixel" } }]
//   final: ["All set — ", "I generated a knight sprite and added it to the Asset Board."]
//
// Resulting run steps:
//   step 0 — type: tool_call,   toolName: generate_asset
//   step 1 — type: tool_result, toolName: generate_asset
//   step 2 — type: final,       content: "All set — I generated a knight sprite and added it to the Asset Board."

async function openApp(page: Page, username: string) {
  await seedLocalStorage(page, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username } }));
  await page.goto('/');
  await expect(page.getByTestId('room-picker')).toBeVisible();
}

async function createRoom(page: Page, name: string) {
  await page.getByPlaceholder(/new room/i).fill(name);
  await page.getByRole('button', { name: /create/i }).click();
  // URL changes to /room/:id and the chat-room-pane appears inside the workbench.
  await expect(page).toHaveURL(/\/room\//);
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
}

test.describe('generate-sprite skill run', () => {
  test('sends /generate-sprite and the run timeline shows the tool call and final text', async ({ page }) => {
    const roomName = `Skill ${Date.now()}`;
    await openApp(page, 'alice');
    await createRoom(page, roomName);

    // Send the slash command by typing + clicking send (NOT autocomplete).
    await page.getByTestId('chat-composer').fill('/generate-sprite description="a knight"');
    await page.getByTestId('chat-send').click();

    // --- Must-pass: run timeline becomes visible ---
    const timeline = page.getByTestId('run-timeline');
    await expect(timeline).toBeVisible({ timeout: 10_000 });

    // --- Must-pass: the tool call step shows the tool name "generate_asset" ---
    // RunTimeline renders step cards; tool_call/tool_result cards display step.toolName as text.
    await expect(timeline).toContainText('generate_asset', { timeout: 15_000 });

    // --- Must-pass: the final step contains the cassette's confirming text ---
    // Cassette final: "All set — I generated a knight sprite and added it to the Asset Board."
    // Assert a stable substring that is present in the replay fixture.
    await expect(timeline).toContainText('Asset Board', { timeout: 20_000 });

    // --- Best-effort: the final step caret disappears once the run completes ---
    // (no run-step-caret-N will be present after completion; this is an optional signal check)
    await expect(page.locator('[data-testid^="run-step-caret-"]')).toHaveCount(0, { timeout: 5_000 });
  });

  test('asset card appears on the Asset Board after the skill run completes', async ({ page }) => {
    // Asset Board binding investigation:
    //   - RoomRoute calls openGame(room.gameId) when the room loads (RoomRoute.tsx:29).
    //   - store.create_room always creates+links a game (store.py:66-68); list_rooms also
    //     guarantees game_id via _with_game (store.py:85). So every room the picker creates
    //     has a gameId and openGame IS called.
    //   - The skill's ToolContext uses room.game_id (room_hub.py:183) — the same game.
    //   - generate_and_wait → _run → emits asset_completed to the game's socket room (hub.py:91).
    //   - The assets socket client handles asset_completed by upserting into state (socketClient.ts:40-45).
    //   - The frontend joins the game room via join_game on connect (socketClient.ts:59).
    //   CONCLUSION: bindings align — the generated asset WILL appear on the Asset Board.

    const roomName = `Skill Board ${Date.now()}`;
    await openApp(page, 'alice');
    await createRoom(page, roomName);

    // Confirm the Asset Board is mounted (it renders automatically in the workbench layout).
    await expect(page.getByTestId('asset-board')).toBeVisible({ timeout: 10_000 });

    await page.getByTestId('chat-composer').fill('/generate-sprite description="a knight"');
    await page.getByTestId('chat-send').click();

    // Wait for the run to complete (final confirming text in the timeline).
    await expect(page.getByTestId('run-timeline')).toContainText('Asset Board', { timeout: 30_000 });

    // An asset card should appear on the board — the skill called asset_store.create_asset
    // and asset_hub.generate_and_wait which emits asset_completed, causing the frontend
    // to upsert the asset into state and render an AssetCard.
    await expect(page.getByTestId(/^asset-card-/)).toBeVisible({ timeout: 10_000 });
  });

  test('two clients in one room both see the run timeline', async ({ browser }) => {
    const roomName = `Shared Skill ${Date.now()}`;
    const a = await browser.newPage();
    const b = await browser.newPage();

    // alice creates the room
    await openApp(a, 'alice');
    await createRoom(a, roomName);

    // bob joins by clicking the room name in the picker
    await seedLocalStorage(b, 'bloom.studio.session', JSON.stringify({ version: 1, data: { username: 'bob' } }));
    await b.goto('/');
    await expect(b.getByTestId('room-picker')).toBeVisible();
    await b.getByTestId('room-picker').getByText(roomName, { exact: true }).click();
    await expect(b.getByTestId('chat-room-pane')).toBeVisible();

    // alice triggers the skill run
    await a.getByTestId('chat-composer').fill('/generate-sprite description="a knight"');
    await a.getByTestId('chat-send').click();

    // both clients see the run timeline with the tool name
    const timelineA = a.getByTestId('run-timeline');
    const timelineB = b.getByTestId('run-timeline');
    await expect(timelineA).toContainText('generate_asset', { timeout: 20_000 });
    await expect(timelineB).toContainText('generate_asset', { timeout: 20_000 });

    await a.close();
    await b.close();
  });
});

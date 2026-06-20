import { test, expect } from '@playwright/test';
import { gotoWorkbench } from './helpers';

test('the docking surface mounts and shows the default pane', async ({ page }) => {
  await gotoWorkbench(page);
  // The new default layout contains the chat room pane (llm-chat/room).
  await expect(page.getByTestId('chat-room-pane')).toBeVisible();
});

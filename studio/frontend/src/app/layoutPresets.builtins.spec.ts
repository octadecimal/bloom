import { describe, it, expect, vi } from 'vitest';
import { LAYOUT_BUILTINS } from './layoutPresets.builtins';

function fakeApi() {
  return {
    getPanel: vi.fn(() => undefined),
    addPanel: vi.fn(),
  };
}
const reg = { get: (id: string) => ({ title: id }) };

describe('LAYOUT_BUILTINS', () => {
  it('Chat adds Chat Room then Chat Settings to its right', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Chat(api as never, reg);
    const ids = api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(['llm-chat/room', 'llm-chat/settings']);
    const settingsCall = api.addPanel.mock.calls[1][0] as { position?: unknown };
    expect(settingsCall.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
  });

  it('Focus adds only Chat Room', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Focus(api as never, reg);
    const ids = api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(ids).toEqual(['llm-chat/room']);
  });
});

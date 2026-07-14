import { describe, it, expect, vi } from 'vitest';
import { LAYOUT_BUILTINS } from './layoutPresets.builtins';

function fakeApi() {
  return {
    getPanel: vi.fn(() => undefined),
    addPanel: vi.fn(),
  };
}
const reg = { get: (id: string) => ({ title: id }) };

function addedIds(api: ReturnType<typeof fakeApi>): string[] {
  return api.addPanel.mock.calls.map((c) => (c[0] as { id: string }).id);
}

describe('LAYOUT_BUILTINS', () => {
  it('exposes exactly the four journey phases', () => {
    expect(Object.keys(LAYOUT_BUILTINS)).toEqual(['Design', 'Art', 'Math', 'Play']);
  });

  it('Design: chat left, GDD viewer right', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Design(api as never, reg);
    expect(addedIds(api)).toEqual(['llm-chat/room', 'gdd/viewer']);
    const gdd = api.addPanel.mock.calls[1][0] as { position?: unknown };
    expect(gdd.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
  });

  it('Art: chat left, game scene right, inspector right of it, asset board below it', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Art(api as never, reg);
    expect(addedIds(api)).toEqual(['llm-chat/room', 'game/preview', 'property-inspector/panel', 'assets/board']);
    const [, game, inspector, board] = api.addPanel.mock.calls.map((c) => c[0] as { position?: unknown });
    expect(game.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
    expect(inspector.position).toEqual({ direction: 'right', referencePanel: 'game/preview' });
    expect(board.position).toEqual({ direction: 'below', referencePanel: 'game/preview' });
  });

  it('Math: chat left, game config right, math viewer right of it', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Math(api as never, reg);
    expect(addedIds(api)).toEqual(['llm-chat/room', 'game-config/editor', 'math/viewer']);
    const [, config, math] = api.addPanel.mock.calls.map((c) => c[0] as { position?: unknown });
    expect(config.position).toEqual({ direction: 'right', referencePanel: 'llm-chat/room' });
    expect(math.position).toEqual({ direction: 'right', referencePanel: 'game-config/editor' });
  });

  it('Play: game scene dominant, chat docked left and narrow', () => {
    const api = fakeApi();
    LAYOUT_BUILTINS.Play(api as never, reg);
    expect(addedIds(api)).toEqual(['game/preview', 'llm-chat/room']);
    const chat = api.addPanel.mock.calls[1][0] as { position?: unknown; initialWidth?: number };
    expect(chat.position).toEqual({ direction: 'left', referencePanel: 'game/preview' });
    expect(chat.initialWidth).toBe(360);
  });

  it('is idempotent: skips panes that already exist', () => {
    const api = fakeApi();
    api.getPanel = vi.fn(() => ({}) as never);
    LAYOUT_BUILTINS.Art(api as never, reg);
    expect(api.addPanel).not.toHaveBeenCalled();
  });
});

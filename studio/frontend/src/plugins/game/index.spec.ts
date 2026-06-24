import { describe, it, expect } from 'vitest';
import { game } from './index';

describe('game plugin', () => {
  it('declares the preview pane and id', () => {
    expect(game.id).toBe('game');
    expect(game.panes.map((p) => p.id)).toContain('game/preview');
  });
});

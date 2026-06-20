import { describe, it, expect } from 'vitest';
import { assets } from './index';

describe('assets plugin manifest', () => {
  it('declares id, pane, and command', () => {
    expect(assets.id).toBe('assets');
    expect(assets.persist).toBe(false);
    expect(assets.panes.map((p) => p.id)).toEqual(['assets/board']);
    expect(assets.commands?.map((c) => c.id)).toEqual(['assets/open-board']);
  });
});

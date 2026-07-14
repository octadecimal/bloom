import { describe, it, expect, vi } from 'vitest';
import { createHost } from './host';
import { createPaneRegistry } from './paneRegistry';
import { createCommandRegistry } from './commandRegistry';

function makeHost(api: unknown) {
  return createHost({
    paneRegistry: createPaneRegistry(),
    commandRegistry: createCommandRegistry(),
    getApi: () => api,
    resetLayout: () => undefined,
  });
}

describe('host.openPane', () => {
  it('no-ops when the panel is already active (avoids pointless reattach/iframe reload)', () => {
    const setActive = vi.fn();
    const api = { getPanel: () => ({ api: { isActive: true, setActive } }), addPanel: vi.fn() };
    makeHost(api).openPane('game/preview');
    expect(setActive).not.toHaveBeenCalled();
    expect(api.addPanel).not.toHaveBeenCalled();
  });

  it('focuses an open-but-inactive panel', () => {
    const setActive = vi.fn();
    const api = { getPanel: () => ({ api: { isActive: false, setActive } }), addPanel: vi.fn() };
    makeHost(api).openPane('game/preview');
    expect(setActive).toHaveBeenCalledOnce();
  });

  it('creates a missing panel', () => {
    const api = { getPanel: () => undefined, addPanel: vi.fn() };
    makeHost(api).openPane('game/preview');
    expect(api.addPanel).toHaveBeenCalledWith(expect.objectContaining({ id: 'game/preview', component: 'game/preview' }));
  });
});

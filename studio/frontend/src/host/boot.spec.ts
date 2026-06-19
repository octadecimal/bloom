import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../state/rootStore';
import { savePersisted } from '../state/persistence';
import { createPaneRegistry } from './paneRegistry';
import { createCommandRegistry } from './commandRegistry';
import { createHost } from './host';
import { boot } from './boot';
import type { IPlugin } from './types';

const Dummy = (() => null) as never;

function freshHost() {
  return createHost({
    paneRegistry: createPaneRegistry(),
    commandRegistry: createCommandRegistry(),
    getApi: () => null,
    resetLayout: () => undefined,
  });
}

beforeEach(() => {
  rootStore.plugins.set({});
  localStorage.clear();
});

describe('boot', () => {
  it('seeds plugin slices and registers panes', () => {
    const host = freshHost();
    const p: IPlugin<{ n: number }> = {
      id: 'demo',
      title: 'Demo',
      initialState: { n: 7 },
      panes: [{ id: 'demo/main', title: 'Main', component: Dummy }],
    };
    boot([p], host);
    expect(
      (rootStore.plugins.get() as Record<string, { n: number }>).demo.n,
    ).toBe(7);
    expect(host.listPanes().map((x) => x.id)).toEqual(['demo/main']);
  });

  it('isolates a plugin whose init throws; others still register', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = freshHost();
    const bad: IPlugin = {
      id: 'bad',
      title: 'Bad',
      panes: [],
      init: () => {
        throw new Error('boom');
      },
    };
    const good: IPlugin = {
      id: 'good',
      title: 'Good',
      panes: [{ id: 'good/p', title: 'P', component: Dummy }],
    };
    expect(() => boot([bad, good], host)).not.toThrow();
    expect(host.listPanes().map((x) => x.id)).toEqual(['good/p']);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('hydrates a persisted slice for persist:true plugins', () => {
    savePersisted('demo', 1, { n: 99 });
    const host = freshHost();
    const p: IPlugin<{ n: number }> = {
      id: 'demo',
      title: 'Demo',
      persist: true,
      initialState: { n: 0 },
      panes: [],
    };
    boot([p], host);
    expect(
      (rootStore.plugins.get() as Record<string, { n: number }>).demo.n,
    ).toBe(99);
  });
});

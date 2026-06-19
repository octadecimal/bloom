import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLayoutService, panelIdsFromLayout } from './layoutService';
import { savePersisted } from '../state/persistence';

beforeEach(() => localStorage.clear());

function fakeApi(saved: unknown) {
  return {
    toJSON: () => saved,
    fromJSON: vi.fn(),
    onDidLayoutChange: (_cb: () => void) => ({ dispose() {} }),
  } as never;
}

describe('panelIdsFromLayout', () => {
  it('extracts panel ids from a dockview layout blob', () => {
    const layout = { panels: { 'p/a': {}, 'p/b': {} } };
    expect(panelIdsFromLayout(layout).sort()).toEqual(['p/a', 'p/b']);
  });
});

describe('layoutService restore', () => {
  const known = new Set(['p/a']);
  const paneRegistry = {
    get: (id: string) => (known.has(id) ? { id } : undefined),
  } as never;

  it('restores when all saved panel ids are known', () => {
    savePersisted('layout', 1, { panels: { 'p/a': {} } });
    const api = fakeApi({});
    const def = vi.fn();
    createLayoutService({ paneRegistry, defaultLayout: def }).attach(api);
    expect(api.fromJSON).toHaveBeenCalledTimes(1);
    expect(def).not.toHaveBeenCalled();
  });

  it('falls back to default when any saved panel id is unknown', () => {
    savePersisted('layout', 1, { panels: { 'p/a': {}, 'p/GONE': {} } });
    const api = fakeApi({});
    const def = vi.fn();
    createLayoutService({ paneRegistry, defaultLayout: def }).attach(api);
    expect(api.fromJSON).not.toHaveBeenCalled();
    expect(def).toHaveBeenCalledTimes(1);
  });

  it('uses default when nothing is saved', () => {
    const api = fakeApi({});
    const def = vi.fn();
    createLayoutService({ paneRegistry, defaultLayout: def }).attach(api);
    expect(def).toHaveBeenCalledTimes(1);
  });
});

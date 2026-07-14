import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setDockviewApi, getDockviewApi, onDockviewApiChange, _resetDockviewApiForTests } from './dockviewApiRef';
import type { DockviewApi } from 'dockview-react';

beforeEach(() => _resetDockviewApiForTests());

describe('dockviewApiRef', () => {
  it('is null before set, returns the api after', () => {
    expect(getDockviewApi()).toBeNull();
    const api = {} as DockviewApi;
    setDockviewApi(api);
    expect(getDockviewApi()).toBe(api);
  });

  it('notifies subscribers on set, and unsubscribe stops notifications', () => {
    const listener = vi.fn();
    const off = onDockviewApiChange(listener);
    setDockviewApi({} as DockviewApi);
    expect(listener).toHaveBeenCalledOnce();
    off();
    setDockviewApi({} as DockviewApi);
    expect(listener).toHaveBeenCalledOnce();
  });
});

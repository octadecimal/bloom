import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rootStore } from './rootStore';
import { loadPersisted, STORAGE_PREFIX } from './persistence';
import { registerSlicePersistence } from './persistSlices';
import type { IPlugin } from '../host/types';

// Minimal IPlugin stubs
const keepPlugin: IPlugin = {
  id: 'keep',
  title: 'Keep',
  panes: [],
  persist: true,
};
const skipPlugin: IPlugin = {
  id: 'skip',
  title: 'Skip',
  panes: [],
  persist: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  rootStore.plugins.set({});
});

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
});

describe('registerSlicePersistence', () => {
  it('saves a persist:true slice to localStorage after debounce, leaves persist:false untouched', () => {
    rootStore.plugins.merge({ keep: { n: 0 }, skip: { n: 0 } });
    cleanup = registerSlicePersistence([keepPlugin, skipPlugin]);

    // Mutate the persist:true slice
    rootStore.plugins.nested('keep').set({ n: 5 });

    // Before debounce fires, nothing should be saved yet
    expect(localStorage.getItem(STORAGE_PREFIX + 'keep')).toBeNull();

    // Advance past the 250ms debounce
    vi.advanceTimersByTime(300);

    // persist:true → saved with the updated value
    expect(loadPersisted('keep', 1, { n: -1 })).toEqual({ n: 5 });
    // persist:false → never saved
    expect(localStorage.getItem(STORAGE_PREFIX + 'skip')).toBeNull();
  });

  it('coalesces rapid mutations to a single save of the final value', () => {
    rootStore.plugins.merge({ keep: { n: 0 } });
    cleanup = registerSlicePersistence([keepPlugin]);

    rootStore.plugins.nested('keep').set({ n: 1 });
    rootStore.plugins.nested('keep').set({ n: 2 });
    rootStore.plugins.nested('keep').set({ n: 3 });

    // No save yet
    expect(localStorage.getItem(STORAGE_PREFIX + 'keep')).toBeNull();

    vi.advanceTimersByTime(300);

    // Only the final value was persisted
    expect(loadPersisted('keep', 1, { n: -1 })).toEqual({ n: 3 });
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadPersisted,
  savePersisted,
  makeDebouncedSaver,
  STORAGE_PREFIX,
} from './persistence';

beforeEach(() => localStorage.clear());

describe('persistence codec', () => {
  it('round-trips data under a prefixed key', () => {
    savePersisted('workspace', 1, { theme: 'light' });
    expect(localStorage.getItem(STORAGE_PREFIX + 'workspace')).toContain(
      '"version":1',
    );
    expect(loadPersisted('workspace', 1, { theme: 'dark' })).toEqual({
      theme: 'light',
    });
  });

  it('falls back when the key is absent', () => {
    expect(loadPersisted('missing', 1, { n: 0 })).toEqual({ n: 0 });
  });

  it('falls back on version mismatch', () => {
    savePersisted('k', 1, { n: 5 });
    expect(loadPersisted('k', 2, { n: 0 })).toEqual({ n: 0 });
  });

  it('falls back on corrupt JSON without throwing', () => {
    localStorage.setItem(STORAGE_PREFIX + 'k', '{not json');
    expect(loadPersisted('k', 1, { n: 0 })).toEqual({ n: 0 });
  });

  it('debounced saver coalesces rapid writes', () => {
    vi.useFakeTimers();
    const save = makeDebouncedSaver<{ n: number }>('k', 1, 50);
    save({ n: 1 });
    save({ n: 2 });
    vi.advanceTimersByTime(60);
    expect(loadPersisted('k', 1, { n: 0 })).toEqual({ n: 2 });
    vi.useRealTimers();
  });
});

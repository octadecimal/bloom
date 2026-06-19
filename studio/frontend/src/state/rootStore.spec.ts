import { describe, it, expect, afterEach } from 'vitest';
import { rootStore } from './rootStore';

describe('rootStore', () => {
  afterEach(() => {
    rootStore.plugins.set({});
  });

  it('starts with a dark theme and an empty plugins map', () => {
    expect(rootStore.workspace.theme.get()).toBe('dark');
    expect(rootStore.plugins.get()).toEqual({});
  });

  it('allows seeding a plugin slice by id', () => {
    rootStore.plugins.merge({ probe: { n: 1 } });
    expect(
      (rootStore.plugins.get() as Record<string, { n: number }>).probe.n,
    ).toBe(1);
  });
});

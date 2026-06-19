import { describe, it, expect } from 'vitest';
import { createPaneRegistry } from './paneRegistry';
import { createCommandRegistry } from './commandRegistry';

const Dummy = () => null;

describe('paneRegistry', () => {
  it('registers, gets, lists, and returns a stable component map until changed', () => {
    const r = createPaneRegistry();
    r.register({ id: 'p/a', title: 'A', component: Dummy as never });
    expect(r.get('p/a')?.title).toBe('A');
    expect(r.list()).toHaveLength(1);
    const map1 = r.asComponentMap();
    expect(r.asComponentMap()).toBe(map1); // stable reference, no re-instantiation
    r.register({ id: 'p/b', title: 'B', component: Dummy as never });
    expect(r.asComponentMap()).not.toBe(map1); // rebuilt after a change
    expect(Object.keys(r.asComponentMap())).toEqual(['p/a', 'p/b']);
  });
});

describe('commandRegistry', () => {
  it('registers, gets, and lists', () => {
    const r = createCommandRegistry();
    const run = () => undefined;
    r.register({ id: 'p/do', title: 'Do', run });
    expect(r.get('p/do')?.title).toBe('Do');
    expect(r.list()).toHaveLength(1);
  });
});

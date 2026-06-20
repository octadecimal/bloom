import { describe, it, expect } from 'vitest';
import { setupApp } from './setupApp';

describe('setupApp', () => {
  it('is a memoized singleton', () => {
    expect(setupApp()).toBe(setupApp());
  });
  it('exposes host, paneRegistry, components, attachDockview', () => {
    const a = setupApp();
    expect(a.host).toBeTruthy();
    expect(a.paneRegistry).toBeTruthy();
    expect(a.components).toBeTruthy();
    expect(typeof a.attachDockview).toBe('function');
  });
});

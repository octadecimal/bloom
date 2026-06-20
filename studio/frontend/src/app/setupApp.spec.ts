import { describe, it, expect } from 'vitest';
import { setupApp } from './setupApp';
import { getLayoutPresets } from '../state/layoutPresetsRef';

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

  it('registers shell layout commands in the palette', () => {
    const ids = setupApp().host.listCommands().map((c) => c.id);
    expect(ids).toContain('shell/save-layout');
    expect(ids).toContain('shell/reset-layout');
  });

  it('exposes the layout presets service via the ref', () => {
    setupApp();
    expect(getLayoutPresets()).toBeTruthy();
    expect(getLayoutPresets().list().some((p) => p.kind === 'builtin')).toBe(true);
  });
});

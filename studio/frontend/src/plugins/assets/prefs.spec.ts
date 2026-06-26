import { describe, it, expect, beforeEach } from 'vitest';
import { loadPrefs, savePrefs } from './prefs';

describe('assets prefs', () => {
  beforeEach(() => localStorage.clear());

  it('loadPrefs defaults to medium on first run', () => {
    expect(loadPrefs()).toEqual({ viewMode: 'medium' });
  });

  it('savePrefs round-trips through loadPrefs', () => {
    savePrefs({ viewMode: 'small' });
    expect(loadPrefs()).toEqual({ viewMode: 'small' });
  });

  it('persists under the bloom.studio.assets.prefs key', () => {
    savePrefs({ viewMode: 'list' });
    expect(localStorage.getItem('bloom.studio.assets.prefs')).toContain('list');
  });

  it('falls back to the default when a stale version is stored', () => {
    localStorage.setItem('bloom.studio.assets.prefs', JSON.stringify({ version: 0, data: { viewMode: 'list' } }));
    expect(loadPrefs()).toEqual({ viewMode: 'medium' });
  });
});

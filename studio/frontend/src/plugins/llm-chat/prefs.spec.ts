import { describe, it, expect, beforeEach } from 'vitest';
import { generateGuestName, loadPrefs, savePrefs } from './prefs';

describe('llm-chat prefs', () => {
  beforeEach(() => localStorage.clear());

  it('generateGuestName matches guest-NNNN', () => {
    expect(generateGuestName()).toMatch(/^guest-\d{4}$/);
  });

  it('loadPrefs generates a guest name and null room on first run', () => {
    const p = loadPrefs();
    expect(p.displayName).toMatch(/^guest-\d{4}$/);
    expect(p.activeRoomId).toBeNull();
  });

  it('savePrefs round-trips through loadPrefs', () => {
    savePrefs({ displayName: 'alice', activeRoomId: 'r9' });
    const p = loadPrefs();
    expect(p).toEqual({ displayName: 'alice', activeRoomId: 'r9' });
  });

  it('persists under the bloom.studio.llm-chat.prefs key', () => {
    savePrefs({ displayName: 'bob', activeRoomId: null });
    expect(localStorage.getItem('bloom.studio.llm-chat.prefs')).toContain('bob');
  });
});

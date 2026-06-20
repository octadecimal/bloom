import { describe, it, expect, beforeEach } from 'vitest';
import { loadPrefs, savePrefs } from './prefs';

describe('llm-chat prefs', () => {
  beforeEach(() => localStorage.clear());

  it('loadPrefs returns null activeRoomId on first run (v2 shape)', () => {
    const p = loadPrefs();
    expect(p).toEqual({ activeRoomId: null });
  });

  it('savePrefs round-trips through loadPrefs', () => {
    savePrefs({ activeRoomId: 'r9' });
    const p = loadPrefs();
    expect(p).toEqual({ activeRoomId: 'r9' });
  });

  it('persists under the bloom.studio.llm-chat.prefs key', () => {
    savePrefs({ activeRoomId: 'r1' });
    expect(localStorage.getItem('bloom.studio.llm-chat.prefs')).toContain('r1');
  });
});

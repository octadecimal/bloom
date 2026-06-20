import { describe, it, expect, beforeEach } from 'vitest';
import { loadSession, saveSession, clearSession } from './session';

beforeEach(() => localStorage.clear());

describe('session', () => {
  it('returns null when nothing stored', () => {
    expect(loadSession()).toBeNull();
  });
  it('round-trips a username', () => {
    saveSession('ada');
    expect(loadSession()).toEqual({ username: 'ada' });
  });
  it('clear removes it', () => {
    saveSession('ada');
    clearSession();
    expect(loadSession()).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { splitSlashDraft, moveHighlight, clampHighlight, decideEnter } from './slashParse';

describe('splitSlashDraft', () => {
  it('returns null for non-slash drafts', () => {
    expect(splitSlashDraft('hello world')).toBeNull();
    expect(splitSlashDraft('')).toBeNull();
  });
  it('parses a name being typed (no space yet)', () => {
    expect(splitSlashDraft('/gen')).toEqual({ skillName: 'gen', hasSpace: false, prose: '' });
  });
  it('parses a completed name with empty prose', () => {
    expect(splitSlashDraft('/generate-sprite ')).toEqual({ skillName: 'generate-sprite', hasSpace: true, prose: '' });
  });
  it('parses a name plus prose', () => {
    expect(splitSlashDraft('/generate-sprite a knight in armor')).toEqual({
      skillName: 'generate-sprite',
      hasSpace: true,
      prose: 'a knight in armor',
    });
  });
});

describe('moveHighlight', () => {
  it('wraps forward and backward', () => {
    expect(moveHighlight(0, 1, 3)).toBe(1);
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
  });
  it('returns 0 for an empty list', () => {
    expect(moveHighlight(0, 1, 0)).toBe(0);
  });
});

describe('clampHighlight', () => {
  it('clamps past-the-end into range', () => {
    expect(clampHighlight(5, 3)).toBe(2);
    expect(clampHighlight(-1, 3)).toBe(0);
    expect(clampHighlight(1, 0)).toBe(0);
  });
});

describe('decideEnter', () => {
  const matches = [{ name: 'generate-sprite' }, { name: 'generate-background' }];
  it('accepts the highlighted match while the popup is open (no space)', () => {
    expect(decideEnter('/gen', matches, 1)).toEqual({ kind: 'accept', name: 'generate-background' });
  });
  it('runs with prose once the name is completed and prose typed', () => {
    expect(decideEnter('/generate-sprite a knight', [], 0)).toEqual({ kind: 'run', name: 'generate-sprite', prose: 'a knight' });
  });
  it('opens the form on bare Enter after completion (no prose)', () => {
    expect(decideEnter('/generate-sprite ', [], 0)).toEqual({ kind: 'form', name: 'generate-sprite' });
  });
  it('falls back to send for a plain message', () => {
    expect(decideEnter('hello', [], 0)).toEqual({ kind: 'send' });
  });
  it('falls back to send for an unknown slash with no matches and no space', () => {
    expect(decideEnter('/nope', [], 0)).toEqual({ kind: 'send' });
  });
});

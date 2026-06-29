import { describe, it, expect } from 'vitest';
import { validatePresentation, toReelsConfig, PlayModeError } from './presentationConfig';
import type { IHandshakeResponse } from './wireTypes';

const ok: IHandshakeResponse = {
  package_id: 'bloom-demo-slots',
  package_version: 1,
  mechanic: 'slots@1',
  presentation: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' },
};

describe('validatePresentation', () => {
  it('returns the presentation for a valid slots@1 handshake', () => {
    expect(validatePresentation(ok)).toEqual({ cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' });
  });

  it('rejects a non-slots@1 mechanic', () => {
    expect(() => validatePresentation({ ...ok, mechanic: 'poker@1' })).toThrow(PlayModeError);
  });

  it('rejects an empty/null presentation', () => {
    expect(() => validatePresentation({ ...ok, presentation: null })).toThrow(PlayModeError);
  });

  it('rejects a presentation missing cols/rows/symbols', () => {
    expect(() => validatePresentation({ ...ok, presentation: { cols: 3 } })).toThrow(PlayModeError);
  });

  it('rejects a presentation whose symbols array contains non-string elements', () => {
    expect(() => validatePresentation({ ...ok, presentation: { cols: 3, rows: 3, symbols: [0, 1, 2] } })).toThrow(PlayModeError);
  });

  it('rejects a presentation missing symbols entirely', () => {
    expect(() => validatePresentation({ ...ok, presentation: { cols: 3, rows: 3 } })).toThrow(PlayModeError);
  });
});

describe('toReelsConfig', () => {
  it('maps the presentation to reels config fields', () => {
    expect(toReelsConfig({ cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' })).toEqual({
      cols: 3,
      rows: 3,
      symbols: ['0', '1', '2', '9'],
      parentId: 'root',
    });
  });

  it('defaults parentId to root when omitted', () => {
    expect(toReelsConfig({ cols: 5, rows: 3, symbols: ['A'] }).parentId).toBe('root');
  });
});

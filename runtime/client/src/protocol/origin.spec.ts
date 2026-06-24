import { describe, it, expect } from 'vitest';
import { parseParentOrigin, originAllowed } from './origin';

describe('parseParentOrigin', () => {
  it('returns the decoded parentOrigin param', () => {
    expect(parseParentOrigin('?parentOrigin=http%3A%2F%2Fhost%3A4200')).toBe('http://host:4200');
  });
  it('returns null when absent or empty', () => {
    expect(parseParentOrigin('')).toBeNull();
    expect(parseParentOrigin('?foo=1')).toBeNull();
    expect(parseParentOrigin('?parentOrigin=')).toBeNull();
  });
});

describe('originAllowed', () => {
  it('accepts any origin in standalone (expected null)', () => {
    expect(originAllowed(null, 'http://evil.example')).toBe(true);
  });
  it('accepts only the matching origin when expected is set', () => {
    expect(originAllowed('http://host:4200', 'http://host:4200')).toBe(true);
    expect(originAllowed('http://host:4200', 'http://host:9999')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { colorForSymbol } from './symbolColor';

describe('colorForSymbol', () => {
  it('is deterministic', () => {
    expect(colorForSymbol('0')).toBe(colorForSymbol('0'));
  });
  it('returns a hex color', () => {
    expect(colorForSymbol('9')).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('distinguishes distinct symbols', () => {
    expect(colorForSymbol('0')).not.toBe(colorForSymbol('1'));
  });
});

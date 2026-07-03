import { describe, it, expect } from 'vitest';
import { SWATCHES, SWATCH_DOT_CLASS, emptyPresentation, normalizePresentation, symbolLabel, symbolColor, nextFreeSwatch } from './presentation';

describe('swatches', () => {
  it('defines 10 swatch roles each with a literal dot class', () => {
    expect(SWATCHES).toHaveLength(10);
    for (const s of SWATCHES) expect(SWATCH_DOT_CLASS[s]).toBe(`bg-${s}`);
  });
});

describe('symbolLabel / symbolColor fallbacks', () => {
  it('uses the stored entry when present', () => {
    const p = { symbols: { '0': { label: 'Ace', color: 'sym-3' } } };
    expect(symbolLabel(p, 0)).toBe('Ace');
    expect(symbolColor(p, 0)).toBe('sym-3');
  });

  it('falls back to S<id> and a deterministic swatch', () => {
    const p = emptyPresentation();
    expect(symbolLabel(p, 7)).toBe('S7');
    expect(symbolColor(p, 7)).toBe(SWATCHES[7 % 10]);
    expect(symbolColor(p, 12)).toBe(SWATCHES[12 % 10]);
  });
});

describe('nextFreeSwatch', () => {
  it('picks the first swatch not used by any entry', () => {
    const p = { symbols: { '0': { label: 'A', color: 'sym-1' }, '1': { label: 'B', color: 'sym-2' } } };
    expect(nextFreeSwatch(p)).toBe('sym-3');
  });

  it('wraps to sym-1 when all are used', () => {
    const symbols: Record<string, { label: string; color: string }> = {};
    SWATCHES.forEach((s, i) => (symbols[String(i)] = { label: `S${i}`, color: s }));
    expect(nextFreeSwatch({ symbols })).toBe('sym-1');
  });
});

describe('normalizePresentation', () => {
  it('defaults missing/malformed input to empty', () => {
    expect(normalizePresentation(undefined)).toEqual({ symbols: {} });
    expect(normalizePresentation({ symbols: 5 })).toEqual({ symbols: {} });
  });
  it('passes a good map through', () => {
    const p = { symbols: { '2': { label: 'Wild', color: 'sym-4' } } };
    expect(normalizePresentation(p)).toEqual(p);
  });
});

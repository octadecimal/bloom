import { describe, it, expect } from 'vitest';
import { validateConfig, type IConfigSchema } from './schema';

const SCHEMA: IConfigSchema = {
  rows: { type: 'integer', default: 3, min: 1, max: 8 },
  cols: { type: 'integer', default: 5, min: 1, max: 10 },
  cellSize: { type: 'number', default: 100, min: 1 },
  symbols: { type: 'stringArray', default: ['A', 'B', 'C'] },
  parentId: { type: 'string', default: 'root', binding: 'parent' },
};

describe('validateConfig', () => {
  it('applies defaults for missing fields and reports ok', () => {
    const r = validateConfig(SCHEMA, {});
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ rows: 3, cols: 5, cellSize: 100, symbols: ['A', 'B', 'C'], parentId: 'root' });
  });

  it('keeps provided values that pass validation', () => {
    const r = validateConfig(SCHEMA, { rows: 4, cols: 6 });
    expect(r.ok).toBe(true);
    expect(r.value.rows).toBe(4);
    expect(r.value.cols).toBe(6);
  });

  it('rejects a number below min and reports a field-named error', () => {
    const r = validateConfig(SCHEMA, { rows: 0 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('rows'))).toBe(true);
  });

  it('rejects a number above max', () => {
    const r = validateConfig(SCHEMA, { cols: 99 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('cols'))).toBe(true);
  });

  it('rejects a non-integer for an integer field', () => {
    const r = validateConfig(SCHEMA, { rows: 2.5 });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('rows'))).toBe(true);
  });

  it('rejects a wrong-typed field (string where number expected)', () => {
    const r = validateConfig(SCHEMA, { cellSize: 'big' });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('cellSize'))).toBe(true);
  });

  it('rejects a stringArray containing a non-string', () => {
    const r = validateConfig(SCHEMA, { symbols: ['A', 2] });
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('symbols'))).toBe(true);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { valueTypeOf, toInputText, parseEditInput, makeDebounced } from './edit';

describe('valueTypeOf', () => {
  it('classifies each scalar', () => {
    expect(valueTypeOf(3)).toBe('number');
    expect(valueTypeOf('hi')).toBe('string');
    expect(valueTypeOf(true)).toBe('boolean');
    expect(valueTypeOf(null)).toBe('null');
  });
});

describe('toInputText', () => {
  it('renders numbers and strings verbatim, null as empty', () => {
    expect(toInputText('number', 120)).toBe('120');
    expect(toInputText('string', 'hero')).toBe('hero');
    expect(toInputText('null', null)).toBe('');
  });
});

describe('parseEditInput', () => {
  it('parses numbers, suppressing empty/NaN', () => {
    expect(parseEditInput('number', '12')).toEqual({ ok: true, value: 12 });
    expect(parseEditInput('number', '1.5')).toEqual({ ok: true, value: 1.5 });
    expect(parseEditInput('number', '')).toEqual({ ok: false });
    expect(parseEditInput('number', 'abc')).toEqual({ ok: false });
  });
  it('parses booleans from toggle text', () => {
    expect(parseEditInput('boolean', 'true')).toEqual({ ok: true, value: true });
    expect(parseEditInput('boolean', 'false')).toEqual({ ok: true, value: false });
  });
  it('passes strings through', () => {
    expect(parseEditInput('string', 'hero')).toEqual({ ok: true, value: 'hero' });
    expect(parseEditInput('string', '')).toEqual({ ok: true, value: '' });
  });
  it('keeps null empty, otherwise becomes a string', () => {
    expect(parseEditInput('null', '')).toEqual({ ok: true, value: null });
    expect(parseEditInput('null', 'x')).toEqual({ ok: true, value: 'x' });
  });
});

describe('makeDebounced', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces rapid calls into one, last args win', () => {
    const fn = vi.fn();
    const d = makeDebounced(fn, 80);
    d(1);
    d(2);
    d(3);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
  });
});

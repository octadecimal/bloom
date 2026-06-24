import { describe, it, expect } from 'vitest';
import { statusFromResult } from './reducers';

describe('simulator reducers', () => {
  it('maps a pass result to status pass', () => {
    expect(statusFromResult({ status: 'pass' } as never)).toBe('pass');
  });
  it('maps a fail result to status fail', () => {
    expect(statusFromResult({ status: 'fail' } as never)).toBe('fail');
  });
  it('maps an error result to status error', () => {
    expect(statusFromResult({ status: 'error' } as never)).toBe('error');
  });
});

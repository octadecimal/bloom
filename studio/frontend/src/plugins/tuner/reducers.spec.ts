import { describe, it, expect } from 'vitest';
import { statusFromResult } from './reducers';
import type { ITuneResult } from './state';

describe('statusFromResult', () => {
  it('maps the result status through', () => {
    const r = { status: 'near_miss' } as ITuneResult;
    expect(statusFromResult(r)).toBe('near_miss');
  });
});

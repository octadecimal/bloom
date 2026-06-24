import { describe, it, expect } from 'vitest';
import { isAtBottom } from './scroll';

describe('isAtBottom', () => {
  it('is true exactly at the bottom', () => {
    expect(isAtBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
  });

  it('is true within the default 48px threshold', () => {
    expect(isAtBottom({ scrollTop: 570, clientHeight: 400, scrollHeight: 1000 })).toBe(true); // 30px from bottom
  });

  it('is false above the threshold', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 })).toBe(false); // 100px from bottom
  });

  it('treats a zero-size container as pinned (fresh/unlaid-out feed)', () => {
    expect(isAtBottom({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 })).toBe(true);
  });

  it('honours a custom threshold', () => {
    expect(isAtBottom({ scrollTop: 500, clientHeight: 400, scrollHeight: 1000 }, 150)).toBe(true); // 100px gap, 150 threshold
  });
});

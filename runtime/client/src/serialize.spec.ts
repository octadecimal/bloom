import { describe, it, expect } from 'vitest';
import { createSerializer } from './serialize';

describe('createSerializer', () => {
  it('runs tasks in strict FIFO order (B waits for A to complete)', async () => {
    const enqueue = createSerializer();
    const order: string[] = [];

    let resolveA!: () => void;
    const deferA = new Promise<void>((res) => {
      resolveA = res;
    });

    enqueue(async () => {
      await deferA;
      order.push('A');
    });
    enqueue(() => {
      order.push('B');
    });

    // B should NOT have run yet — A is still waiting on deferA
    await Promise.resolve();
    expect(order).toEqual([]);

    // Unblock A; now both should complete in order
    resolveA();
    // Drain the microtask queue: A resolves, then B runs, then the catch wrappers settle
    await new Promise((res) => setTimeout(res, 0));

    expect(order).toEqual(['A', 'B']);
  });

  it('isolates failures — a rejected task does not wedge subsequent tasks', async () => {
    const enqueue = createSerializer();
    const order: string[] = [];

    enqueue(() => {
      return Promise.reject(new Error('task A failed'));
    });
    enqueue(() => {
      order.push('B');
    });

    await new Promise((res) => setTimeout(res, 0));

    expect(order).toEqual(['B']);
  });
});

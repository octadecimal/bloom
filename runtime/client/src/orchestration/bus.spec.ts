import { describe, it, expect, vi } from 'vitest';
import { createBus } from './bus';

describe('createBus', () => {
  it('delivers an emitted payload to every subscriber of that event', () => {
    const bus = createBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('reels:settled', a);
    bus.on('reels:settled', b);
    bus.emit('reels:settled', { grid: [['A']] });
    expect(a).toHaveBeenCalledWith({ grid: [['A']] });
    expect(b).toHaveBeenCalledWith({ grid: [['A']] });
  });

  it('does not deliver to subscribers of a different event', () => {
    const bus = createBus();
    const other = vi.fn();
    bus.on('round:complete', other);
    bus.emit('reels:settled', { grid: [] });
    expect(other).not.toHaveBeenCalled();
  });

  it('stops delivering after the unsubscribe thunk is called', () => {
    const bus = createBus();
    const h = vi.fn();
    const off = bus.on('reels:settled', h);
    off();
    bus.emit('reels:settled', { grid: [] });
    expect(h).not.toHaveBeenCalled();
  });

  it('off() removes a handler by reference', () => {
    const bus = createBus();
    const h = vi.fn();
    bus.on('x', h);
    bus.off('x', h);
    bus.emit('x', 1);
    expect(h).not.toHaveBeenCalled();
  });

  it('emitting an event with no subscribers is a no-op (does not throw)', () => {
    const bus = createBus();
    expect(() => bus.emit('nobody', 1)).not.toThrow();
  });

  it('a handler unsubscribing during emit does not skip the next handler', () => {
    const bus = createBus();
    const calls: string[] = [];
    const second = () => calls.push('second');
    const first = () => {
      calls.push('first');
      bus.off('e', second);
    };
    bus.on('e', first);
    bus.on('e', second);
    bus.emit('e', 0);
    expect(calls).toEqual(['first', 'second']);
  });
});

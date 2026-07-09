import { describe, it, expect, vi } from 'vitest';
import { createBus } from './bus';
import { Orchestrator } from './orchestrator';

function fakeReels() {
  return { project: vi.fn(), startSpinning: vi.fn(), stopSpinning: vi.fn() };
}

describe('Orchestrator', () => {
  it('spin() ensures projection then starts + hands the outcome to the module', () => {
    const bus = createBus();
    const reels = fakeReels();
    const orch = new Orchestrator({ bus, reels: () => reels });
    const outcome = { grid: [['A']] };
    orch.spin(outcome);
    expect(reels.project).toHaveBeenCalled();
    expect(reels.startSpinning).toHaveBeenCalled();
    expect(reels.stopSpinning).toHaveBeenCalledWith(outcome);
  });

  it('re-emits round:complete when the module reports reels:settled after a spin it initiated', () => {
    const bus = createBus();
    const reels = fakeReels();
    const orch = new Orchestrator({ bus, reels: () => reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    orch.spin({ grid: [['X']] });
    bus.emit('reels:settled', { grid: [['A'], ['B']] });
    expect(done).toHaveBeenCalledWith({ grid: [['A'], ['B']] });
  });

  it('does not re-emit round:complete for reels:settled without a prior spin() (e.g. composed@1 trace walks)', () => {
    const bus = createBus();
    const reels = fakeReels();
    new Orchestrator({ bus, reels: () => reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    bus.emit('reels:settled', { grid: [['A']] });
    expect(done).not.toHaveBeenCalled();
  });

  it('dispose() stops it from reacting to further reels:settled events', () => {
    const bus = createBus();
    const reels = fakeReels();
    const orch = new Orchestrator({ bus, reels: () => reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    orch.dispose();
    bus.emit('reels:settled', { grid: [] });
    expect(done).not.toHaveBeenCalled();
  });

  it('spin() is a no-op when the reels resolver returns null', () => {
    const bus = createBus();
    const orch = new Orchestrator({ bus, reels: () => null });
    // should not throw
    expect(() => orch.spin({ grid: [['A']] })).not.toThrow();
  });
});

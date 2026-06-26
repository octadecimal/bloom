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
    const orch = new Orchestrator({ bus, reels });
    const outcome = { grid: [['A']] };
    orch.spin(outcome);
    expect(reels.project).toHaveBeenCalled();
    expect(reels.startSpinning).toHaveBeenCalled();
    expect(reels.stopSpinning).toHaveBeenCalledWith(outcome);
  });

  it('re-emits round:complete when the module reports reels:settled', () => {
    const bus = createBus();
    const reels = fakeReels();
    new Orchestrator({ bus, reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    bus.emit('reels:settled', { grid: [['A'], ['B']] });
    expect(done).toHaveBeenCalledWith({ grid: [['A'], ['B']] });
  });

  it('dispose() stops it from reacting to further reels:settled events', () => {
    const bus = createBus();
    const reels = fakeReels();
    const orch = new Orchestrator({ bus, reels });
    const done = vi.fn();
    bus.on('round:complete', done);
    orch.dispose();
    bus.emit('reels:settled', { grid: [] });
    expect(done).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from 'vitest';
import { emptyDefinition, normalizeDefinition, type IGameDefinition } from './model';

function full(): IGameDefinition {
  return {
    family: 'composed@1',
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: { rows: 3, strips: [[0]], symbols: [], paylines: [], paytable: { entries: [] }, events: [] } },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
    states: [
      {
        id: 'base',
        bindings: [{ mechanic: 'main_reels' }, { mechanic: 'bonus_meter' }],
        steps: { budget: 1 },
        script: [{ invoke: 'main_reels.spin' }, { invoke: 'bonus_meter.accumulate' }],
      },
      {
        id: 'fs1',
        bindings: [{ mechanic: 'main_reels', override: { multiplier: 2 } }],
        steps: { budget: 'awarded', initial: 8 },
        script: [{ invoke: 'main_reels.spin' }],
      },
    ],
    start: 'base',
    transitions: [
      { from: 'base', on: 'scatters:3', to: 'fs1' },
      { from: 'fs1', on: 'scatters:3', effect: 'steps:add:8' },
    ],
    caps: { max_steps: 1000 },
  };
}

describe('normalizeDefinition', () => {
  it('passes a complete definition through untouched', () => {
    const def = full();
    expect(normalizeDefinition(def)).toEqual(def);
  });

  it('defaults null/undefined/garbage to emptyDefinition', () => {
    expect(normalizeDefinition(null)).toEqual(emptyDefinition());
    expect(normalizeDefinition(undefined)).toEqual(emptyDefinition());
    expect(normalizeDefinition(42)).toEqual(emptyDefinition());
  });

  it('repairs missing top-level fields but keeps good ones', () => {
    const got = normalizeDefinition({ family: 'composed@1', start: 'base' });
    expect(got.start).toBe('base');
    expect(got.mechanics).toEqual([]);
    expect(got.transitions).toEqual([]);
    expect(got.caps).toEqual({ max_steps: 1000 });
  });

  it('is pure', () => {
    const raw = full();
    const snapshot = JSON.stringify(raw);
    normalizeDefinition(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });
});

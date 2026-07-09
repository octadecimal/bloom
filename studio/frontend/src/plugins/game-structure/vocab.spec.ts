import { describe, expect, it } from 'vitest';
import { emptyDefinition } from './model';
import { ACTIONS, MECHANIC_CATALOG, STEPS_EXHAUSTED, emittableEvents, invokeOptions } from './vocab';

function def() {
  const d = emptyDefinition();
  d.mechanics = [
    { id: 'r', type: 'reels@1', config: { events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }] } },
    { id: 'm', type: 'meter@1', config: { target: 6 } },
  ];
  d.states = [{ id: 's', bindings: [{ mechanic: 'r' }, { mechanic: 'm' }], steps: { budget: 1 }, script: [] }];
  return d;
}

describe('vocab', () => {
  it('catalog covers the two shipped mechanics with default configs', () => {
    expect(MECHANIC_CATALOG.map((c) => c.type)).toEqual(['reels@1', 'meter@1']);
    for (const c of MECHANIC_CATALOG) expect(c.defaultConfig).toBeTruthy();
  });

  it('emittableEvents = reels emit strings + meter:full (when a meter exists) + steps:exhausted', () => {
    expect(emittableEvents(def())).toEqual(['scatters:3', 'meter:full', STEPS_EXHAUSTED]);
    const noMeter = def();
    noMeter.mechanics = noMeter.mechanics.filter((m) => m.type !== 'meter@1');
    expect(emittableEvents(noMeter)).toEqual(['scatters:3', STEPS_EXHAUSTED]);
  });

  it('emittableEvents dedupes and keeps first-seen order', () => {
    const d = def();
    d.mechanics.push({ id: 'r2', type: 'reels@1', config: { events: [{ symbol: 9, min_count: 4, emit: 'scatters:3' }] } });
    expect(emittableEvents(d)).toEqual(['scatters:3', 'meter:full', STEPS_EXHAUSTED]);
  });

  it('invokeOptions lists <bound instance>.<action> pairs only', () => {
    const d = def();
    expect(invokeOptions(d, d.states[0])).toEqual(['r.spin', 'm.accumulate']);
    expect(ACTIONS['reels@1']).toEqual(['spin']);
  });
});

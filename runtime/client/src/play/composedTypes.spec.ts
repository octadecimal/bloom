import { describe, it, expect } from 'vitest';
import { validateDefinition } from './composedTypes';
import { PlayModeError } from './presentationConfig';

const DEF = {
  family: 'composed@1',
  mechanics: [
    { id: 'main_reels', type: 'reels@1', config: { strips: [[0]], rows: 1 } },
    { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9 } },
  ],
  states: [],
  start: 'base',
  transitions: [],
  caps: { max_steps: 100 },
};

describe('validateDefinition', () => {
  it('accepts a composed@1 definition and returns it typed', () => {
    const def = validateDefinition(DEF);
    expect(def.mechanics.map((m) => m.id)).toEqual(['main_reels', 'bonus_meter']);
    expect(def.mechanics[1].type).toBe('meter@1');
  });

  it('rejects a missing/empty definition', () => {
    expect(() => validateDefinition(undefined)).toThrow(PlayModeError);
    expect(() => validateDefinition(null)).toThrow(/definition/);
  });

  it('rejects a wrong family', () => {
    expect(() => validateDefinition({ ...DEF, family: 'slots@1' })).toThrow(/family/);
  });

  it('rejects mechanics that are missing, empty, or malformed', () => {
    expect(() => validateDefinition({ ...DEF, mechanics: [] })).toThrow(/mechanics/);
    expect(() => validateDefinition({ ...DEF, mechanics: [{ id: 'x' }] })).toThrow(/mechanic/);
  });
});

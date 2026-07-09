import { describe, it, expect } from 'vitest';
import { toClientOutcome } from './outcomeAdapter';
import type { ISpinResponse } from './wireTypes';

function res(base_grid: number[][]): ISpinResponse {
  return {
    seed: '33',
    bet: 1,
    outcome: { mechanic: 'slots@1', base_grid, base_payout: 0, feature_payout: 0, total_payout: 0, features: [] },
  };
}

describe('toClientOutcome', () => {
  it('stringifies symbol ids cell-for-cell', () => {
    expect(
      toClientOutcome(
        res([
          [0, 1, 2],
          [9, 0, 1],
        ]),
      ).grid,
    ).toEqual([
      ['0', '1', '2'],
      ['9', '0', '1'],
    ]);
  });

  it('preserves orientation without transposing (non-square grid proves col/row are not swapped)', () => {
    // 3 reels x 2 rows -> client grid must be 3 columns each of length 2.
    const grid = toClientOutcome(
      res([
        [0, 1],
        [2, 9],
        [1, 0],
      ]),
    ).grid;
    expect(grid.length).toBe(3);
    expect(grid.every((reel) => reel.length === 2)).toBe(true);
    expect(grid).toEqual([
      ['0', '1'],
      ['2', '9'],
      ['1', '0'],
    ]);
  });

  it('throws on an unsupported mechanic', () => {
    const bad = res([[0]]);
    (bad.outcome as { mechanic: string }).mechanic = 'poker@1';
    expect(() => toClientOutcome(bad)).toThrow();
  });
});

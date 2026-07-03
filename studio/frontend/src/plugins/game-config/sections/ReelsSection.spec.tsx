import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { ReelsSection } from './ReelsSection';

const applyModel = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: (m: ISlotModel) => ISlotModel) => applyModel(fn),
  applyPresentation: vi.fn(),
}));

const MODEL: ISlotModel = {
  symbols: [
    { id: 0, role: 'normal' },
    { id: 9, role: 'scatter' },
  ],
  reels: [
    [0, 9, 0],
    [0, 0, 9],
  ],
  rows: 3,
  paylines: [[0, 0]],
  paytable: { entries: [] },
  bonuses: [
    {
      FreeSpins: {
        trigger: { symbol: 9, min_count: 3 },
        config: { spins_awarded: 5, retrigger: false, multiplier: 1, feature_reels: null },
      },
    },
  ],
};

// Run the last dispatched transform against the current model — asserts end-state,
// not just that something was dispatched.
function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('ReelsSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('renders strip columns with one chip per cell', () => {
    render(<ReelsSection />);
    expect(screen.getByTestId('gc-strip-cell-0-1')).toBeTruthy();
    expect(screen.getByTestId('gc-strip-cell-1-2')).toBeTruthy();
  });

  it('window steppers dispatch setRows / setReelCount transforms', () => {
    render(<ReelsSection />);
    fireEvent.click(screen.getByTestId('gc-rows-stepper-inc'));
    expect(lastTransformResult().rows).toBe(4);
    fireEvent.click(screen.getByTestId('gc-reels-stepper-inc'));
    expect(lastTransformResult().reels).toHaveLength(3);
  });

  it('cell popover replace/insert/remove transform the strip', () => {
    render(<ReelsSection />);
    fireEvent.click(screen.getByTestId('gc-strip-cell-0-0'));
    fireEvent.click(screen.getByTestId('gc-cell-replace-9'));
    expect(lastTransformResult().reels[0]).toEqual([9, 9, 0]);
    fireEvent.click(screen.getByTestId('gc-strip-cell-0-0'));
    fireEvent.click(screen.getByTestId('gc-cell-insert-after'));
    expect(lastTransformResult().reels[0]).toEqual([0, 0, 9, 0]);
    fireEvent.click(screen.getByTestId('gc-strip-cell-0-1'));
    fireEvent.click(screen.getByTestId('gc-cell-remove'));
    expect(lastTransformResult().reels[0]).toEqual([0, 0]);
  });

  it('composition lens steppers call setSymbolCount with append/remove-last semantics', () => {
    render(<ReelsSection />);
    fireEvent.click(screen.getByTestId('gc-lens-composition'));
    expect(screen.getByTestId('gc-comp-count-0-0').textContent).toBe('2');
    fireEvent.click(screen.getByTestId('gc-comp-count-0-0-inc'));
    expect(lastTransformResult().reels[0]).toEqual([0, 9, 0, 0]);
    expect(screen.getByTestId('gc-strip-len-0').textContent).toBe('3');
    expect(screen.getByTestId('gc-freq-0-0').textContent).toBe('67%');
  });

  it('feature reel set offers add / revert', () => {
    render(<ReelsSection />);
    fireEvent.change(screen.getByTestId('gc-reelset-select'), { target: { value: 'bonus-0' } });
    fireEvent.click(screen.getByTestId('gc-add-feature-reels'));
    const out = lastTransformResult();
    expect(out.bonuses[0].FreeSpins.config.feature_reels).toEqual(MODEL.reels);
  });
});

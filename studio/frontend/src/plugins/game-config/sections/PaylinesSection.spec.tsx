import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { PaylinesSection } from './PaylinesSection';

const applyModel = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: (m: ISlotModel) => ISlotModel) => applyModel(fn),
  applyPresentation: vi.fn(),
}));

const MODEL: ISlotModel = {
  symbols: [{ id: 0, role: 'normal' }],
  reels: [
    [0, 0],
    [0, 0],
    [0, 0],
  ],
  rows: 3,
  paylines: [
    [0, 0, 0],
    [1, 1, 1],
  ],
  paytable: { entries: [] },
  bonuses: [],
};

function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('PaylinesSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('renders a card per line with the selected cells painted', () => {
    render(<PaylinesSection />);
    expect(screen.getByTestId('gc-payline-card-0')).toBeTruthy();
    // line 1 selects row 1 on every reel
    expect(screen.getByTestId('gc-pl-cell-1-0-1').className).toContain('bg-selection');
    expect(screen.getByTestId('gc-pl-cell-1-0-0').className).not.toContain('bg-selection');
  });

  it('clicking a cell repaints that reel of that line', () => {
    render(<PaylinesSection />);
    fireEvent.click(screen.getByTestId('gc-pl-cell-0-1-2'));
    expect(lastTransformResult().paylines[0]).toEqual([0, 2, 0]);
  });

  it('add / duplicate / delete dispatch the right transforms', () => {
    render(<PaylinesSection />);
    fireEvent.click(screen.getByTestId('gc-add-payline'));
    expect(lastTransformResult().paylines).toHaveLength(3);
    fireEvent.click(screen.getByTestId('gc-dup-payline-1'));
    expect(lastTransformResult().paylines[2]).toEqual([1, 1, 1]);
    fireEvent.click(screen.getByTestId('gc-del-payline-0'));
    expect(lastTransformResult().paylines).toEqual([[1, 1, 1]]);
  });

  it('shows an inline issue for an invalid line and counts overlaps in the overview', () => {
    act(() => {
      gameConfigSlice().model.set({
        ...MODEL,
        paylines: [
          [0, 0],
          [1, 1, 1],
        ],
      }); // line 0 too short
    });
    render(<PaylinesSection />);
    expect(screen.getByTestId('gc-payline-issue-0').textContent).toContain('reel count');
    expect(screen.getByTestId('gc-ov-cell-0-1').textContent).toBe('1'); // only line 1 crosses
  });
});

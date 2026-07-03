import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { PaytableSection } from './PaytableSection';

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
    [0, 9],
    [0, 9],
    [0, 9],
  ],
  rows: 3,
  paylines: [[0, 0, 0]],
  paytable: {
    entries: [
      { symbol: 0, count: 3, payout: 5 },
      { symbol: 9, count: 3, payout: 0 }, // zero payout → warning
    ],
  },
  bonuses: [],
};

function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('PaytableSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('groups rows by symbol and annotates scatter semantics', () => {
    render(<PaytableSection />);
    expect(screen.getByTestId('gc-pt-group-0').textContent).toContain('left-aligned run');
    expect(screen.getByTestId('gc-pt-group-9').textContent).toContain('total grid count');
  });

  it('count stepper, payout input, delete and add dispatch transforms', () => {
    render(<PaytableSection />);
    fireEvent.click(screen.getByTestId('gc-pt-count-0-inc'));
    expect(lastTransformResult().paytable.entries[0].count).toBe(4);
    const payout = screen.getByTestId('gc-pt-payout-0') as HTMLInputElement;
    fireEvent.focus(payout);
    fireEvent.change(payout, { target: { value: '25' } });
    fireEvent.blur(payout);
    expect(lastTransformResult().paytable.entries[0].payout).toBe(25);
    fireEvent.click(screen.getByTestId('gc-pt-delete-1'));
    expect(lastTransformResult().paytable.entries).toHaveLength(1);
    fireEvent.click(screen.getByTestId('gc-add-pt-row-0'));
    expect(lastTransformResult().paytable.entries).toHaveLength(3);
  });

  it('renders the zero-payout warning inline', () => {
    render(<PaytableSection />);
    expect(screen.getByTestId('gc-pt-issue-1').textContent).toContain('zero payout');
  });

  it('renders an orphaned row (symbol no longer in model.symbols) with its unknown-symbol issue', () => {
    act(() => {
      gameConfigSlice().model.set({
        ...MODEL,
        symbols: [{ id: 0, role: 'normal' }], // symbol 9 deleted, but its paytable row survives
        paytable: {
          entries: [
            { symbol: 0, count: 3, payout: 5 },
            { symbol: 9, count: 3, payout: 5 },
          ],
        },
      });
    });
    render(<PaytableSection />);
    expect(screen.getByTestId('gc-pt-row-1')).toBeTruthy();
    expect(screen.getByTestId('gc-pt-issue-1').textContent).toContain('unknown symbol');
  });
});

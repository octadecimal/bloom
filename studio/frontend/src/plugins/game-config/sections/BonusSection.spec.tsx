import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import type { ISlotModel } from '../model';
import { BonusSection } from './BonusSection';

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
  paytable: { entries: [] },
  bonuses: [
    {
      FreeSpins: {
        trigger: { symbol: 9, min_count: 3 },
        config: { spins_awarded: 5, retrigger: true, multiplier: 2, feature_reels: null },
      },
    },
  ],
};

function lastTransformResult(): ISlotModel {
  const fn = applyModel.mock.calls.at(-1)![0] as (m: ISlotModel) => ISlotModel;
  return fn(gameConfigSlice().model.get({ noproxy: true }) as ISlotModel);
}

describe('BonusSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
    });
  });

  it('renders the FreeSpins card with current values', () => {
    render(<BonusSection />);
    expect((screen.getByTestId('gc-bonus-trigger-symbol-0') as HTMLSelectElement).value).toBe('9');
    expect(screen.getByTestId('gc-bonus-spins-0').textContent).toBe('5');
    expect((screen.getByTestId('gc-bonus-retrigger-0') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('gc-bonus-feature-note-0').textContent).toContain('base');
  });

  it('edits dispatch trigger/config transforms', () => {
    render(<BonusSection />);
    fireEvent.click(screen.getByTestId('gc-bonus-min-count-0-inc'));
    expect(lastTransformResult().bonuses[0].FreeSpins.trigger.min_count).toBe(4);
    fireEvent.click(screen.getByTestId('gc-bonus-spins-0-inc'));
    expect(lastTransformResult().bonuses[0].FreeSpins.config.spins_awarded).toBe(6);
    fireEvent.click(screen.getByTestId('gc-bonus-retrigger-0'));
    expect(lastTransformResult().bonuses[0].FreeSpins.config.retrigger).toBe(false);
    const mult = screen.getByTestId('gc-bonus-multiplier-0') as HTMLInputElement;
    fireEvent.focus(mult);
    fireEvent.change(mult, { target: { value: '3' } });
    fireEvent.blur(mult);
    expect(lastTransformResult().bonuses[0].FreeSpins.config.multiplier).toBe(3);
  });

  it('add and delete bonuses', () => {
    render(<BonusSection />);
    fireEvent.click(screen.getByTestId('gc-add-bonus'));
    expect(lastTransformResult().bonuses).toHaveLength(2);
    fireEvent.click(screen.getByTestId('gc-bonus-delete-0'));
    expect(lastTransformResult().bonuses).toHaveLength(0);
  });
});

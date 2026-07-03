import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from './state';
import { GameConfigPane } from './GameConfigPane';
import type { ISlotModel } from './model';

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
  paytable: { entries: [{ symbol: 0, count: 2, payout: 5 }] },
  bonuses: [],
};

function seed(model: ISlotModel | null) {
  rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
  act(() => {
    gameConfigSlice().activeGameId.set(model ? 'g1' : null);
    gameConfigSlice().model.set(model);
  });
}

describe('GameConfigPane', () => {
  beforeEach(() => seed(MODEL));

  it('shows an empty state with no active game', () => {
    seed(null);
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-no-game')).toBeTruthy();
  });

  it('renders header stats from the model', () => {
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-stat-window').textContent).toBe('3 × 2');
    expect(screen.getByTestId('gc-stat-symbols').textContent).toBe('2');
    expect(screen.getByTestId('gc-stat-lines').textContent).toBe('1');
    expect(screen.getByTestId('gc-stat-strips').textContent).toBe('3, 3');
  });

  it('shows the sync pill states', () => {
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-sync-pill').textContent).toContain('saved');
    act(() => {
      gameConfigSlice().sync.set('external');
      gameConfigSlice().externalSource.set('tuner');
    });
    expect(screen.getByTestId('gc-sync-pill').textContent).toContain('updated externally · tuner');
  });

  it('switches tabs and shows a warning dot for tabs with issues', () => {
    // paytable references symbol 0 twice → duplicate warning
    act(() => {
      gameConfigSlice().model.set({
        ...MODEL,
        paytable: {
          entries: [
            { symbol: 0, count: 2, payout: 5 },
            { symbol: 0, count: 2, payout: 3 },
          ],
        },
      });
    });
    render(<GameConfigPane {...({} as never)} />);
    expect(screen.getByTestId('gc-tab-dot-paytable')).toBeTruthy();
    expect(screen.getByTestId('gc-issues-pill').textContent).toContain('1 issue');
    fireEvent.click(screen.getByTestId('gc-tab-paytable'));
    expect(screen.getByTestId('gc-section-paytable')).toBeTruthy();
  });
});

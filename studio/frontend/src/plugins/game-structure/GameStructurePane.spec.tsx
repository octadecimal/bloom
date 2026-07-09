import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { GameStructurePane } from './GameStructurePane';
import { gameStructureSlice, makeInitialState } from './state';
import { emptyDefinition } from './model';

function seed() {
  const s = gameStructureSlice();
  s.set(makeInitialState());
  s.activeGameId.set('g1');
  s.definition.set({
    ...emptyDefinition(),
    mechanics: [{ id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } }],
  });
}

describe('GameStructurePane', () => {
  beforeEach(() => gameStructureSlice().set(makeInitialState()));

  it('shows the empty state without a game', () => {
    render(<GameStructurePane {...({} as never)} />);
    expect(screen.getByTestId('gs-no-game')).toBeInTheDocument();
  });

  it('renders tabs and switches sections', () => {
    seed();
    render(<GameStructurePane {...({} as never)} />);
    expect(screen.getByTestId('gs-tab-mechanics')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('gs-tab-transitions'));
    expect(gameStructureSlice().activeTab.get()).toBe('transitions');
  });

  it('surfaces validation errors in the pill', () => {
    seed();
    gameStructureSlice().validation.set({ status: 'errors', errors: ['UnknownState { referenced: "x" }'] });
    render(<GameStructurePane {...({} as never)} />);
    expect(screen.getByTestId('gs-validation-pill').textContent).toContain('1');
    expect(screen.getByTestId('gs-validation-errors').textContent).toContain('UnknownState');
  });
});

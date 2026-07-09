import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./restClient', () => ({
  getGameDefinition: vi.fn(),
  putGameDefinition: vi.fn(),
  validateGameDefinition: vi.fn(),
  buildGameDefinition: vi.fn(),
}));
vi.mock('./socketClient', () => ({
  setDefinitionChangedHandler: vi.fn(),
  gameStructureSock: () => ({ connect: vi.fn(), disconnect: vi.fn(), join: vi.fn(), leave: vi.fn() }),
}));

import * as rest from './restClient';
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

  it('build button stores metrics and enables play', async () => {
    seed();
    (rest.buildGameDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      errors: null,
      metrics: { rtp: 0.9, hitRate: 0.31, maxWinX: 60, stateVisits: { base: 100, fs1: 4 } },
      packageId: 'g1',
    });
    render(<GameStructurePane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('gs-build'));
    await screen.findByTestId('gs-metrics');
    expect(screen.getByTestId('gs-metric-rtp').textContent).toContain('0.9');
    const play = screen.getByTestId('gs-play') as HTMLAnchorElement;
    expect(play.href).toContain('?package=g1');
  });
});

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
      verdict: null,
      packageId: 'g1',
    });
    render(<GameStructurePane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('gs-build'));
    const play = await screen.findByTestId('gs-play');
    expect((play as HTMLAnchorElement).href).toContain('?package=g1');
  });

  it('build success renders the verify verdict, not raw candidate metrics', async () => {
    seed();
    (rest.buildGameDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      errors: [],
      metrics: { rtp: 0.9, hitRate: 0.31, maxWinX: 60, stateVisits: { base: 100, fs1: 4 } },
      verdict: { status: 'pass', failure: null, realizedRtp: 0.9612, poolSize: 10000, rtpTarget: 0.96, rtpTolerance: 0.01, selfDerived: true },
      packageId: 'g1',
    });
    render(<GameStructurePane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('gs-build'));
    expect(await screen.findByTestId('gs-verdict')).toHaveTextContent('PASS');
    expect(screen.getByTestId('gs-verdict-rtp')).toHaveTextContent('0.961');
    expect(screen.getByTestId('gs-verdict-self-derived')).toHaveTextContent('self-derived');
    expect(screen.queryByTestId('gs-metrics')).toBeNull();
  });

  it('a fail verdict shows the failure reason', async () => {
    seed();
    (rest.buildGameDefinition as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      errors: ['rtp out of band'],
      metrics: null,
      verdict: {
        status: 'fail',
        failure: 'rtp 0.91 outside 0.96±0.01',
        realizedRtp: 0.91,
        poolSize: 10000,
        rtpTarget: 0.96,
        rtpTolerance: 0.01,
        selfDerived: false,
      },
      packageId: 'g1',
    });
    render(<GameStructurePane {...({} as never)} />);
    fireEvent.click(screen.getByTestId('gs-build'));
    expect(await screen.findByTestId('gs-verdict')).toHaveTextContent('FAIL');
    expect(screen.getByTestId('gs-verdict-failure')).toHaveTextContent('rtp 0.91 outside 0.96±0.01');
  });
});

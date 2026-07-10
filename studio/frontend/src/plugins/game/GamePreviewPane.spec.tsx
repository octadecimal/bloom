import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { GamePreviewPane } from './GamePreviewPane';

vi.mock('./actions', () => ({ openGame: vi.fn(), closeGame: vi.fn(), initGame: vi.fn() }));
vi.mock('./socketClient', () => ({
  gameSock: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), joinScene: vi.fn(), leaveScene: vi.fn() })),
  emitSceneCaptureResult: vi.fn(),
  emitSceneSpin: vi.fn(),
}));

const fakeProps = {} as Parameters<typeof GamePreviewPane>[0];

function renderPane() {
  act(() => gameSlice().activeGameId.set('g1'));
  render(<GamePreviewPane {...fakeProps} />);
}

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
});

describe('GamePreviewPane', () => {
  it('shows an empty state when no game is active', () => {
    render(<GamePreviewPane {...fakeProps} />);
    expect(screen.getByTestId('game-no-game')).toBeTruthy();
  });

  it('renders the engine iframe with a host-derived, origin-pinned src', () => {
    act(() => gameSlice().activeGameId.set('g1'));
    render(<GamePreviewPane {...fakeProps} />);
    const frame = screen.getByTestId('game-engine-frame') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toContain(`:4300/?parentOrigin=`);
    expect(frame.getAttribute('src')).toContain(encodeURIComponent(window.location.origin));
    expect(frame.getAttribute('src')).toContain('mediaBase=');
    expect(frame.getAttribute('src')).toContain(encodeURIComponent(`http://localhost:8000`));
  });

  it('has no Add Reels button — mechanics come from Game Structure', () => {
    renderPane();
    expect(screen.queryByTestId('game-add-reels')).toBeNull();
    expect(screen.getByTestId('game-spin')).toBeInTheDocument();
  });

  it('renders the spin error bar when spinError is set, and spinning clears it', () => {
    renderPane();
    act(() => gameSlice().spinError.set('runtime server unreachable'));
    expect(screen.getByTestId('game-spin-error')).toHaveTextContent('runtime server unreachable');
    fireEvent.click(screen.getByTestId('game-spin'));
    expect(screen.queryByTestId('game-spin-error')).toBeNull();
  });
});

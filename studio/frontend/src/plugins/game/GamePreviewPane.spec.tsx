import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { GamePreviewPane } from './GamePreviewPane';

vi.mock('./actions', () => ({ openGame: vi.fn(), closeGame: vi.fn(), initGame: vi.fn() }));

const fakeProps = {} as Parameters<typeof GamePreviewPane>[0];

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
});

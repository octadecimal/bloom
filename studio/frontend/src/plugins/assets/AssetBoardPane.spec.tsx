// studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
// The board is bound to the workspace's active game (set by the route). It no
// longer offers any game selection/creation UI.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { loadPrefs } from './prefs';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState } from './state';
import { AssetBoardPane } from './AssetBoardPane';

vi.mock('./actions', () => ({
  createAsset: vi.fn(),
}));

const fakeProps = {} as Parameters<typeof AssetBoardPane>[0];

beforeEach(() => {
  localStorage.clear();
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  window.__renderCounts = {};
});

describe('AssetBoardPane', () => {
  it('renders no game-management UI', () => {
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.queryByTestId('game-select')).toBeNull();
    expect(screen.queryByTestId('new-game')).toBeNull();
    expect(screen.queryByTestId('refresh-games')).toBeNull();
    expect(screen.queryByTestId('games-empty')).toBeNull();
  });

  it('renders the new-asset form and empty hint for the active game with no assets', () => {
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.getByTestId('new-asset-form')).toBeTruthy();
    expect(screen.getByTestId('assets-empty')).toBeTruthy();
  });

  it('renders the board-no-game fallback when no game is active', () => {
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.getByTestId('board-no-game')).toBeTruthy();
    expect(screen.queryByTestId('new-asset-form')).toBeNull();
  });

  it('renders the four view-mode toggles', () => {
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.getByTestId('view-mode-small')).toBeTruthy();
    expect(screen.getByTestId('view-mode-medium')).toBeTruthy();
    expect(screen.getByTestId('view-mode-large')).toBeTruthy();
    expect(screen.getByTestId('view-mode-list')).toBeTruthy();
  });

  it('defaults the grid to medium and persists a new choice on click', () => {
    localStorage.clear();
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.getByTestId('asset-grid').getAttribute('data-view-mode')).toBe('medium');
    fireEvent.click(screen.getByTestId('view-mode-list'));
    expect(screen.getByTestId('asset-grid').getAttribute('data-view-mode')).toBe('list');
    expect(loadPrefs()).toEqual({ viewMode: 'list' });
  });

  it('seeds the active mode from persisted prefs on mount', () => {
    localStorage.setItem('bloom.studio.assets.prefs', JSON.stringify({ version: 1, data: { viewMode: 'small' } }));
    act(() => {
      assetsSlice().activeGameId.set('g1');
    });
    render(<AssetBoardPane {...fakeProps} />);
    expect(screen.getByTestId('asset-grid').getAttribute('data-view-mode')).toBe('small');
  });
});

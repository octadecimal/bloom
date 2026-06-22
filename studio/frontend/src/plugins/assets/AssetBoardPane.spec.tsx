// studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
// The board is bound to the workspace's active game (set by the route). It no
// longer offers any game selection/creation UI.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState } from './state';
import { AssetBoardPane } from './AssetBoardPane';

vi.mock('./actions', () => ({
  createAsset: vi.fn(),
}));

const fakeProps = {} as Parameters<typeof AssetBoardPane>[0];

beforeEach(() => {
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
});

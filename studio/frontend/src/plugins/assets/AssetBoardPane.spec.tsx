// studio/frontend/src/plugins/assets/AssetBoardPane.spec.tsx
// Regression test: after games.set([...]), the game-select dropdown must
// show the new options. This isolated the hookstate subscription behaviour
// of AssetBoardPane independently of the network layer.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState } from './state';
import { AssetBoardPane } from './AssetBoardPane';

// Suppress network / socket side-effects — we drive state directly.
vi.mock('./actions', () => ({
  loadGames: vi.fn(),
  openGame: vi.fn(),
  createAsset: vi.fn(),
  initAssets: vi.fn(),
}));

// AssetBoardPane receives IDockviewPanelProps but only renders; cast is fine for tests.
const fakeProps = {} as Parameters<typeof AssetBoardPane>[0];

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  window.__renderCounts = {};
});

describe('AssetBoardPane game-select', () => {
  it('shows game options after games.set() — re-renders on games change', async () => {
    render(<AssetBoardPane {...fakeProps} />);

    // Initially the dropdown has only the disabled placeholder.
    expect(screen.queryByRole('option', { name: 'Slots' })).toBeNull();

    // Simulate what loadGames() does after a successful fetch.
    await act(async () => {
      assetsSlice().games.set([{ id: 'g1', name: 'Slots', createdAt: '' }]);
    });

    // The dropdown must now contain an option for the game.
    expect(screen.getByRole('option', { name: 'Slots' })).toBeTruthy();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameInitialState } from '../game/state';
import * as rest from './restClient';
import { RegionOverridePane } from './RegionOverridePane';

const view = {
  canvas: [1280, 720] as [number, number],
  plan: { reels: { x: 640, y: 396, region_w: 794, region_h: 432, anchor_x: 0.5, anchor_y: 0.5 } },
  overrides: {},
};

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameInitialState() as never);
  vi.spyOn(rest, 'getOverrides').mockResolvedValue(view);
  vi.spyOn(rest, 'putOverride').mockResolvedValue({ rebuilt: true });
});
afterEach(() => vi.restoreAllMocks());

describe('RegionOverridePane', () => {
  it('edits a role region and PUTs the override on save', async () => {
    act(() => {
      gameSlice().activeGameId.set('g1');
    });
    await act(async () => {
      render(<RegionOverridePane {...({} as never)} />);
    });
    const x = (await screen.findByTestId('region-reels-x')) as HTMLInputElement;
    act(() => fireEvent.change(x, { target: { value: '700' } }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('region-reels-save'));
    });
    expect(rest.putOverride).toHaveBeenCalledWith('g1', 'reels', expect.objectContaining({ x: 700 }));
  });

  it('shows empty state when no game is active', async () => {
    await act(async () => {
      render(<RegionOverridePane {...({} as never)} />);
    });
    expect(screen.getByText(/open a game/i)).toBeTruthy();
  });
});

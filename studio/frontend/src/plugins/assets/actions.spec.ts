// studio/frontend/src/plugins/assets/actions.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState, type IAsset, type IGame } from './state';
import * as actions from './actions';

const asset: IAsset = {
  id: 'a1',
  gameId: 'g1',
  name: 'W',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-opaque',
  seed: null,
  status: 'idle',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: null,
};

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
});

describe('assets actions', () => {
  it('openGame loads assets, sets active, and joins the game', async () => {
    const joinGame = vi.fn();
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([asset]),
        createGame: vi.fn(),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame, leaveGame: vi.fn(), generateAsset: vi.fn() },
    });
    await actions.openGame('g1');
    expect(assetsSlice().activeGameId.get()).toBe('g1');
    expect(assetsSlice().assets.get({ noproxy: true })).toHaveLength(1);
    expect(joinGame).toHaveBeenCalledWith('g1');
  });

  it('generateAsset emits via the socket for the asset', async () => {
    const generateAsset = vi.fn();
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([asset]),
        createGame: vi.fn(),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame: vi.fn(), generateAsset },
    });
    await actions.openGame('g1');
    actions.generateAsset('a1');
    expect(generateAsset).toHaveBeenCalledWith('g1', 'a1');
  });

  it('createAsset appends the new asset to the slice', async () => {
    const created = { ...asset, id: 'a2' };
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([]),
        createGame: vi.fn(),
        createAsset: vi.fn().mockResolvedValue(created),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame: vi.fn(), generateAsset: vi.fn() },
    });
    await actions.openGame('g1');
    await actions.createAsset({ name: 'W', prompt: 'p', width: 64, height: 64, workflow: 'schnell-opaque' });
    expect(
      assetsSlice()
        .assets.get({ noproxy: true })
        .map((a) => a.id),
    ).toContain('a2');
  });

  it('createGame creates, appends to games, and selects it', async () => {
    const created = { id: 'g2', name: 'New', createdAt: 't' };
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([]),
        createGame: vi.fn().mockResolvedValue(created),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame: vi.fn(), generateAsset: vi.fn() },
    });
    await actions.createGame('New');
    expect(
      assetsSlice()
        .games.get({ noproxy: true })
        .map((g) => g.id),
    ).toContain('g2');
    expect(assetsSlice().activeGameId.get()).toBe('g2');
  });

  it('closeGame leaves the active game and clears assets', async () => {
    const leaveGame = vi.fn();
    actions.__setDeps({
      rest: {
        getGames: vi.fn(),
        getAssets: vi.fn().mockResolvedValue([asset]),
        createGame: vi.fn(),
        createAsset: vi.fn(),
        updateAsset: vi.fn(),
        deleteAsset: vi.fn(),
        selectGeneration: vi.fn(),
      },
      socket: { connect: vi.fn(), disconnect: vi.fn(), joinGame: vi.fn(), leaveGame, generateAsset: vi.fn() },
    });
    await actions.openGame('g1');
    expect(assetsSlice().activeGameId.get()).toBe('g1');

    actions.closeGame();

    expect(leaveGame).toHaveBeenCalledWith('g1');
    expect(assetsSlice().activeGameId.get()).toBeNull();
    expect(assetsSlice().assets.get({ noproxy: true })).toHaveLength(0);
    expect(assetsSlice().assetsStatus.get()).toBe('idle');
  });
});

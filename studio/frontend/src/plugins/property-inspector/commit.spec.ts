import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState as makeGameState } from '../game/state';
import * as socketClient from '../game/socketClient';
import { commitSetProp } from './commit';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeGameState() as never);
  vi.restoreAllMocks();
});

describe('commitSetProp', () => {
  it('emits a setProp scene_apply_op for the active game', () => {
    const spy = vi.spyOn(socketClient, 'emitSceneApplyOp').mockImplementation(() => {});
    gameSlice().activeGameId.set('g7');

    commitSetProp('s1', 'position.x', 42);

    expect(spy).toHaveBeenCalledWith('g7', { kind: 'setProp', id: 's1', path: 'position.x', value: 42 });
  });

  it('is a no-op when there is no active game', () => {
    const spy = vi.spyOn(socketClient, 'emitSceneApplyOp').mockImplementation(() => {});
    gameSlice().activeGameId.set(null);

    commitSetProp('s1', 'x', 1);

    expect(spy).not.toHaveBeenCalled();
  });
});

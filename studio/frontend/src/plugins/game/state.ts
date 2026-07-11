import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const GAME_PLUGIN_ID = 'game';

export interface IGameState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  status: 'idle' | 'loading' | 'error';
  spinError: string | null;
}

export function makeInitialState(): IGameState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    status: 'idle',
    spinError: null,
  };
}

export const gameHooks = makePluginHooks<IGameState>(GAME_PLUGIN_ID);

export function gameSlice(): State<IGameState> {
  return rootStore.plugins.nested(GAME_PLUGIN_ID) as unknown as State<IGameState>;
}

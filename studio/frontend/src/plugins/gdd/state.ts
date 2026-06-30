import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const GDD_PLUGIN_ID = 'gdd';

export type GddStatus = 'empty' | 'drafted' | 'needs_input' | 'complete';

export interface IGddDoc {
  id: string;
  gameId: string;
  aspect: string;
  title: string;
  order: number;
  body: string;
  status: GddStatus;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface IGddState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  docs: IGddDoc[];
  docsStatus: 'idle' | 'loading' | 'error';
  selectedAspect: string | null;
}

export function makeInitialState(): IGddState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    docs: [],
    docsStatus: 'idle',
    selectedAspect: null,
  };
}

export const gddHooks = makePluginHooks<IGddState>(GDD_PLUGIN_ID);

export function gddSlice(): State<IGddState> {
  return rootStore.plugins.nested(GDD_PLUGIN_ID) as unknown as State<IGddState>;
}

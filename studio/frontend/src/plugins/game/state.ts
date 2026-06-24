import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const GAME_PLUGIN_ID = 'game';

// Structural copy of the engine wire shapes (runtime/client/src/model/document.ts).
// The protocol fixes these; keep them in lockstep with the engine.
export type NodeType = 'Root' | 'Container' | 'Sprite' | 'Texture';
export type EdgeType = 'child' | 'data';
export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };
export interface IPortRef {
  node: string;
  port: string;
}
export interface INode {
  id: string;
  type: NodeType;
  props: Record<string, JsonValue>;
}
export interface IEdge {
  id: string;
  type: EdgeType;
  from: IPortRef;
  to: IPortRef;
}
export interface IGameDocument {
  version: number;
  nodes: Record<string, INode>;
  edges: IEdge[];
}

export interface IGameState {
  connection: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  activeGameId: string | null;
  document: IGameDocument;
  status: 'idle' | 'loading' | 'error';
}

export function emptyDocument(): IGameDocument {
  return { version: 1, nodes: {}, edges: [] };
}

export function makeInitialState(): IGameState {
  return {
    connection: 'disconnected',
    activeGameId: null,
    document: emptyDocument(),
    status: 'idle',
  };
}

export const gameHooks = makePluginHooks<IGameState>(GAME_PLUGIN_ID);

export function gameSlice(): State<IGameState> {
  return rootStore.plugins.nested(GAME_PLUGIN_ID) as unknown as State<IGameState>;
}

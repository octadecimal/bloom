import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const LLM_CHAT_PLUGIN_ID = 'llm-chat';

export interface IRoom {
  id: string;
  name: string;
  model: string;
  gameId: string | null;
  createdAt: string;
}

export interface IMessage {
  id: string;
  roomId: string;
  author: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'streaming' | 'complete';
  createdAt: string;
}

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export interface IAiStatus {
  state: 'idle' | 'generating' | 'queued';
  queueDepth: number;
}

export interface ILlmChatState {
  // durable prefs (persisted separately via prefs.ts, NOT via persist:true)
  displayName: string;
  activeRoomId: string | null;

  connection: ConnState;

  rooms: IRoom[];
  roomsStatus: 'idle' | 'loading' | 'error';

  // the ACTIVE room's live view; socket handlers guard on roomId === activeRoomId
  messages: IMessage[];
  members: string[];
  typing: string[];
  aiStatus: IAiStatus;
  roomLoadStatus: 'idle' | 'loading' | 'error';
}

export function makeInitialState(displayName: string, activeRoomId: string | null): ILlmChatState {
  return {
    displayName,
    activeRoomId,
    connection: 'connecting',
    rooms: [],
    roomsStatus: 'idle',
    messages: [],
    members: [],
    typing: [],
    aiStatus: { state: 'idle', queueDepth: 0 },
    roomLoadStatus: 'idle',
  };
}

export const llmChatHooks = makePluginHooks<ILlmChatState>(LLM_CHAT_PLUGIN_ID);

// Accessor for non-React modules (actions, socketClient). Mirrors the cast used
// by demo-counter's command. The single contained type seam.
export function chatSlice(): State<ILlmChatState> {
  return rootStore.plugins.nested(LLM_CHAT_PLUGIN_ID) as unknown as State<ILlmChatState>;
}

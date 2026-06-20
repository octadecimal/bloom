import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';

const rest = {
  getRooms: vi.fn(),
  createRoom: vi.fn(),
  getMessages: vi.fn(),
};
const socket = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  reconnectWith: vi.fn(),
  joinRoom: vi.fn(),
  leaveRoom: vi.fn(),
  sendPrompt: vi.fn(),
  setTyping: vi.fn(),
};
const savePrefs = vi.fn();

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
  Object.values(rest).forEach((f) => f.mockReset());
  Object.values(socket).forEach((f) => f.mockReset());
  savePrefs.mockReset();
  actions.__setDeps({ rest, socket, savePrefs });
});

describe('actions', () => {
  it('loadRooms populates rooms and sets status idle', async () => {
    rest.getRooms.mockResolvedValue([{ id: 'r1', name: 'A', model: 'm', gameId: null, createdAt: 't' }]);
    await actions.loadRooms();
    expect(chatSlice().rooms.get()).toHaveLength(1);
    expect(chatSlice().roomsStatus.get()).toBe('idle');
  });

  it('loadRooms sets status error on failure', async () => {
    rest.getRooms.mockRejectedValue(new Error('down'));
    await actions.loadRooms();
    expect(chatSlice().roomsStatus.get()).toBe('error');
  });

  it('openRoom leaves previous, clears, fetches history, joins, and persists', async () => {
    chatSlice().activeRoomId.set('old');
    rest.getMessages.mockResolvedValue([{ id: 'm1', roomId: 'r1', author: 'a', role: 'user', content: 'h', status: 'complete', createdAt: 't' }]);
    await actions.openRoom('r1');
    expect(socket.leaveRoom).toHaveBeenCalledWith('old');
    expect(chatSlice().activeRoomId.get()).toBe('r1');
    expect(chatSlice().messages.get()).toHaveLength(1);
    expect(socket.joinRoom).toHaveBeenCalledWith('r1');
    expect(savePrefs).toHaveBeenCalledWith({ displayName: 'guest-0001', activeRoomId: 'r1' });
  });

  it('openRoom is a no-op when the room is already active', async () => {
    chatSlice().activeRoomId.set('r1');
    await actions.openRoom('r1');
    expect(socket.joinRoom).not.toHaveBeenCalled();
  });

  it('createRoom posts then opens the new room', async () => {
    rest.createRoom.mockResolvedValue({ id: 'r9', name: 'New', model: 'm', gameId: null, createdAt: 't' });
    rest.getMessages.mockResolvedValue([]);
    await actions.createRoom('New');
    expect(rest.createRoom).toHaveBeenCalledWith('New', undefined);
    expect(chatSlice().activeRoomId.get()).toBe('r9');
  });

  it('sendPrompt/setTyping forward to the socket for the active room', () => {
    chatSlice().activeRoomId.set('r1');
    actions.sendPrompt('hello');
    actions.setTyping(true);
    expect(socket.sendPrompt).toHaveBeenCalledWith('r1', 'hello');
    expect(socket.setTyping).toHaveBeenCalledWith('r1', true);
  });

  it('setDisplayName updates slice, persists, and reconnects', () => {
    actions.setDisplayName('alice');
    expect(chatSlice().displayName.get()).toBe('alice');
    expect(savePrefs).toHaveBeenCalledWith({ displayName: 'alice', activeRoomId: null });
    expect(socket.reconnectWith).toHaveBeenCalledWith('alice');
  });
});

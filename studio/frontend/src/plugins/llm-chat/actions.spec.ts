import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';
import { connectChatAs, disconnectChat, initChat, __setDeps } from './actions';

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
    expect(savePrefs).toHaveBeenCalledWith({ activeRoomId: 'r1' });
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

  describe('closeRoom', () => {
    it('leaves the active room, clears state, and persists', () => {
      chatSlice().activeRoomId.set('r1');
      chatSlice().messages.set([{ id: 'm1', roomId: 'r1', author: 'a', role: 'user', content: 'hi', status: 'complete', createdAt: 't' }] as never);
      chatSlice().members.set([{ id: 'u1', displayName: 'alice' }] as never);
      chatSlice().typing.set(['alice']);
      actions.closeRoom();
      expect(socket.leaveRoom).toHaveBeenCalledWith('r1');
      expect(chatSlice().activeRoomId.get()).toBeNull();
      expect(chatSlice().messages.get()).toHaveLength(0);
      expect(chatSlice().members.get()).toHaveLength(0);
      expect(chatSlice().typing.get()).toHaveLength(0);
      expect(savePrefs).toHaveBeenCalled();
    });

    it('does NOT call socket.leaveRoom when activeRoomId is already null', () => {
      expect(chatSlice().activeRoomId.get()).toBeNull();
      actions.closeRoom();
      expect(socket.leaveRoom).not.toHaveBeenCalled();
    });
  });

  describe('session-driven connection', () => {
    it('connectChatAs sets displayName and connects', () => {
      const socket = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        reconnectWith: vi.fn(),
        joinRoom: vi.fn(),
        leaveRoom: vi.fn(),
        sendPrompt: vi.fn(),
        setTyping: vi.fn(),
      };
      __setDeps({ socket });
      connectChatAs('ada');
      expect(chatSlice().displayName.get()).toBe('ada');
      expect(socket.connect).toHaveBeenCalledWith('ada');
    });
    it('connectChatAs reconnects when already connected once', () => {
      const socket = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        reconnectWith: vi.fn(),
        joinRoom: vi.fn(),
        leaveRoom: vi.fn(),
        sendPrompt: vi.fn(),
        setTyping: vi.fn(),
      };
      __setDeps({ socket });
      connectChatAs('ada');
      connectChatAs('bob');
      expect(socket.reconnectWith).toHaveBeenLastCalledWith('bob');
    });
    it('initChat loads rooms but does not connect or auto-open', () => {
      const socket = {
        connect: vi.fn(),
        disconnect: vi.fn(),
        reconnectWith: vi.fn(),
        joinRoom: vi.fn(),
        leaveRoom: vi.fn(),
        sendPrompt: vi.fn(),
        setTyping: vi.fn(),
      };
      const rest = { getRooms: vi.fn().mockResolvedValue([]), createRoom: vi.fn(), getMessages: vi.fn() };
      __setDeps({ socket, rest });
      initChat();
      expect(socket.connect).not.toHaveBeenCalled();
    });
  });

  it('openRoom guards against room-switch race: superseded fetch does not overwrite newer room history', async () => {
    // Arrange: two deferred promises for room A and room B history
    let resolveA!: (msgs: unknown[]) => void;
    let resolveB!: (msgs: unknown[]) => void;
    const historyA = [{ id: 'mA', roomId: 'A', author: 'a', role: 'user', content: 'from A', status: 'complete', createdAt: 't' }];
    const historyB = [{ id: 'mB', roomId: 'B', author: 'b', role: 'user', content: 'from B', status: 'complete', createdAt: 't' }];
    const promiseA = new Promise<unknown[]>((res) => {
      resolveA = res;
    });
    const promiseB = new Promise<unknown[]>((res) => {
      resolveB = res;
    });

    rest.getMessages.mockImplementation((id: string) => (id === 'A' ? promiseA : promiseB));

    // Start openRoom('A') — history fetch is pending
    const openA = actions.openRoom('A');

    // Open room B (switches activeRoomId to B) and immediately resolve B's history
    resolveB(historyB);
    await actions.openRoom('B');

    // Now resolve A's (stale) history — should be ignored
    resolveA(historyA);
    await openA;

    // Assert: B's history wins; activeRoomId is B
    expect(chatSlice().activeRoomId.get()).toBe('B');
    expect(chatSlice().messages.get()).toEqual(historyB);
    expect(socket.joinRoom).toHaveBeenLastCalledWith('B');
  });
});

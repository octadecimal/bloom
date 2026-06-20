import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import { createSocketClient, type ISocketLike } from './socketClient';

// Minimal fake socket: records handlers + emits, drives connected flag.
function makeFakeSocket() {
  const handlers: Record<string, (p: unknown) => void> = {};
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const sock: ISocketLike & { fire(e: string, p?: unknown): void } = {
    auth: {},
    connected: false,
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
    },
    emit: (event: string, payload?: unknown) => {
      emitted.push({ event, payload });
    },
    connect: () => {
      sock.connected = true;
    },
    disconnect: () => {
      sock.connected = false;
    },
    fire: (e: string, p?: unknown) => handlers[e]?.(p),
  };
  return { sock, emitted };
}

function seed() {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
}

describe('socketClient outbound', () => {
  beforeEach(seed);

  it('connect() builds a socket with displayName auth', () => {
    const { sock } = makeFakeSocket();
    const make = vi.fn().mockReturnValue(sock);
    const client = createSocketClient(make);
    client.connect('alice');
    expect(make).toHaveBeenCalledWith(expect.any(String), { displayName: 'alice' });
  });

  it('connect event sets connection=connected', () => {
    const { sock } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    sock.fire('connect');
    expect(chatSlice().connection.get()).toBe('connected');
  });

  it('disconnect event sets connection=reconnecting', () => {
    const { sock } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    sock.fire('disconnect');
    expect(chatSlice().connection.get()).toBe('reconnecting');
  });

  it('on (re)connect, re-joins the active room', () => {
    const { sock, emitted } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    chatSlice().activeRoomId.set('r1');
    client.connect('alice');
    sock.fire('connect');
    expect(emitted).toContainEqual({ event: 'join_room', payload: { roomId: 'r1' } });
  });

  it('joinRoom/leaveRoom/sendPrompt/setTyping emit the right events', () => {
    const { sock, emitted } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    client.joinRoom('r1');
    client.leaveRoom('r1');
    client.sendPrompt('r1', 'hi');
    client.setTyping('r1', true);
    expect(emitted).toContainEqual({ event: 'join_room', payload: { roomId: 'r1' } });
    expect(emitted).toContainEqual({ event: 'leave_room', payload: { roomId: 'r1' } });
    expect(emitted).toContainEqual({ event: 'send_prompt', payload: { roomId: 'r1', text: 'hi' } });
    expect(emitted).toContainEqual({ event: 'typing', payload: { roomId: 'r1', isTyping: true } });
  });

  it('reconnectWith disconnects and reconnects with the new name', () => {
    const { sock } = makeFakeSocket();
    const make = vi.fn().mockReturnValue(sock);
    const client = createSocketClient(make);
    client.connect('alice');
    client.reconnectWith('bob');
    expect(make).toHaveBeenLastCalledWith(expect.any(String), { displayName: 'bob' });
  });
});

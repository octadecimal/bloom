import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, chatSlice, LLM_CHAT_PLUGIN_ID } from './state';
import { createSocketClient, type ISocketLike } from './socketClient';

const notifyError = vi.fn();
vi.mock('../../lib/notify', () => ({ notify: { error: (m: string) => notifyError(m), info: vi.fn() } }));

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

describe('socketClient inbound', () => {
  beforeEach(() => {
    rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
    notifyError.mockClear();
    chatSlice().activeRoomId.set('r1');
  });

  function connected() {
    const { sock, emitted } = makeFakeSocket();
    const client = createSocketClient(() => sock);
    client.connect('alice');
    sock.fire('connect');
    return { sock, emitted, client };
  }

  const message = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    roomId: 'r1',
    author: 'assistant',
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: 't',
    ...over,
  });

  it('message_created upserts into messages', () => {
    const { sock } = connected();
    sock.fire('message_created', { message: message({ id: 'u1', role: 'user', content: 'hi', status: 'complete' }) });
    expect(chatSlice().messages.get()).toHaveLength(1);
  });

  it('token appends to the streaming message', () => {
    const { sock } = connected();
    sock.fire('message_created', { message: message({ id: 'a1' }) });
    sock.fire('token', { roomId: 'r1', messageId: 'a1', delta: 'Hel' });
    sock.fire('token', { roomId: 'r1', messageId: 'a1', delta: 'lo' });
    expect(chatSlice().messages.get()[0].content).toBe('Hello');
  });

  it('ignores events for a non-active room', () => {
    const { sock } = connected();
    sock.fire('token', { roomId: 'OTHER', messageId: 'x', delta: 'nope' });
    expect(chatSlice().messages.get()).toHaveLength(0);
  });

  it('stream_snapshot sets accumulated content (join mid-stream)', () => {
    const { sock } = connected();
    sock.fire('stream_snapshot', { roomId: 'r1', messageId: 'a1', content: 'caught up', state: 'generating' });
    expect(chatSlice().messages.get()[0].content).toBe('caught up');
  });

  it('message_completed flips status to complete', () => {
    const { sock } = connected();
    sock.fire('message_created', { message: message({ id: 'a1' }) });
    sock.fire('message_completed', { roomId: 'r1', messageId: 'a1' });
    expect(chatSlice().messages.get()[0].status).toBe('complete');
  });

  it('presence/typing/ai_status update the slice', () => {
    const { sock } = connected();
    sock.fire('presence', { roomId: 'r1', members: ['alice', 'bob'] });
    sock.fire('typing', { roomId: 'r1', author: 'bob', isTyping: true });
    sock.fire('ai_status', { roomId: 'r1', state: 'generating', queueDepth: 2 });
    expect(chatSlice().members.get()).toEqual(['alice', 'bob']);
    expect(chatSlice().typing.get()).toEqual(['bob']);
    expect(chatSlice().aiStatus.get()).toEqual({ state: 'generating', queueDepth: 2 });
    sock.fire('typing', { roomId: 'r1', author: 'bob', isTyping: false });
    expect(chatSlice().typing.get()).toEqual([]);
  });

  it('error event raises a toast', () => {
    const { sock } = connected();
    sock.fire('error', { roomId: 'r1', message: 'generation failed' });
    expect(notifyError).toHaveBeenCalledWith('generation failed');
  });

  it('sets lastError on socket error and clears it on the next message_created', () => {
    const { sock } = connected();
    const ACTIVE = 'r1';
    sock.fire('error', { roomId: ACTIVE, message: 'generation failed' });
    expect(chatSlice().lastError.get()).toBe('generation failed');

    sock.fire('message_created', { message: message({ roomId: ACTIVE }) });
    expect(chatSlice().lastError.get()).toBeNull();
  });
});

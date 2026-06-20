import { io } from 'socket.io-client';
import { BACKEND_URL } from './config';
import { chatSlice } from './state';

export interface ISocketLike {
  auth: Record<string, unknown>;
  readonly connected: boolean;
  on(event: string, cb: (payload: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
  connect(): void;
  disconnect(): void;
}

type MakeSocket = (url: string, auth: { displayName: string }) => ISocketLike;

export function createSocketClient(makeSocket: MakeSocket) {
  let sock: ISocketLike | null = null;

  function wire(s: ISocketLike): void {
    s.on('connect', () => {
      chatSlice().connection.set('connected');
      const active = chatSlice().activeRoomId.get();
      if (active) s.emit('join_room', { roomId: active });
    });
    s.on('disconnect', () => {
      chatSlice().connection.set('reconnecting');
    });
    // Inbound domain events are wired in Task 7's registerInboundHandlers().
  }

  function connect(displayName: string): void {
    chatSlice().connection.set('connecting');
    sock = makeSocket(BACKEND_URL, { displayName });
    wire(sock);
  }

  function disconnect(): void {
    sock?.disconnect();
    chatSlice().connection.set('disconnected');
  }

  function reconnectWith(displayName: string): void {
    sock?.disconnect();
    connect(displayName);
  }

  const emit = (event: string, payload: unknown) => sock?.emit(event, payload);

  return {
    connect,
    disconnect,
    reconnectWith,
    getSocket: () => sock,
    joinRoom: (roomId: string) => emit('join_room', { roomId }),
    leaveRoom: (roomId: string) => emit('leave_room', { roomId }),
    sendPrompt: (roomId: string, text: string) => emit('send_prompt', { roomId, text }),
    setTyping: (roomId: string, isTyping: boolean) => emit('typing', { roomId, isTyping }),
  };
}

export type SocketClient = ReturnType<typeof createSocketClient>;

// Module singleton over the real socket.io-client.
let singleton: SocketClient | null = null;

export function initSocketClient(): SocketClient {
  singleton = createSocketClient((url, auth) => io(url, { auth, autoConnect: true }) as unknown as ISocketLike);
  return singleton;
}

export function getSocketClient(): SocketClient {
  if (!singleton) throw new Error('socket client not initialised');
  return singleton;
}

import { io } from 'socket.io-client';
import { BACKEND_URL } from './config';
import type { IMessage, IAiStatus, IRun, IRunStep } from './state';
import { chatSlice } from './state';
import { upsertMessage, appendToken, applySnapshot, completeMessage, addTyping, removeTyping, startRun, startStep, appendStepToken, completeStep, completeRun, applyRunSnapshot } from './reducers';
import { notify } from '../../lib/notify';

export interface ISocketLike {
  auth: Record<string, unknown>;
  readonly connected: boolean;
  on(event: string, cb: (payload: unknown) => void): void;
  emit(event: string, payload?: unknown): void;
  connect(): void;
  disconnect(): void;
}

type MakeSocket = (url: string, auth: { displayName: string }) => ISocketLike;

function registerInboundHandlers(s: ISocketLike): void {
  const slice = chatSlice;
  const isActive = (roomId: string) => slice().activeRoomId.get() === roomId;
  const read = () => slice().messages.get({ noproxy: true }) as IMessage[];
  const readRuns = () => slice().runs.get({ noproxy: true }) as IRun[];

  s.on('message_created', (p) => {
    const { message } = p as { message: IMessage };
    if (!isActive(message.roomId)) return;
    slice().lastError.set(null);
    slice().messages.set(upsertMessage(read(), message));
  });
  s.on('token', (p) => {
    const { roomId, messageId, delta } = p as { roomId: string; messageId: string; delta: string };
    if (!isActive(roomId)) return;
    slice().messages.set(appendToken(read(), roomId, messageId, delta));
  });
  s.on('stream_snapshot', (p) => {
    const { roomId, messageId, content } = p as { roomId: string; messageId: string; content: string };
    if (!isActive(roomId)) return;
    slice().messages.set(applySnapshot(read(), roomId, messageId, content));
  });
  s.on('message_completed', (p) => {
    const { roomId, messageId } = p as { roomId: string; messageId: string };
    if (!isActive(roomId)) return;
    slice().messages.set(completeMessage(read(), messageId));
  });
  s.on('presence', (p) => {
    const { roomId, members } = p as { roomId: string; members: string[] };
    if (!isActive(roomId)) return;
    slice().members.set(members);
  });
  s.on('typing', (p) => {
    const { roomId, author, isTyping } = p as { roomId: string; author: string; isTyping: boolean };
    if (!isActive(roomId)) return;
    const cur = slice().typing.get({ noproxy: true }) as string[];
    slice().typing.set(isTyping ? addTyping(cur, author) : removeTyping(cur, author));
  });
  s.on('ai_status', (p) => {
    const { roomId, state, queueDepth } = p as { roomId: string } & IAiStatus;
    if (!isActive(roomId)) return;
    slice().aiStatus.set({ state, queueDepth });
  });
  s.on('error', (p) => {
    const { message } = p as { message: string };
    slice().lastError.set(message ?? 'chat error');
    notify.error(message ?? 'chat error');
  });
  s.on('run_started', (p) => {
    const { roomId, run } = p as { roomId: string; run: IRun };
    if (!isActive(roomId)) return;
    slice().runs.set(startRun(readRuns(), run));
    slice().activeRunId.set(run.id);
  });
  s.on('run_step_started', (p) => {
    const { roomId, runId, step } = p as { roomId: string; runId: string; step: IRunStep };
    if (!isActive(roomId)) return;
    slice().runs.set(startStep(readRuns(), runId, step));
  });
  s.on('run_step_token', (p) => {
    const { roomId, runId, stepIndex, delta } = p as { roomId: string; runId: string; stepIndex: number; delta: string };
    if (!isActive(roomId)) return;
    slice().runs.set(appendStepToken(readRuns(), runId, stepIndex, delta));
  });
  s.on('run_step_completed', (p) => {
    const { roomId, runId, stepIndex, status, content } = p as { roomId: string; runId: string; stepIndex: number; status: IRunStep['status']; content: string };
    if (!isActive(roomId)) return;
    slice().runs.set(completeStep(readRuns(), runId, stepIndex, status, content));
  });
  s.on('run_completed', (p) => {
    const { roomId, runId, status } = p as { roomId: string; runId: string; status: IRun['status'] };
    if (!isActive(roomId)) return;
    slice().runs.set(completeRun(readRuns(), runId, status));
  });
  s.on('run_snapshot', (p) => {
    const { roomId, run } = p as { roomId: string; run: IRun };
    if (!isActive(roomId)) return;
    slice().runs.set(applyRunSnapshot(readRuns(), run));
  });
}

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
    registerInboundHandlers(s);
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
    runSkill: (roomId: string, skillName: string, args: Record<string, unknown>) => emit('run_skill', { roomId, skillName, args }),
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

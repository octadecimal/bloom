import { chatSlice } from './state';
import * as realRest from './restClient';
import { getSocketClient, initSocketClient, type SocketClient } from './socketClient';
import { savePrefs as realSavePrefs } from './prefs';

interface IRestDeps {
  getRooms: typeof realRest.getRooms;
  createRoom: typeof realRest.createRoom;
  getMessages: typeof realRest.getMessages;
  getRuns: typeof realRest.getRuns;
  getSkills: typeof realRest.getSkills;
}

// Injectable deps so actions are unit-testable without the module singletons.
let rest: IRestDeps = realRest;
let socket: Pick<
  SocketClient,
  'connect' | 'disconnect' | 'reconnectWith' | 'joinRoom' | 'leaveRoom' | 'sendPrompt' | 'setTyping' | 'runSkill' | 'resolveApproval' | 'resolveQuestion'
> | null = null;
let savePrefs = realSavePrefs;
let started = false;

export function __setDeps(deps: { rest?: IRestDeps; socket?: typeof socket; savePrefs?: typeof savePrefs }): void {
  if (deps.rest) rest = deps.rest;
  if (deps.socket !== undefined) {
    socket = deps.socket;
    started = false; // reset connection state when a new socket is injected
  }
  if (deps.savePrefs) savePrefs = deps.savePrefs;
}

function sock() {
  return socket ?? getSocketClient();
}

function persist(): void {
  const s = chatSlice();
  savePrefs({ activeRoomId: s.activeRoomId.get() });
}

export function connectChatAs(username: string): void {
  chatSlice().displayName.set(username);
  if (!started) {
    if (socket === null) initSocketClient();
    started = true;
    sock().connect(username);
  } else {
    sock().reconnectWith(username);
  }
}

export function disconnectChat(): void {
  if (started) sock().disconnect();
}

export async function loadRooms(): Promise<void> {
  chatSlice().roomsStatus.set('loading');
  try {
    const rooms = await rest.getRooms();
    chatSlice().rooms.set(rooms);
    chatSlice().roomsStatus.set('idle');
  } catch {
    chatSlice().roomsStatus.set('error');
  }
}

export async function loadSkills(): Promise<void> {
  chatSlice().skillsStatus.set('loading');
  try {
    const skills = await rest.getSkills();
    chatSlice().skills.set(skills);
    chatSlice().skillsStatus.set('idle');
  } catch {
    chatSlice().skillsStatus.set('error');
  }
}

export async function openRoom(roomId: string): Promise<void> {
  const s = chatSlice();
  if (s.activeRoomId.get() === roomId) return;

  const prev = s.activeRoomId.get();
  if (prev) sock().leaveRoom(prev);

  s.activeRoomId.set(roomId);
  s.messages.set([]);
  s.runs.set([]);
  s.activeRunId.set(null);
  s.members.set([]);
  s.typing.set([]);
  s.aiStatus.set({ state: 'idle', queueDepth: 0 });
  s.roomLoadStatus.set('loading');
  persist();

  try {
    const [history, runs] = await Promise.all([rest.getMessages(roomId), rest.getRuns(roomId)]);
    if (chatSlice().activeRoomId.get() !== roomId) return; // a newer openRoom won
    s.messages.set(history);
    s.runs.set(runs);
    s.roomLoadStatus.set('idle');
  } catch {
    if (chatSlice().activeRoomId.get() !== roomId) return;
    s.roomLoadStatus.set('error');
  }
  sock().joinRoom(roomId);
}

export function closeRoom(): void {
  const s = chatSlice();
  const prev = s.activeRoomId.get();
  if (prev) sock().leaveRoom(prev);
  s.activeRoomId.set(null);
  s.messages.set([]);
  s.runs.set([]);
  s.activeRunId.set(null);
  s.members.set([]);
  s.typing.set([]);
  persist();
}

export async function createRoom(name: string, model?: string): Promise<void> {
  const room = await rest.createRoom(name, model);
  chatSlice().rooms.merge([room]);
  await openRoom(room.id);
}

export function sendPrompt(text: string): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().sendPrompt(roomId, text);
}

export function runSkill(skillName: string, args: Record<string, unknown>, text = ''): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().runSkill(roomId, skillName, args, text);
}

export function resolveApproval(runId: string, decision: 'approve' | 'deny'): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().resolveApproval(roomId, runId, decision);
}

export function resolveQuestion(
  runId: string,
  answer: { type: 'suggestion' | 'freetext' | 'delegate'; value?: string },
): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().resolveQuestion(roomId, runId, answer);
}

export function setTyping(isTyping: boolean): void {
  const roomId = chatSlice().activeRoomId.get();
  if (roomId) sock().setTyping(roomId, isTyping);
}

export function initChat(): void {
  void loadRooms();
  void loadSkills();
}

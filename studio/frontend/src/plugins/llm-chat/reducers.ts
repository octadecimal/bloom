import type { IMessage } from './state';

// Minimal streaming assistant stub used as a safety net when a token or snapshot
// arrives before its message_created (rare — message_created normally precedes).
function streamingStub(roomId: string, messageId: string, content: string): IMessage {
  return {
    id: messageId,
    roomId,
    author: 'assistant',
    role: 'assistant',
    content,
    status: 'streaming',
    createdAt: '',
  };
}

export function upsertMessage(messages: IMessage[], message: IMessage): IMessage[] {
  const idx = messages.findIndex((m) => m.id === message.id);
  if (idx === -1) return [...messages, message];
  const next = messages.slice();
  next[idx] = message;
  return next;
}

export function appendToken(messages: IMessage[], roomId: string, messageId: string, delta: string): IMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return [...messages, streamingStub(roomId, messageId, delta)];
  const next = messages.slice();
  next[idx] = { ...next[idx], content: next[idx].content + delta };
  return next;
}

export function applySnapshot(messages: IMessage[], roomId: string, messageId: string, content: string): IMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return [...messages, streamingStub(roomId, messageId, content)];
  const next = messages.slice();
  next[idx] = { ...next[idx], content };
  return next;
}

export function completeMessage(messages: IMessage[], messageId: string): IMessage[] {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return messages;
  const next = messages.slice();
  next[idx] = { ...next[idx], status: 'complete' };
  return next;
}

export function addTyping(typing: string[], author: string): string[] {
  return typing.includes(author) ? typing : [...typing, author];
}

export function removeTyping(typing: string[], author: string): string[] {
  return typing.filter((a) => a !== author);
}

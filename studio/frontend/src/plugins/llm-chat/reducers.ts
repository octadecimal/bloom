import type { IMessage, IRun, IRunStep } from './state';

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

export function startRun(runs: IRun[], run: IRun): IRun[] {
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx === -1) return [...runs, run];
  const next = runs.slice(); next[idx] = run; return next;
}

function patchRun(runs: IRun[], runId: string, fn: (r: IRun) => IRun): IRun[] {
  const idx = runs.findIndex((r) => r.id === runId);
  if (idx === -1) return runs;
  const next = runs.slice(); next[idx] = fn(next[idx]); return next;
}

export function startStep(runs: IRun[], runId: string, step: IRunStep): IRun[] {
  return patchRun(runs, runId, (r) => ({ ...r, steps: [...r.steps, step] }));
}

export function appendStepToken(runs: IRun[], runId: string, index: number, delta: string): IRun[] {
  return patchRun(runs, runId, (r) => ({
    ...r,
    steps: r.steps.map((s) => (s.index === index ? { ...s, content: s.content + delta } : s)),
  }));
}

export function completeStep(runs: IRun[], runId: string, index: number, status: IRunStep['status'], content: string): IRun[] {
  return patchRun(runs, runId, (r) => ({
    ...r,
    steps: r.steps.map((s) => (s.index === index ? { ...s, status, content } : s)),
  }));
}

export function completeRun(runs: IRun[], runId: string, status: IRun['status']): IRun[] {
  return patchRun(runs, runId, (r) => ({ ...r, status }));
}

export function applyRunSnapshot(runs: IRun[], run: IRun): IRun[] {
  return startRun(runs, run);
}

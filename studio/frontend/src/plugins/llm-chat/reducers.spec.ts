import { describe, it, expect } from 'vitest';
import type { IMessage } from './state';
import { upsertMessage, appendToken, applySnapshot, completeMessage, addTyping, removeTyping } from './reducers';

const msg = (over: Partial<IMessage>): IMessage => ({
  id: 'm1',
  roomId: 'r1',
  author: 'assistant',
  role: 'assistant',
  content: '',
  status: 'streaming',
  createdAt: '2026-06-19T00:00:00Z',
  ...over,
});

describe('reducers', () => {
  it('upsertMessage appends a new message', () => {
    const out = upsertMessage([], msg({ id: 'a' }));
    expect(out.map((m) => m.id)).toEqual(['a']);
  });

  it('upsertMessage replaces an existing message by id (idempotent)', () => {
    const out = upsertMessage([msg({ id: 'a', content: 'old' })], msg({ id: 'a', content: 'new' }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('new');
  });

  it('appendToken appends a delta to an existing assistant message', () => {
    const out = appendToken([msg({ id: 'a', content: 'He' })], 'r1', 'a', 'llo');
    expect(out[0].content).toBe('Hello');
  });

  it('appendToken find-or-creates a streaming stub when the message is unknown', () => {
    const out = appendToken([], 'r1', 'a', 'Hi');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'a', roomId: 'r1', role: 'assistant', content: 'Hi', status: 'streaming' });
  });

  it('appendToken does not mutate its input array', () => {
    const input = [msg({ id: 'a', content: 'x' })];
    appendToken(input, 'r1', 'a', 'y');
    expect(input[0].content).toBe('x');
  });

  it('applySnapshot SETS content (find-or-create) for join mid-stream', () => {
    const out = applySnapshot([msg({ id: 'a', content: '' })], 'r1', 'a', 'caught up');
    expect(out[0].content).toBe('caught up');
  });

  it('applySnapshot creates a streaming stub when message unknown', () => {
    const out = applySnapshot([], 'r1', 'a', 'partial');
    expect(out[0]).toMatchObject({ id: 'a', roomId: 'r1', content: 'partial', status: 'streaming' });
  });

  it('completeMessage flips status to complete', () => {
    const out = completeMessage([msg({ id: 'a', status: 'streaming' })], 'a');
    expect(out[0].status).toBe('complete');
  });

  it('addTyping adds an author once; removeTyping removes it', () => {
    expect(addTyping([], 'bob')).toEqual(['bob']);
    expect(addTyping(['bob'], 'bob')).toEqual(['bob']);
    expect(removeTyping(['bob', 'amy'], 'bob')).toEqual(['amy']);
  });
});

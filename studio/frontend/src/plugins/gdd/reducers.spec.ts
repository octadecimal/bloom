import { describe, it, expect } from 'vitest';
import type { IGddDoc } from './state';
import { upsertDoc } from './reducers';

const doc = (aspect: string, order: number, body = ''): IGddDoc => ({
  id: aspect,
  gameId: 'g1',
  aspect,
  title: aspect,
  order,
  body,
  status: 'empty',
  createdAt: '',
  updatedAt: '',
});

describe('gdd reducers', () => {
  it('upsertDoc replaces by aspect and keeps order sort', () => {
    const seeded = [doc('theme', 1), doc('math-model', 2)];
    const updated = upsertDoc(seeded, doc('math-model', 2, 'RTP 96%'));
    expect(updated).toHaveLength(2);
    expect(updated.find((d) => d.aspect === 'math-model')!.body).toBe('RTP 96%');
    expect(updated.map((d) => d.order)).toEqual([1, 2]);
  });

  it('upsertDoc inserts a new aspect in order position', () => {
    const out = upsertDoc([doc('math-model', 2)], doc('theme', 1));
    expect(out.map((d) => d.aspect)).toEqual(['theme', 'math-model']);
  });
});

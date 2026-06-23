import { describe, it, expect } from 'vitest';
import { buildFeed } from './feed';

const m = (id: string, createdAt: string) => ({ id, createdAt });

describe('buildFeed', () => {
  it('interleaves messages and runs by createdAt', () => {
    const messages = [m('u1', '2026-06-23T00:00:00Z'), m('u2', '2026-06-23T00:00:05Z'), m('a3', '2026-06-23T00:00:09Z')];
    const runs = [m('run1', '2026-06-23T00:00:02Z')];
    const feed = buildFeed(messages, runs);
    expect(feed.map((e) => e.id)).toEqual(['u1', 'run1', 'u2', 'a3']);
    expect(feed.map((e) => e.kind)).toEqual(['message', 'run', 'message', 'message']);
  });

  it('carries the source-array index for each kind', () => {
    const messages = [m('u1', '2026-06-23T00:00:00Z'), m('u2', '2026-06-23T00:00:05Z')];
    const runs = [m('run1', '2026-06-23T00:00:02Z')];
    const feed = buildFeed(messages, runs);
    expect(feed.find((e) => e.id === 'u2')).toMatchObject({ kind: 'message', index: 1 });
    expect(feed.find((e) => e.id === 'run1')).toMatchObject({ kind: 'run', index: 0 });
  });

  it('orders a message before a run when timestamps are equal', () => {
    const feed = buildFeed([m('u1', '2026-06-23T00:00:02Z')], [m('run1', '2026-06-23T00:00:02Z')]);
    expect(feed.map((e) => e.id)).toEqual(['u1', 'run1']);
  });

  it('handles empty inputs', () => {
    expect(buildFeed([], [])).toEqual([]);
  });
});

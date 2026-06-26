import { describe, it, expect, vi } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { Reconciler } from '../render/reconciler';
import { MockRenderer } from '../render/mockRenderer';
import { ProtocolHost } from './protocolHost';

function setup(onSpin?: (o: { grid: string[][] }) => void) {
  const model = new GraphModel();
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const posts: unknown[] = [];
  const host = new ProtocolHost({ model, reconciler, post: (m) => posts.push(m), onSpin });
  return { host, posts };
}

describe('ProtocolHost spin', () => {
  it('dispatches a spin message to onSpin and acks', async () => {
    const onSpin = vi.fn();
    const { host, posts } = setup(onSpin);
    await host.handle({ v: 1, kind: 'spin', id: '7', outcome: { grid: [['A']] } });
    expect(onSpin).toHaveBeenCalledWith({ grid: [['A']] });
    expect(posts).toContainEqual({ v: 1, kind: 'ack', id: '7' });
  });

  it('acks a spin even with no onSpin wired (no throw)', async () => {
    const { host, posts } = setup(undefined);
    await host.handle({ v: 1, kind: 'spin', id: '8', outcome: { grid: [] } });
    expect(posts).toContainEqual({ v: 1, kind: 'ack', id: '8' });
  });
});

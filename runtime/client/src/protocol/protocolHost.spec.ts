import { describe, it, expect } from 'vitest';
import { GraphModel } from '../model/graphModel';
import { MockRenderer } from '../render/mockRenderer';
import { Reconciler } from '../render/reconciler';
import { ProtocolHost } from './protocolHost';
import type { OutboundMessage } from './messages';

function setup() {
  const model = new GraphModel();
  const renderer = new MockRenderer();
  const reconciler = new Reconciler(renderer, model);
  const sent: OutboundMessage[] = [];
  const host = new ProtocolHost({ model, reconciler, post: (m) => sent.push(m) });
  return { model, renderer, host, sent };
}

describe('ProtocolHost', () => {
  it('emits ready on start', () => {
    const { host, sent } = setup();
    host.start();
    expect(sent).toEqual([{ v: 1, kind: 'ready', protocolVersion: 1 }]);
  });

  it('applies an op and acks', async () => {
    const { host, sent, model } = setup();
    await host.handle({ v: 1, kind: 'op', id: 'm1', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    expect(model.getNode('s')).toBeDefined();
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: 'm1' });
  });

  it('errors (not throws) on an invalid op, leaving the model untouched', async () => {
    const { host, sent, model } = setup();
    await host.handle({ v: 1, kind: 'op', id: 'm2', op: { kind: 'removeNode', id: 'ghost' } });
    expect(model.getNode('ghost')).toBeUndefined();
    expect(sent.some((m) => m.kind === 'error' && m.id === 'm2' && m.code === 'unknown_node')).toBe(true);
  });

  it('loads a document on init and acks', async () => {
    const { host, sent, renderer } = setup();
    await host.handle({
      v: 1,
      kind: 'init',
      id: 'm3',
      document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: { width: 800, height: 600 } } }, edges: [] },
    });
    expect(renderer.calls).toContainEqual(['mount', 'root']);
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: 'm3' });
  });

  it('posts error with code internal when reconciliation throws a non-OpError', async () => {
    const model = new GraphModel();
    const fakeReconciler = {
      applyChanges: async () => {
        throw new Error('boom');
      },
    } as unknown as import('../render/reconciler').Reconciler;
    const sent: OutboundMessage[] = [];
    const host = new ProtocolHost({ model, reconciler: fakeReconciler, post: (m) => sent.push(m) });
    await host.handle({ v: 1, kind: 'op', id: 'err1', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    expect(sent.some((m) => m.kind === 'error' && m.id === 'err1' && m.code === 'internal')).toBe(true);
    expect(sent.some((m) => m.kind === 'ack' && m.id === 'err1')).toBe(false);
  });

  it('applies a batch and acks', async () => {
    const { host, sent, model } = setup();
    await host.handle({
      v: 1,
      kind: 'batch',
      id: 'm4',
      ops: [
        { kind: 'addNode', id: 'a', type: 'Container' },
        { kind: 'addNode', id: 'b', type: 'Sprite' },
      ],
    });
    expect(model.getNode('a')).toBeDefined();
    expect(model.getNode('b')).toBeDefined();
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: 'm4' });
  });

  it('captures the rendered frame and replies with captured (not ack)', async () => {
    const { host, sent } = setup();
    await host.handle({ v: 1, kind: 'capture', id: 'c1' });
    expect(sent).toContainEqual({ v: 1, kind: 'captured', id: 'c1', png: 'data:image/png;base64,MOCK' });
    expect(sent.some((m) => m.kind === 'ack' && m.id === 'c1')).toBe(false);
  });

  it('reports an error (not captured) when capture throws', async () => {
    const model = new GraphModel();
    const fakeReconciler = {
      applyChanges: async () => {},
      capture: async () => {
        throw new Error('extract failed');
      },
    } as unknown as import('../render/reconciler').Reconciler;
    const sent: OutboundMessage[] = [];
    const host = new ProtocolHost({ model, reconciler: fakeReconciler, post: (m) => sent.push(m) });
    await host.handle({ v: 1, kind: 'capture', id: 'c2' });
    expect(sent.some((m) => m.kind === 'error' && m.id === 'c2' && m.code === 'internal')).toBe(true);
    expect(sent.some((m) => m.kind === 'captured')).toBe(false);
  });
});

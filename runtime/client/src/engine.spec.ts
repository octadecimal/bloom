import { describe, it, expect } from 'vitest';
import { MockRenderer } from './render/mockRenderer';
import { createEngine } from './engine';
import type { OutboundMessage } from './protocol/messages';

describe('createEngine', () => {
  it('wires model + reconciler + protocol so ops reconcile and ack', async () => {
    const renderer = new MockRenderer();
    const sent: OutboundMessage[] = [];
    const { host, model } = createEngine({ renderer, post: (m) => sent.push(m) });
    host.start();
    await host.handle({ v: 1, kind: 'op', id: '1', op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    expect(sent[0]).toEqual({ v: 1, kind: 'ready', protocolVersion: 1 });
    expect(renderer.calls).toContainEqual(['mount', 'root', { width: 640, height: 480 }]);
    expect(model.getNode('root')).toBeDefined();
    expect(sent).toContainEqual({ v: 1, kind: 'ack', id: '1' });
  });
});

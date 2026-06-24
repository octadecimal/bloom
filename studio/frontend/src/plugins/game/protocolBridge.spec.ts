import { describe, it, expect, vi } from 'vitest';
import { ProtocolBridge } from './protocolBridge';
import { emptyDocument } from './state';

const ENGINE = 'http://localhost:4300';

function setup() {
  const post = vi.fn();
  const onError = vi.fn();
  const bridge = new ProtocolBridge({ post, engineOrigin: ENGINE, onError });
  return { bridge, post, onError };
}

describe('ProtocolBridge', () => {
  it('queues ops sent before ready, then flushes on ready', () => {
    const { bridge, post } = setup();
    bridge.op({ kind: 'addNode', id: 's', type: 'Sprite' });
    expect(post).not.toHaveBeenCalled(); // queued
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    expect(post).toHaveBeenCalledTimes(1);
    const [msg, target] = post.mock.calls[0];
    expect(msg).toMatchObject({ v: 1, kind: 'op', op: { kind: 'addNode', id: 's' } });
    expect(target).toBe(ENGINE);
  });

  it('posts immediately once ready', () => {
    const { bridge, post } = setup();
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    bridge.init(emptyDocument());
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ kind: 'init' });
  });

  it('ignores engine messages from a foreign origin', () => {
    const { bridge, post } = setup();
    bridge.op({ kind: 'addNode', id: 's', type: 'Sprite' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://evil:9999');
    expect(post).not.toHaveBeenCalled(); // never became ready
  });

  it('surfaces engine errors', () => {
    const { bridge, onError } = setup();
    const err = { v: 1, kind: 'error', id: 'm1', code: 'cycle', message: 'no' };
    bridge.handleEngineMessage(err, ENGINE);
    expect(onError).toHaveBeenCalledWith({ code: 'cycle', message: 'no' });
  });

  it('reset() re-queues until the next ready (iframe reload)', () => {
    const { bridge, post } = setup();
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    bridge.reset();
    bridge.op({ kind: 'addNode', id: 's', type: 'Sprite' });
    expect(post).not.toHaveBeenCalled();
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, ENGINE);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

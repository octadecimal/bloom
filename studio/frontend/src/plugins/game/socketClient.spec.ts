import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { applyInbound } from './socketClient';
import { setBridge, ProtocolBridge } from './protocolBridge';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
  gameSlice().activeGameId.set('g1');
});

describe('game socket inbound', () => {
  it('scene_snapshot loads the document and re-inits the bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyInbound('scene_snapshot', {
      gameId: 'g1',
      document: { version: 1, nodes: { root: { id: 'root', type: 'Root', props: {} } }, edges: [] },
    });

    expect(gameSlice().document.nodes.get({ noproxy: true })).toHaveProperty('root');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'init' }), 'http://localhost:4300');
  });

  it('scene_op applies to the document and forwards to the bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyInbound('scene_op', { gameId: 'g1', op: { kind: 'addNode', id: 's', type: 'Sprite' } });

    expect(gameSlice().document.nodes.get({ noproxy: true })).toHaveProperty('s');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'op' }), 'http://localhost:4300');
  });

  it('ignores events for an inactive game', () => {
    const post = vi.fn();
    setBridge(new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' }));
    applyInbound('scene_op', { gameId: 'other', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    expect(gameSlice().document.nodes.get({ noproxy: true })).not.toHaveProperty('s');
  });
});

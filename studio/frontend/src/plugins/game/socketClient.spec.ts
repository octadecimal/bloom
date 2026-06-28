import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_PLUGIN_ID, gameSlice, makeInitialState } from './state';
import { SCENE_STORE_ID, sceneStore, makeInitialSceneState } from '../../scene/sceneStore';
import { applyInbound, applyCaptureRequest, applySpinOutcome } from './socketClient';
import { setBridge, ProtocolBridge } from './protocolBridge';

beforeEach(() => {
  rootStore.plugins.nested(GAME_PLUGIN_ID).set(makeInitialState() as never);
  rootStore.plugins.nested(SCENE_STORE_ID).set(makeInitialSceneState() as never);
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

    expect(sceneStore().document.nodes.get({ noproxy: true })).toHaveProperty('root');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'init' }), 'http://localhost:4300');
  });

  it('scene_op applies to the document and forwards to the bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyInbound('scene_op', { gameId: 'g1', op: { kind: 'addNode', id: 's', type: 'Sprite' } });

    expect(sceneStore().document.nodes.get({ noproxy: true })).toHaveProperty('s');
    expect(post).toHaveBeenCalledWith(expect.objectContaining({ kind: 'op' }), 'http://localhost:4300');
  });

  it('ignores events for an inactive game', () => {
    const post = vi.fn();
    setBridge(new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' }));
    applyInbound('scene_op', { gameId: 'other', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    expect(sceneStore().document.nodes.get({ noproxy: true })).not.toHaveProperty('s');
  });
});

describe('game socket capture relay', () => {
  it('scene_capture_request forwards a capture to the active bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyCaptureRequest({ gameId: 'g1', captureId: 'cap1' });

    expect(post).toHaveBeenCalledWith({ v: 1, kind: 'capture', id: 'cap1' }, 'http://localhost:4300');
  });

  it('ignores a capture request for an inactive game', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applyCaptureRequest({ gameId: 'other', captureId: 'cap1' });

    expect(post).not.toHaveBeenCalled();
  });
});

describe('game socket spin outcome', () => {
  it('applySpinOutcome forwards to the active bridge', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applySpinOutcome({ gameId: 'g1', outcome: { grid: [['0', '1', '2']] } });

    expect(post).toHaveBeenCalledWith(expect.objectContaining({ v: 1, kind: 'spin', outcome: { grid: [['0', '1', '2']] } }), 'http://localhost:4300');
  });

  it('ignores a spin outcome for an inactive game', () => {
    const post = vi.fn();
    const bridge = new ProtocolBridge({ post, engineOrigin: 'http://localhost:4300' });
    bridge.handleEngineMessage({ v: 1, kind: 'ready', protocolVersion: 1 }, 'http://localhost:4300');
    setBridge(bridge);

    applySpinOutcome({ gameId: 'other', outcome: { grid: [['0']] } });

    expect(post).not.toHaveBeenCalled();
  });
});

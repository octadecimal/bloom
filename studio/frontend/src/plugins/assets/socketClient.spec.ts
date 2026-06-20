// studio/frontend/src/plugins/assets/socketClient.spec.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { ASSETS_PLUGIN_ID, assetsSlice, makeInitialState, type IAsset } from './state';
import { createSocketClient, type ISocketLike } from './socketClient';

vi.mock('../../lib/notify', () => ({ notify: { error: vi.fn(), info: vi.fn() } }));

function fakeSocket(): ISocketLike & { fire: (e: string, p: unknown) => void } {
  const handlers: Record<string, (p: unknown) => void> = {};
  return {
    auth: {},
    connected: true,
    on: (e, cb) => {
      handlers[e] = cb;
    },
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    fire: (e, p) => handlers[e]?.(p),
  };
}

const asset: IAsset = {
  id: 'a1',
  gameId: 'g1',
  name: 'W',
  category: null,
  prompt: 'p',
  width: 64,
  height: 64,
  workflow: 'schnell-opaque',
  seed: null,
  status: 'idle',
  generations: [],
  selectedGenerationId: null,
  error: null,
  progress: null,
};

beforeEach(() => {
  rootStore.plugins.nested(ASSETS_PLUGIN_ID).set(makeInitialState() as never);
  assetsSlice().activeGameId.set('g1');
  assetsSlice().assets.set([asset]);
});

describe('assets socketClient', () => {
  it('applies asset_progress for the active game', () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const client = createSocketClient(() => (sock = fakeSocket()));
    client.connect();
    sock.fire('asset_progress', { gameId: 'g1', assetId: 'a1', value: 2, max: 4 });
    expect(assetsSlice().assets.get({ noproxy: true })[0].progress).toEqual({ value: 2, max: 4 });
  });

  it('ignores events for a non-active game', () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const client = createSocketClient(() => (sock = fakeSocket()));
    client.connect();
    sock.fire('asset_status', { gameId: 'other', assetId: 'a1', status: 'generating' });
    expect(assetsSlice().assets.get({ noproxy: true })[0].status).toBe('idle');
  });

  it('asset_completed replaces the asset', () => {
    let sock!: ReturnType<typeof fakeSocket>;
    const client = createSocketClient(() => (sock = fakeSocket()));
    client.connect();
    const done = { ...asset, status: 'done' as const, generations: [{ id: 'gen1', seed: 1, imageRef: '/x.png', createdAt: '' }], selectedGenerationId: 'gen1' };
    sock.fire('asset_completed', { gameId: 'g1', asset: done });
    expect(assetsSlice().assets.get({ noproxy: true })[0].status).toBe('done');
  });
});

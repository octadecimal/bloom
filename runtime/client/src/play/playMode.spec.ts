import { describe, it, expect, vi } from 'vitest';
import { startPlayMode, buildPlayDocument, type IPlayModeDeps } from './playMode';
import type { IHandshakeResponse, ISpinResponse } from './wireTypes';

const HS: IHandshakeResponse = {
  package_id: 'bloom-demo-slots',
  package_version: 1,
  mechanic: 'slots@1',
  presentation: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' },
};

const SPIN: ISpinResponse = {
  seed: '33',
  bet: 1,
  outcome: {
    mechanic: 'slots@1',
    base_grid: [
      [0, 1, 2],
      [1, 2, 9],
      [2, 9, 0],
    ],
    base_payout: 0,
    feature_payout: 0,
    total_payout: 0,
    features: [],
  },
};

function harness(over: Partial<{ handshake: () => Promise<IHandshakeResponse>; spin: () => Promise<ISpinResponse> }> = {}) {
  const initCalls: unknown[] = [];
  const spun: unknown[] = [];
  const settledCbs: Array<() => void> = [];
  const spinButton = document.createElement('button');
  spinButton.id = 'spin';
  spinButton.hidden = true;
  const errorEl = document.createElement('div');
  errorEl.hidden = true;
  const deps: IPlayModeDeps = {
    client: {
      handshake: over.handshake ?? (async () => HS),
      spin: over.spin ?? (async () => SPIN),
    },
    host: { handle: async (m) => void initCalls.push(m) },
    bus: { on: (event, cb) => (event === 'reels:settled' ? settledCbs.push(cb as () => void) : void 0, () => {}) },
    orchestrator: { spin: (o) => void spun.push(o) },
    spinButton,
    errorEl,
  };
  return { deps, initCalls, spun, settledCbs, spinButton, errorEl };
}

describe('buildPlayDocument', () => {
  it('builds a Root + reels module decl from the presentation', () => {
    const doc = buildPlayDocument({ cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' });
    expect(doc.nodes.root.type).toBe('Root');
    expect(doc.modules).toEqual([{ id: 'reels', type: 'reels', config: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' } }]);
  });
});

describe('startPlayMode', () => {
  it('handshakes, inits the scene, and reveals the Spin button', async () => {
    const h = harness();
    await startPlayMode(h.deps);
    expect(h.initCalls).toHaveLength(1);
    expect((h.initCalls[0] as { kind: string }).kind).toBe('init');
    expect(h.spinButton.hidden).toBe(false);
  });

  it('on Spin: fetches the outcome, adapts it, and drives the orchestrator', async () => {
    const h = harness();
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.spun).toHaveLength(1));
    expect(h.spun[0]).toEqual({
      grid: [
        ['0', '1', '2'],
        ['1', '2', '9'],
        ['2', '9', '0'],
      ],
    });
    // disabled while spinning; re-enabled when the reels settle
    expect(h.spinButton.disabled).toBe(true);
    h.settledCbs.forEach((cb) => cb());
    expect(h.spinButton.disabled).toBe(false);
  });

  it('surfaces a handshake failure and does not show the Spin button', async () => {
    const h = harness({
      handshake: async () => {
        throw new Error('network down');
      },
    });
    await startPlayMode(h.deps);
    expect(h.errorEl.hidden).toBe(false);
    expect(h.errorEl.textContent).toContain('network down');
    expect(h.spinButton.hidden).toBe(true);
    expect(h.initCalls).toHaveLength(0);
  });

  it('surfaces a spin failure and re-enables Spin for retry', async () => {
    const h = harness({
      spin: async () => {
        throw new Error('spin failed: 500');
      },
    });
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.errorEl.textContent).toContain('spin failed: 500'));
    expect(h.spinButton.disabled).toBe(false);
  });
});

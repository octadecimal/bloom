import { describe, it, expect, vi } from 'vitest';
import { startPlayMode, buildPlayDocument, buildComposedPlayDocument, type IPlayModeDeps } from './playMode';
import type { IHandshakeResponse, ISpinResponse, IPresentation } from './wireTypes';
import type { IGameDefinition } from './composedTypes';
import type { ITriggerTarget } from '../orchestration/traceWalker';

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
  const busEmits: Array<{ event: string; payload: unknown }> = [];
  const targets = new Map<string, ITriggerTarget>();
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
    bus: {
      on: (event, cb) => (event === 'reels:settled' ? settledCbs.push(cb as () => void) : void 0, () => {}),
      emit: (event, payload) => busEmits.push({ event, payload }),
    },
    orchestrator: { spin: (o) => void spun.push(o) },
    resolveTarget: (id) => targets.get(id) ?? null,
    spinButton,
    errorEl,
  };
  return { deps, initCalls, spun, settledCbs, spinButton, errorEl, busEmits, targets };
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

const COMPOSED_HS: IHandshakeResponse = {
  package_id: 'bloom-demo-composed',
  package_version: 1,
  mechanic: 'composed@1',
  presentation: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' },
  definition: {
    family: 'composed@1',
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: {} },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9 } },
    ],
    states: [],
    start: 'base',
    transitions: [],
    caps: { max_steps: 100 },
  },
};

const COMPOSED_SPIN: ISpinResponse = {
  seed: '8',
  bet: 1,
  outcome: { mechanic: 'composed@1', total_payout: 8 },
  trace: [
    { t: 'round_start', seed: '8' },
    { t: 'state_enter', state: 'base' },
    { t: 'trigger', mechanic: 'main_reels', name: 'spin', events: [], data: { kind: 'reels', grid: [[9], [9], [9]], payout: 8 } },
    { t: 'trigger', mechanic: 'bonus_meter', name: 'accumulate', events: [], data: { kind: 'meter', fill: 3, target: 6 } },
    { t: 'state_exit', state: 'base', payout: 8 },
    { t: 'round_end', total_payout: 8 },
  ],
};

describe('buildComposedPlayDocument', () => {
  const def = COMPOSED_HS.definition as IGameDefinition;
  const pres = COMPOSED_HS.presentation as IPresentation;

  it('maps mechanics to module decls keyed by instance id', () => {
    const doc = buildComposedPlayDocument(def, pres);
    expect(doc.nodes.root.type).toBe('Root');
    expect(doc.modules).toEqual([
      { id: 'main_reels', type: 'reels', config: { cols: 3, rows: 3, symbols: ['0', '1', '2', '9'], parentId: 'root' } },
      { id: 'bonus_meter', type: 'meter', config: { target: 6 } },
    ]);
  });

  it('throws on an unknown mechanic type', () => {
    const bad = { ...def, mechanics: [{ id: 'x', type: 'dice@1', config: {} }] };
    expect(() => buildComposedPlayDocument(bad, pres)).toThrow(/dice@1/);
  });

  it('throws on a meter config without a numeric target', () => {
    const bad = { ...def, mechanics: [{ id: 'm', type: 'meter@1', config: {} }] };
    expect(() => buildComposedPlayDocument(bad, pres)).toThrow(/target/);
  });
});

describe('startPlayMode (composed@1)', () => {
  function composedHarness(over: Parameters<typeof harness>[0] = {}) {
    const h = harness({ handshake: async () => COMPOSED_HS, spin: async () => COMPOSED_SPIN, ...over });
    const invoked: string[] = [];
    const target = (id: string): ITriggerTarget => ({
      invoke: (trigger) => {
        invoked.push(`${id}.${trigger}`);
        return Promise.resolve();
      },
    });
    h.targets.set('main_reels', target('main_reels'));
    h.targets.set('bonus_meter', target('bonus_meter'));
    return { ...h, invoked };
  }

  it('inits the composed document and reveals Spin', async () => {
    const h = composedHarness();
    await startPlayMode(h.deps);
    expect(h.initCalls).toHaveLength(1);
    const doc = (h.initCalls[0] as { document: { modules: unknown[] } }).document;
    expect(doc.modules).toHaveLength(2);
    expect(h.spinButton.hidden).toBe(false);
  });

  it('on Spin: walks the served trace and re-enables the button when done', async () => {
    const h = composedHarness();
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.invoked).toEqual(['main_reels.spin', 'bonus_meter.accumulate']));
    await vi.waitFor(() => expect(h.spinButton.disabled).toBe(false));
    expect(h.busEmits.some((e) => e.event === 'round:complete')).toBe(true);
    expect(h.errorEl.hidden).toBe(true);
  });

  it('a composed spin without a trace is surfaced as an error and re-enables Spin', async () => {
    const h = composedHarness({ spin: async () => ({ ...COMPOSED_SPIN, trace: undefined }) });
    await startPlayMode(h.deps);
    h.spinButton.click();
    await vi.waitFor(() => expect(h.errorEl.textContent).toContain('trace'));
    expect(h.spinButton.disabled).toBe(false);
  });

  it('an unknown handshake mechanic is surfaced and Spin stays hidden', async () => {
    const h = harness({ handshake: async () => ({ ...HS, mechanic: 'poker@1' }) });
    await startPlayMode(h.deps);
    expect(h.errorEl.hidden).toBe(false);
    expect(h.spinButton.hidden).toBe(true);
  });
});

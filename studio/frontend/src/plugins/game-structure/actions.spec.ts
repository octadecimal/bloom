import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDefinition } from './model';
import { gameStructureSlice, makeInitialState } from './state';

vi.mock('./restClient', () => ({
  getGameDefinition: vi.fn(),
  putGameDefinition: vi.fn(),
  validateGameDefinition: vi.fn(),
  buildGameDefinition: vi.fn(),
}));
vi.mock('./socketClient', () => ({
  setDefinitionChangedHandler: vi.fn(),
  setBuildStatusHandler: vi.fn(),
  gameStructureSock: () => ({ connect: vi.fn(), disconnect: vi.fn(), join: vi.fn(), leave: vi.fn() }),
}));

import * as rest from './restClient';
import {
  SAVE_DEBOUNCE_MS,
  VALIDATE_DEBOUNCE_MS,
  applyBuildStatus,
  applyDefinition,
  applyDocFromJson,
  buildPackage,
  flushPendingSave,
  handleDefinitionChanged,
  openGameStructure,
} from './actions';

const restMock = rest as unknown as Record<string, ReturnType<typeof vi.fn>>;

function wireDoc(over: Partial<Record<string, unknown>> = {}) {
  return { id: 'd1', gameId: 'g1', definition: emptyDefinition(), presentation: { p: 1 }, updatedAt: '2026-07-09T00:00:00Z', ...over };
}

beforeEach(() => {
  gameStructureSlice().set(makeInitialState());
  vi.useFakeTimers();
  // mirrors game-config's actions.spec.ts: mocks are module-level vi.fn()s that
  // outlive a single `it`, so each test starts from a clean call history.
  restMock.getGameDefinition.mockReset();
  restMock.putGameDefinition.mockReset();
  restMock.validateGameDefinition.mockReset();
  restMock.buildGameDefinition.mockReset();
  restMock.getGameDefinition.mockResolvedValue(wireDoc());
  restMock.putGameDefinition.mockResolvedValue(wireDoc({ updatedAt: '2026-07-09T00:00:01Z' }));
  restMock.validateGameDefinition.mockResolvedValue({ ok: true, errors: [] });
  restMock.buildGameDefinition.mockResolvedValue({
    ok: true,
    errors: null,
    metrics: { rtp: 1, hitRate: 0.3, maxWinX: 9, stateVisits: { base: 10 } },
    verdict: null,
    packageId: 'g1',
  });
});
afterEach(() => vi.useRealTimers());

describe('openGameStructure', () => {
  it('hydrates doc + watermark', async () => {
    await openGameStructure('g1');
    const s = gameStructureSlice();
    expect(s.definition.get({ noproxy: true })).toEqual(emptyDefinition());
    expect(s.watermark.get()).toBe('2026-07-09T00:00:00Z');
    expect(s.loadStatus.get()).toBe('idle');
  });
});

describe('applyDefinition', () => {
  it('debounces a partial PUT with source editor and refreshes jsonDraft', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'base' }));
    expect(gameStructureSlice().sync.get()).toBe('saving');
    expect(gameStructureSlice().jsonDraft.get()).toContain('"start": "base"');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1);
    expect(restMock.putGameDefinition).toHaveBeenCalledWith(
      'g1',
      expect.objectContaining({ source: 'editor', definition: expect.objectContaining({ start: 'base' }) }),
    );
    expect(gameStructureSlice().sync.get()).toBe('saved');
  });

  it('schedules a debounced kernel validate of the live definition', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'nope' }));
    restMock.validateGameDefinition.mockResolvedValue({ ok: false, errors: ['UnknownState'] });
    await vi.advanceTimersByTimeAsync(VALIDATE_DEBOUNCE_MS + 1);
    const v = gameStructureSlice().validation.get({ noproxy: true });
    expect(v.status).toBe('errors');
    expect(v.errors).toEqual(['UnknownState']);
  });
});

describe('watermark', () => {
  it('own editor echoes only advance the watermark; newer external writes rehydrate', async () => {
    await openGameStructure('g1');
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-09T00:00:05Z', source: 'editor' });
    expect(gameStructureSlice().watermark.get()).toBe('2026-07-09T00:00:05Z');
    expect(restMock.getGameDefinition).toHaveBeenCalledTimes(1);

    restMock.getGameDefinition.mockResolvedValue(wireDoc({ updatedAt: '2026-07-09T00:00:09Z' }));
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-09T00:00:09Z', source: 'api' });
    await vi.advanceTimersByTimeAsync(1);
    expect(restMock.getGameDefinition).toHaveBeenCalledTimes(2);
    expect(gameStructureSlice().sync.get()).toBe('external');
    expect(gameStructureSlice().externalSource.get()).toBe('api');
  });

  it('stale external events are ignored', async () => {
    await openGameStructure('g1');
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-08T00:00:00Z', source: 'api' });
    expect(restMock.getGameDefinition).toHaveBeenCalledTimes(1);
  });
});

describe('straggler hydration vs dirty local edits', () => {
  it('a straggler GET from openGameStructure does not clobber a dirty edit made after a second (external seed) hydrate already won the race', async () => {
    // GET #1: openGameStructure's own fetch — held open to arrive LAST (the straggler).
    let resolveFirst!: (doc: unknown) => void;
    const firstGet = new Promise((resolve) => (resolveFirst = resolve));
    restMock.getGameDefinition.mockReturnValueOnce(firstGet);

    const openPromise = openGameStructure('g1'); // GET #1 in flight; watermark still ''

    // Socket 'seed' event arrives before GET #1 resolves -> rehydrateExternal fires GET #2.
    restMock.getGameDefinition.mockResolvedValueOnce(wireDoc({ updatedAt: '2026-07-09T00:00:02Z' }));
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-09T00:00:02Z', source: 'seed' });
    await vi.advanceTimersByTimeAsync(0); // let GET #2 resolve and hydrate

    expect(gameStructureSlice().watermark.get()).toBe('2026-07-09T00:00:02Z');

    // User edits before the straggler GET #1 resolves.
    applyDefinition((d) => ({ ...d, start: 'edited' }));
    expect(gameStructureSlice().definition.start.get()).toBe('edited');

    // The straggler GET #1 (stale seeded doc) finally resolves.
    resolveFirst(wireDoc({ updatedAt: '2026-07-09T00:00:00Z' }));
    await openPromise;

    expect(gameStructureSlice().definition.start.get()).toBe('edited'); // not clobbered
    expect(gameStructureSlice().watermark.get()).toBe('2026-07-09T00:00:02Z'); // not regressed either
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1); // flush the pending save so dirty doesn't leak into the next test
  });

  it('a genuine (non-stale) external hydrate is suppressed while dirty, so it never clobbers unsaved local edits', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'edited' })); // dirty.definition = true, save pending

    restMock.getGameDefinition.mockResolvedValue(wireDoc({ updatedAt: '2026-07-09T00:00:05Z', definition: { ...emptyDefinition(), start: 'server-value' } }));
    handleDefinitionChanged({ gameId: 'g1', updatedAt: '2026-07-09T00:00:05Z', source: 'api' });
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 1); // flush the pending save too (also resolves rehydrateExternal's GET)

    expect(gameStructureSlice().definition.start.get()).toBe('edited'); // local edit preserved
  });
});

describe('applyDocFromJson', () => {
  it('applies {definition, presentation} and rejects bad JSON', async () => {
    await openGameStructure('g1');
    expect(applyDocFromJson('{nope')).toBe(false);
    expect(gameStructureSlice().jsonError.get()).toBeTruthy();
    const ok = applyDocFromJson(JSON.stringify({ definition: { ...emptyDefinition(), start: 'x' }, presentation: { theme: 'y' } }));
    expect(ok).toBe(true);
    expect(gameStructureSlice().definition.start.get()).toBe('x');
    expect(gameStructureSlice().presentation.get({ noproxy: true })).toEqual({ theme: 'y' });
  });
});

describe('buildPackage', () => {
  it('flushes the pending save, then stores metrics', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'base' }));
    await buildPackage();
    expect(restMock.putGameDefinition).toHaveBeenCalled(); // flushed before build
    const b = gameStructureSlice().build.get({ noproxy: true });
    expect(b.status).toBe('done');
    expect(b.metrics?.rtp).toBe(1);
  });

  it('stores kernel errors on a failed build', async () => {
    restMock.buildGameDefinition.mockResolvedValue({ ok: false, errors: ['BadCaps'], metrics: null, verdict: null, packageId: 'g1' });
    await openGameStructure('g1');
    await buildPackage();
    const b = gameStructureSlice().build.get({ noproxy: true });
    expect(b.status).toBe('error');
    expect(b.errors).toEqual(['BadCaps']);
  });

  it('a failed verify (ok:false with a verdict) preserves the verdict on the error branch', async () => {
    const verdict = {
      status: 'fail' as const,
      failure: 'rtp 0.91 outside 0.96±0.01',
      realizedRtp: 0.91,
      poolSize: 10000,
      rtpTarget: 0.96,
      rtpTolerance: 0.01,
      selfDerived: false,
    };
    restMock.buildGameDefinition.mockResolvedValue({ ok: false, errors: ['rtp out of band'], metrics: null, verdict, packageId: 'g1' });
    await openGameStructure('g1');
    await buildPackage();
    const b = gameStructureSlice().build.get({ noproxy: true });
    expect(b.status).toBe('error');
    expect(b.verdict).toEqual(verdict);
  });

  it('guards against a second concurrent call while the first is still flushing/building', async () => {
    await openGameStructure('g1');
    applyDefinition((d) => ({ ...d, start: 'base' })); // dirty -> flushPendingSave awaits putGameDefinition
    let resolvePut!: (doc: unknown) => void;
    restMock.putGameDefinition.mockImplementation(() => new Promise((resolve) => (resolvePut = resolve)));

    const p1 = buildPackage();
    const p2 = buildPackage(); // double-click before the first flush resolves
    resolvePut(wireDoc({ updatedAt: '2026-07-09T00:00:02Z' }));
    await Promise.all([p1, p2]);

    expect(restMock.buildGameDefinition).toHaveBeenCalledTimes(1);
  });
});

describe('applyBuildStatus', () => {
  it('mirrors auto-build progress into the build slice', () => {
    gameStructureSlice().activeGameId.set('g1');
    applyBuildStatus({ gameId: 'g1', status: 'building' });
    expect(gameStructureSlice().build.status.get()).toBe('building');
    applyBuildStatus({ gameId: 'g1', status: 'done', metrics: { rtp: 0.96 } as never, packageId: 'g1' });
    expect(gameStructureSlice().build.status.get()).toBe('done');
    applyBuildStatus({ gameId: 'other', status: 'error', errors: ['x'] });
    expect(gameStructureSlice().build.status.get()).toBe('done'); // inactive game ignored
    applyBuildStatus({ gameId: 'g1', status: 'error', errors: ['UnknownState'] });
    expect(gameStructureSlice().build.errors.get({ noproxy: true })).toEqual(['UnknownState']);
  });

  it('applyBuildStatus forwards the verdict from the auto-build event', () => {
    gameStructureSlice().activeGameId.set('g1');
    const verdict = { status: 'pass' as const, failure: null, realizedRtp: 0.9612, poolSize: 10000, rtpTarget: 0.96, rtpTolerance: 0.01, selfDerived: true };
    applyBuildStatus({ gameId: 'g1', status: 'done', metrics: { rtp: 0.96 } as never, verdict, packageId: 'g1' });
    expect(gameStructureSlice().build.verdict.get({ noproxy: true })).toEqual(verdict);
  });
});

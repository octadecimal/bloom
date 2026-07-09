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
  gameStructureSock: () => ({ connect: vi.fn(), disconnect: vi.fn(), join: vi.fn(), leave: vi.fn() }),
}));

import * as rest from './restClient';
import {
  SAVE_DEBOUNCE_MS,
  VALIDATE_DEBOUNCE_MS,
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
    restMock.buildGameDefinition.mockResolvedValue({ ok: false, errors: ['BadCaps'], metrics: null, packageId: 'g1' });
    await openGameStructure('g1');
    await buildPackage();
    const b = gameStructureSlice().build.get({ noproxy: true });
    expect(b.status).toBe('error');
    expect(b.errors).toEqual(['BadCaps']);
  });
});

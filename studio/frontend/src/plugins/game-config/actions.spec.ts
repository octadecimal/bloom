import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rootStore } from '../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from './state';
import type { ISlotModel } from './model';

const putSlotModel = vi.fn();
const getSlotModel = vi.fn();
const applyTemplate = vi.fn();
vi.mock('./restClient', () => ({
  putSlotModel: (...a: unknown[]) => putSlotModel(...a),
  getSlotModel: (...a: unknown[]) => getSlotModel(...a),
  applyTemplate: (...a: unknown[]) => applyTemplate(...a),
}));
vi.mock('./socketClient', () => ({
  gameConfigSock: () => ({ connect: vi.fn(), disconnect: vi.fn(), join: vi.fn(), leave: vi.fn() }),
  setModelChangedHandler: vi.fn(),
}));

import {
  SAVE_DEBOUNCE_MS,
  EXTERNAL_FLASH_MS,
  openGameConfig,
  applyModel,
  applyPresentation,
  applyModelFromJson,
  flushPendingSave,
  handleModelChanged,
  toggleLock,
  applyTemplateToGame,
} from './actions';

const MODEL: ISlotModel = {
  symbols: [{ id: 0, role: 'normal' }],
  reels: [[0, 0]],
  rows: 1,
  paylines: [[0]],
  paytable: { entries: [] },
  bonuses: [],
};

function doc(model: unknown, updatedAt: string, presentation: unknown = { symbols: {} }, locks?: unknown, shapeStale?: boolean) {
  return { id: 'd1', gameId: 'g1', model, presentation, updatedAt, ...(locks ? { locks } : {}), ...(shapeStale != null ? { shapeStale } : {}) };
}

describe('game-config actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    putSlotModel.mockReset();
    getSlotModel.mockReset();
    applyTemplate.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function open() {
    getSlotModel.mockResolvedValue(doc(MODEL, 't1'));
    await openGameConfig('g1');
  }

  it('openGameConfig hydrates model, presentation, jsonDraft and watermark', async () => {
    await open();
    const s = gameConfigSlice();
    expect(s.activeGameId.get()).toBe('g1');
    expect(s.model.get({ noproxy: true })).toEqual(MODEL);
    expect(s.watermark.get()).toBe('t1');
    expect(JSON.parse(s.jsonDraft.get())).toEqual(MODEL);
  });

  it('openGameConfig hydrates shapeStale from the doc, defaulting to false when absent', async () => {
    await open(); // doc without shapeStale
    expect(gameConfigSlice().shapeStale.get()).toBe(false);
    getSlotModel.mockResolvedValue(doc(MODEL, 't2', { symbols: {} }, undefined, true));
    await openGameConfig('g1');
    expect(gameConfigSlice().shapeStale.get()).toBe(true);
  });

  it('applyModel debounces a single PUT with source editor and marks saved', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2'));
    applyModel((m) => ({ ...m, rows: 2 }));
    applyModel((m) => ({ ...m, rows: 4 }));
    expect(gameConfigSlice().sync.get()).toBe('saving');
    expect(putSlotModel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(putSlotModel).toHaveBeenCalledTimes(1);
    const [gameId, patch] = putSlotModel.mock.calls[0];
    expect(gameId).toBe('g1');
    expect(patch.source).toBe('editor');
    expect(patch.model.rows).toBe(4);
    expect(patch.presentation).toBeUndefined();
    expect(gameConfigSlice().sync.get()).toBe('saved');
    expect(gameConfigSlice().watermark.get()).toBe('t2');
  });

  it('applyPresentation PUTs presentation only', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2'));
    applyPresentation((p) => ({ symbols: { ...p.symbols, '0': { label: 'Ace', color: 'sym-1' } } }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    const [, patch] = putSlotModel.mock.calls[0];
    expect(patch.model).toBeUndefined();
    expect(patch.presentation.symbols['0'].label).toBe('Ace');
  });

  it('a failed PUT sets sync=error', async () => {
    await open();
    putSlotModel.mockRejectedValue(new Error('boom'));
    applyModel((m) => ({ ...m, rows: 2 }));
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(gameConfigSlice().sync.get()).toBe('error');
  });

  it('applyModelFromJson: invalid JSON sets jsonError and saves nothing', async () => {
    await open();
    expect(applyModelFromJson('not json')).toBe(false);
    expect(gameConfigSlice().jsonError.get()).toBeTruthy();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(putSlotModel).not.toHaveBeenCalled();
  });

  it('applyModelFromJson: valid JSON replaces the model and saves', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2'));
    expect(applyModelFromJson(JSON.stringify({ ...MODEL, rows: 7 }))).toBe(true);
    expect(gameConfigSlice().jsonError.get()).toBeNull();
    expect(gameConfigSlice().model.rows.get()).toBe(7);
    await flushPendingSave();
    expect(putSlotModel).toHaveBeenCalledTimes(1);
  });

  it('handleModelChanged ignores own editor echo (watermark only)', async () => {
    await open();
    handleModelChanged({ gameId: 'g1', updatedAt: 't5', source: 'editor' });
    expect(gameConfigSlice().watermark.get()).toBe('t5');
    expect(getSlotModel).toHaveBeenCalledTimes(1); // only the open() call
  });

  it('handleModelChanged ignores stale external events', async () => {
    await open();
    handleModelChanged({ gameId: 'g1', updatedAt: 't0', source: 'tuner' });
    expect(getSlotModel).toHaveBeenCalledTimes(1);
  });

  it('handleModelChanged re-hydrates on a newer external write and flashes external', async () => {
    await open();
    const external = { ...MODEL, rows: 9 };
    getSlotModel.mockResolvedValue(doc(external, 't9'));
    handleModelChanged({ gameId: 'g1', updatedAt: 't9', source: 'tuner' });
    await vi.advanceTimersByTimeAsync(1); // let the async re-hydrate resolve
    const s = gameConfigSlice();
    expect(s.model.rows.get()).toBe(9);
    expect(s.watermark.get()).toBe('t9');
    expect(s.sync.get()).toBe('external');
    expect(s.externalSource.get()).toBe('tuner');
    await vi.advanceTimersByTimeAsync(EXTERNAL_FLASH_MS + 10);
    expect(s.sync.get()).toBe('saved');
  });

  it('openGameConfig hydrates locks, defaulting to all-unlocked when absent', async () => {
    await open(); // doc without locks
    expect(gameConfigSlice().locks.get({ noproxy: true })).toEqual({ reels: false, paytable: false, bonus: false });
    getSlotModel.mockResolvedValue(doc(MODEL, 't2', { symbols: {} }, { reels: true, paytable: false, bonus: false }));
    await openGameConfig('g1');
    expect(gameConfigSlice().locks.reels.get()).toBe(true);
  });

  it('toggleLock flips the lock and debounce-PUTs locks only', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2', { symbols: {} }, { reels: false, paytable: true, bonus: false }));
    toggleLock('paytable');
    expect(gameConfigSlice().locks.paytable.get()).toBe(true);
    expect(gameConfigSlice().sync.get()).toBe('saving');
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 10);
    expect(putSlotModel).toHaveBeenCalledTimes(1);
    const [, patch] = putSlotModel.mock.calls[0];
    expect(patch.locks).toEqual({ reels: false, paytable: true, bonus: false });
    expect(patch.model).toBeUndefined();
    expect(patch.source).toBe('editor');
    expect(gameConfigSlice().sync.get()).toBe('saved');
  });

  it('applyTemplateToGame hydrates the returned doc and swallows the template socket echo', async () => {
    await open();
    const merged = { ...MODEL, rows: 5 };
    applyTemplate.mockResolvedValue(doc(merged, 't3', { symbols: {} }, { reels: false, paytable: true, bonus: false }));
    await applyTemplateToGame('video-5x3');
    expect(applyTemplate).toHaveBeenCalledWith('g1', 'video-5x3');
    const s = gameConfigSlice();
    expect(s.model.rows.get()).toBe(5);
    expect(s.watermark.get()).toBe('t3');
    expect(s.sync.get()).toBe('saved');
    // the slot_model_changed echo (source "template", same updatedAt) must not re-hydrate
    handleModelChanged({ gameId: 'g1', updatedAt: 't3', source: 'template' });
    expect(getSlotModel).toHaveBeenCalledTimes(1); // only the open() call
    expect(s.sync.get()).toBe('saved');
  });

  it('applyTemplateToGame flushes a pending debounced lock save before applying the template', async () => {
    await open();
    putSlotModel.mockResolvedValue(doc(MODEL, 't2', { symbols: {} }, { reels: false, paytable: true, bonus: false }));
    const applied = { ...MODEL, rows: 3 };
    applyTemplate.mockResolvedValue(doc(applied, 't3', { symbols: {} }, { reels: false, paytable: true, bonus: false }));

    toggleLock('paytable'); // starts the debounce; do NOT advance timers past it
    await applyTemplateToGame('video-5x3');

    expect(putSlotModel).toHaveBeenCalledTimes(1);
    const [, patch] = putSlotModel.mock.calls[0];
    expect(patch.locks.paytable).toBe(true);
    expect(putSlotModel.mock.invocationCallOrder[0]).toBeLessThan(applyTemplate.mock.invocationCallOrder[0]);

    const s = gameConfigSlice();
    expect(s.model.rows.get()).toBe(3);
    expect(s.watermark.get()).toBe('t3');
  });

  it('a failed applyTemplateToGame sets sync=error', async () => {
    await open();
    applyTemplate.mockRejectedValue(new Error('boom'));
    await applyTemplateToGame('classic-3x3');
    expect(gameConfigSlice().sync.get()).toBe('error');
  });
});

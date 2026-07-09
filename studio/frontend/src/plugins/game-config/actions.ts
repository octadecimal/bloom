import { gameConfigSlice, defaultLocks, type ISectionLocks } from './state';
import { getSlotModel, putSlotModel, applyTemplate, type ISlotModelWireDoc, type IPutSlotModelPatch } from './restClient';
import { normalizeModel, type ISlotModel } from './model';
import { normalizePresentation, type IPresentation } from './presentation';
import { gameConfigSock, setModelChangedHandler, type IModelChangedEvent } from './socketClient';

export const SAVE_DEBOUNCE_MS = 600;
export const EXTERNAL_FLASH_MS = 4000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = { model: false, presentation: false, locks: false };

export function initGameConfig(): void {
  gameConfigSock().connect();
  setModelChangedHandler(handleModelChanged);
}

function hydrateDoc(doc: ISlotModelWireDoc): void {
  const s = gameConfigSlice();
  const model = normalizeModel(doc.model);
  s.model.set(model);
  s.presentation.set(normalizePresentation(doc.presentation));
  s.locks.set({ ...defaultLocks(), ...(doc.locks ?? {}) });
  s.jsonDraft.set(JSON.stringify(model, null, 2));
  s.jsonError.set(null);
  s.shapeStale.set(!!doc.shapeStale);
  if (doc.updatedAt > s.watermark.get()) s.watermark.set(doc.updatedAt);
}

export async function openGameConfig(gameId: string): Promise<void> {
  const s = gameConfigSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  gameConfigSock().join(gameId);
  try {
    hydrateDoc(await getSlotModel(gameId));
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameConfig(): void {
  const s = gameConfigSlice();
  const prev = s.activeGameId.get();
  if (prev) gameConfigSock().leave(prev);
  if (saveTimer) clearTimeout(saveTimer);
  if (flashTimer) clearTimeout(flashTimer);
  saveTimer = null;
  flashTimer = null;
  dirty = { model: false, presentation: false, locks: false };
  s.activeGameId.set(null);
  s.model.set(null);
  s.presentation.set({ symbols: {} });
  s.locks.set(defaultLocks());
  s.jsonDraft.set('');
  s.jsonError.set(null);
  s.sync.set('idle');
  s.externalSource.set(null);
  s.watermark.set('');
  s.loadStatus.set('idle');
  s.shapeStale.set(false);
}

function scheduleSave(kind: 'model' | 'presentation' | 'locks'): void {
  dirty[kind] = true;
  gameConfigSlice().sync.set('saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushPendingSave(), SAVE_DEBOUNCE_MS);
}

export async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = gameConfigSlice();
  const gameId = s.activeGameId.get();
  if (!gameId || (!dirty.model && !dirty.presentation && !dirty.locks)) return;
  const patch: IPutSlotModelPatch = { source: 'editor' };
  if (dirty.model) patch.model = s.model.get({ noproxy: true }) as ISlotModel;
  if (dirty.presentation) patch.presentation = s.presentation.get({ noproxy: true }) as IPresentation;
  if (dirty.locks) patch.locks = s.locks.get({ noproxy: true }) as ISectionLocks;
  dirty = { model: false, presentation: false, locks: false };
  try {
    const doc = await putSlotModel(gameId, patch);
    if (doc.updatedAt > s.watermark.get()) s.watermark.set(doc.updatedAt);
    if (s.sync.get() === 'saving') s.sync.set('saved');
  } catch {
    s.sync.set('error');
  }
}

export function applyModel(fn: (m: ISlotModel) => ISlotModel): void {
  const s = gameConfigSlice();
  const current = s.model.get({ noproxy: true }) as ISlotModel | null;
  if (!current) return;
  const next = fn(current);
  s.model.set(next);
  s.jsonDraft.set(JSON.stringify(next, null, 2));
  scheduleSave('model');
}

export function applyPresentation(fn: (p: IPresentation) => IPresentation): void {
  const s = gameConfigSlice();
  const next = fn(s.presentation.get({ noproxy: true }) as IPresentation);
  s.presentation.set(next);
  scheduleSave('presentation');
}

export function toggleLock(section: keyof ISectionLocks): void {
  const s = gameConfigSlice();
  s.locks[section].set(!s.locks[section].get());
  scheduleSave('locks');
}

/** JSON tab Apply. Returns false (and sets jsonError) on a parse failure. */
export function applyModelFromJson(text: string): boolean {
  const s = gameConfigSlice();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    s.jsonError.set(e instanceof Error ? e.message : 'invalid JSON');
    return false;
  }
  s.jsonError.set(null);
  applyModel(() => normalizeModel(parsed));
  return true;
}

/** Apply-template confirm. Hydrating the POST response advances the watermark,
 * so the source:"template" socket echo is swallowed (no external flash here). */
export async function applyTemplateToGame(name: string): Promise<void> {
  const s = gameConfigSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  await flushPendingSave(); // land any pending lock/model/presentation PUT before the template merge reads persisted state
  try {
    hydrateDoc(await applyTemplate(gameId, name));
    s.sync.set('saved');
  } catch {
    s.sync.set('error');
  }
}

export function handleModelChanged(p: IModelChangedEvent): void {
  const s = gameConfigSlice();
  if (s.activeGameId.get() !== p.gameId) return;
  if (p.source === 'editor') {
    if (p.updatedAt > s.watermark.get()) s.watermark.set(p.updatedAt);
    return;
  }
  if (p.updatedAt <= s.watermark.get()) return;
  void rehydrateExternal(p.source);
}

async function rehydrateExternal(source: string): Promise<void> {
  const s = gameConfigSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    hydrateDoc(await getSlotModel(gameId));
  } catch {
    return; // transient fetch failure: keep current state
  }
  s.sync.set('external');
  s.externalSource.set(source);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (gameConfigSlice().sync.get() === 'external') gameConfigSlice().sync.set('saved');
  }, EXTERNAL_FLASH_MS);
}

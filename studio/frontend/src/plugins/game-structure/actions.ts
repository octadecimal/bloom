import { gameStructureSlice, makeInitialState } from './state';
import {
  getGameDefinition,
  putGameDefinition,
  validateGameDefinition,
  buildGameDefinition,
  type IGameDefinitionWireDoc,
  type IPutGameDefinitionPatch,
} from './restClient';
import { normalizeDefinition, type IGameDefinition } from './model';
import { gameStructureSock, setDefinitionChangedHandler, type IDefinitionChangedEvent } from './socketClient';

export const SAVE_DEBOUNCE_MS = 600;
export const VALIDATE_DEBOUNCE_MS = 800;
export const EXTERNAL_FLASH_MS = 4000;

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;
let validateTimer: ReturnType<typeof setTimeout> | null = null;
let validateEpoch = 0; // drop out-of-order responses
let dirty = { definition: false, presentation: false };

export function initGameStructure(): void {
  gameStructureSock().connect();
  setDefinitionChangedHandler(handleDefinitionChanged);
}

function draftFor(definition: IGameDefinition, presentation: Record<string, unknown>): string {
  return JSON.stringify({ definition, presentation }, null, 2);
}

function hydrateDoc(doc: IGameDefinitionWireDoc): void {
  const s = gameStructureSlice();
  const definition = normalizeDefinition(doc.definition);
  const presentation = (doc.presentation ?? {}) as Record<string, unknown>;
  s.definition.set(definition);
  s.presentation.set(presentation);
  s.jsonDraft.set(draftFor(definition, presentation));
  s.jsonError.set(null);
  if (doc.updatedAt > s.watermark.get()) s.watermark.set(doc.updatedAt);
}

export async function openGameStructure(gameId: string): Promise<void> {
  const s = gameStructureSlice();
  s.activeGameId.set(gameId);
  s.loadStatus.set('loading');
  gameStructureSock().join(gameId);
  try {
    hydrateDoc(await getGameDefinition(gameId));
    s.loadStatus.set('idle');
  } catch {
    s.loadStatus.set('error');
  }
}

export function closeGameStructure(): void {
  const s = gameStructureSlice();
  const prev = s.activeGameId.get();
  if (prev) gameStructureSock().leave(prev);
  if (saveTimer) clearTimeout(saveTimer);
  if (flashTimer) clearTimeout(flashTimer);
  if (validateTimer) clearTimeout(validateTimer);
  saveTimer = null;
  flashTimer = null;
  validateTimer = null;
  dirty = { definition: false, presentation: false };
  validateEpoch++;
  s.set(makeInitialState());
}

function scheduleSave(kind: 'definition' | 'presentation'): void {
  dirty[kind] = true;
  gameStructureSlice().sync.set('saving');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushPendingSave(), SAVE_DEBOUNCE_MS);
}

export async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const s = gameStructureSlice();
  const gameId = s.activeGameId.get();
  if (!gameId || (!dirty.definition && !dirty.presentation)) return;
  const patch: IPutGameDefinitionPatch = { source: 'editor' };
  if (dirty.definition) patch.definition = s.definition.get({ noproxy: true }) as IGameDefinition;
  if (dirty.presentation) patch.presentation = s.presentation.get({ noproxy: true }) as Record<string, unknown>;
  dirty = { definition: false, presentation: false };
  try {
    const doc = await putGameDefinition(gameId, patch);
    if (doc.updatedAt > s.watermark.get()) s.watermark.set(doc.updatedAt);
    if (s.sync.get() === 'saving') s.sync.set('saved');
  } catch {
    s.sync.set('error');
  }
}

export function applyDefinition(fn: (d: IGameDefinition) => IGameDefinition): void {
  const s = gameStructureSlice();
  const current = s.definition.get({ noproxy: true }) as IGameDefinition | null;
  if (!current) return;
  const next = fn(current);
  s.definition.set(next);
  s.jsonDraft.set(draftFor(next, s.presentation.get({ noproxy: true }) as Record<string, unknown>));
  scheduleSave('definition');
  scheduleValidate();
}

function scheduleValidate(): void {
  if (validateTimer) clearTimeout(validateTimer);
  gameStructureSlice().validation.status.set('checking');
  validateTimer = setTimeout(() => void requestValidate(), VALIDATE_DEBOUNCE_MS);
}

export async function requestValidate(): Promise<void> {
  const s = gameStructureSlice();
  const gameId = s.activeGameId.get();
  const definition = s.definition.get({ noproxy: true }) as IGameDefinition | null;
  if (!gameId || !definition) return;
  const epoch = ++validateEpoch;
  try {
    const res = await validateGameDefinition(gameId, definition);
    if (epoch !== validateEpoch) return;
    s.validation.set(res.ok ? { status: 'ok', errors: [] } : { status: 'errors', errors: res.errors });
  } catch {
    if (epoch === validateEpoch) s.validation.set({ status: 'idle', errors: [] }); // transient; don't scare the user
  }
}

/** JSON tab Apply: whole-doc {definition, presentation}. Returns false (and sets jsonError) on a parse failure. */
export function applyDocFromJson(text: string): boolean {
  const s = gameStructureSlice();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    s.jsonError.set(e instanceof Error ? e.message : 'invalid JSON');
    return false;
  }
  s.jsonError.set(null);
  const obj = (parsed ?? {}) as { definition?: unknown; presentation?: unknown };
  const definition = normalizeDefinition(obj.definition);
  const presentation = (obj.presentation ?? {}) as Record<string, unknown>;
  s.presentation.set(presentation);
  scheduleSave('presentation');
  applyDefinition(() => definition);
  return true;
}

export async function buildPackage(): Promise<void> {
  const s = gameStructureSlice();
  const gameId = s.activeGameId.get();
  if (!gameId || s.build.status.get() === 'building') return;
  s.build.set({ status: 'building', metrics: null, errors: [] });
  try {
    await flushPendingSave(); // build reads the STORED doc — persist edits first
    const res = await buildGameDefinition(gameId);
    if (res.ok) s.build.set({ status: 'done', metrics: res.metrics, errors: [] });
    else s.build.set({ status: 'error', metrics: null, errors: res.errors ?? ['build failed'] });
  } catch (e) {
    s.build.set({ status: 'error', metrics: null, errors: [e instanceof Error ? e.message : 'build failed'] });
  }
}

export function handleDefinitionChanged(p: IDefinitionChangedEvent): void {
  const s = gameStructureSlice();
  if (s.activeGameId.get() !== p.gameId) return;
  if (p.source === 'editor') {
    if (p.updatedAt > s.watermark.get()) s.watermark.set(p.updatedAt);
    return;
  }
  if (p.updatedAt <= s.watermark.get()) return;
  void rehydrateExternal(p.source);
}

async function rehydrateExternal(source: string): Promise<void> {
  const s = gameStructureSlice();
  const gameId = s.activeGameId.get();
  if (!gameId) return;
  try {
    hydrateDoc(await getGameDefinition(gameId));
  } catch {
    return; // transient fetch failure: keep current state
  }
  s.sync.set('external');
  s.externalSource.set(source);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (gameStructureSlice().sync.get() === 'external') gameStructureSlice().sync.set('saved');
  }, EXTERNAL_FLASH_MS);
}

import type { JsonValue } from '../../scene/types';
import { gameSlice } from '../game/state';
import { emitSceneApplyOp } from '../game/socketClient';

// Impure write seam: send one setProp for the active game. No-op with no
// active game. Kept tiny + swappable so the widget depends on this, not on
// socket internals.
export function commitSetProp(nodeId: string, path: string, value: JsonValue): void {
  const gameId = gameSlice().activeGameId.get();
  if (!gameId) return;
  emitSceneApplyOp(gameId, { kind: 'setProp', id: nodeId, path, value });
}

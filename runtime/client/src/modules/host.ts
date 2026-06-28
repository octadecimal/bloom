import type { GraphModel } from '../model/graphModel';
import type { Reconciler } from '../render/reconciler';
import type { IRenderer } from '../render/renderer';
import type { IEventBus } from '../orchestration/bus';
import type { IModuleHost } from './module';
import { OpError } from '../model/ops';

/** Binds the two-plane seam to the concrete engine: model (+reconciler) for the
 *  structure plane, renderer for the behavior plane, bus for events (spec §2.3, §6.1). */
export function createModuleHost(deps: { model: GraphModel; reconciler: Reconciler; renderer: IRenderer; bus: IEventBus }): IModuleHost {
  return {
    snapshot: () => deps.model.toDocument(),
    emit: (ops) => {
      if (ops.length === 0) return;
      let changes;
      try {
        changes = deps.model.applyBatch(ops); // atomic — throws + rolls back on failure
      } catch (err) {
        // Swallow only the expected transient: a module projecting before its
        // parent node exists in the document (unknown_node). All other OpError
        // codes and non-OpError exceptions indicate real bugs and must propagate.
        if (err instanceof OpError && err.code === 'unknown_node') {
          console.warn('[module-host] emit skipped (parent not yet present)', err);
          return;
        }
        throw err;
      }
      void deps.reconciler.applyChanges(changes).catch((err) => console.error('[module-host] reconcile failed', err));
    },
    resolve: (id) => deps.renderer.getHandle(id),
    onTick: (cb) => deps.renderer.onTick(cb),
    bus: deps.bus,
  };
}

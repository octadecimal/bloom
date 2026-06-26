export type BusHandler<T = unknown> = (payload: T) => void;

/** A minimal typed pub/sub seam. Swappable for mitt/eventemitter3 later
 *  without changing call sites (see spec §8). */
export interface IEventBus {
  on<T = unknown>(event: string, handler: BusHandler<T>): () => void;
  off(event: string, handler: BusHandler): void;
  emit<T = unknown>(event: string, payload: T): void;
}

export function createBus(): IEventBus {
  const handlers = new Map<string, Set<BusHandler>>();
  const bus: IEventBus = {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as BusHandler);
      return () => bus.off(event, handler as BusHandler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      // Snapshot so a handler that unsubscribes mid-emit doesn't perturb iteration.
      const set = handlers.get(event);
      if (!set) return;
      for (const h of [...set]) h(payload);
    },
  };
  return bus;
}

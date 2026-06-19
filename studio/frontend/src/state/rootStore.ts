import { hookstate } from '@hookstate/core';
import type { ExtensionFactory } from '@hookstate/core';

export interface IWorkspaceState {
  theme: 'light' | 'dark'; // dockview owns layout AND active-pane state
}

export interface IRootState {
  workspace: IWorkspaceState;
  plugins: Record<string, unknown>; // plugins[id] = that plugin's slice; typed at the hook
}

// Module-level listener set: any subscriber registered via onRootStoreSet will
// be called whenever any part of the store is mutated (path-agnostic). Per-slice
// filtering is handled downstream by the debounced savers in persistSlices.ts.
type RootSetListener = () => void;
const rootSetListeners = new Set<RootSetListener>();

export function onRootStoreSet(cb: RootSetListener): () => void {
  rootSetListeners.add(cb);
  return () => {
    rootSetListeners.delete(cb);
  };
}

// Extension factory: fires all registered listeners on every onSet event.
// The extension adds no extra methods to the state (E = {}), so all existing
// .get()/.set()/.merge()/.nested() semantics are completely unchanged.
const notifyExtension: ExtensionFactory<IRootState, {}, {}> = () => ({
  onSet: () => {
    rootSetListeners.forEach((cb) => cb());
  },
});

// Created once, at module scope — not in React, never in a Context.
export const rootStore = hookstate<IRootState, {}>({ workspace: { theme: 'dark' }, plugins: {} }, notifyExtension);

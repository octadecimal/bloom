import type { DockviewApi } from 'dockview-react';

let current: DockviewApi | null = null;
const listeners = new Set<() => void>();

export function setDockviewApi(api: DockviewApi): void {
  current = api;
  listeners.forEach((l) => l());
}

export function getDockviewApi(): DockviewApi | null {
  return current;
}

export function onDockviewApiChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function _resetDockviewApiForTests(): void {
  current = null;
  listeners.clear();
}

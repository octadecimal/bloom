import { hookstate } from '@hookstate/core';

export interface IWorkspaceState {
  theme: 'light' | 'dark'; // dockview owns layout AND active-pane state
}

export interface IRootState {
  workspace: IWorkspaceState;
  plugins: Record<string, unknown>; // plugins[id] = that plugin's slice; typed at the hook
}

// Created once, at module scope — not in React, never in a Context.
export const rootStore = hookstate<IRootState>({
  workspace: { theme: 'dark' },
  plugins: {},
});

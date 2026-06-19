import type { ComponentType } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';

export interface IPaneDef {
  id: string; // namespaced: `${pluginId}/${key}`
  title: string;
  component: ComponentType<IDockviewPanelProps>;
}

export interface ICommandDef {
  id: string; // namespaced
  title: string;
  run(host: IPluginHost): void;
}

export interface IPlugin<TState = unknown> {
  id: string;
  title: string;
  initialState?: TState; // seeds rootStore.plugins[id] before init()
  persist?: boolean; // default false; opt into UI-preference persistence
  panes: IPaneDef[];
  commands?: ICommandDef[];
  init?(host: IPluginHost): void;
  dispose?(host: IPluginHost): void; // for the dynamic-unload future
}

export interface IPluginHost {
  registerPane(def: IPaneDef): void;
  registerCommand(def: ICommandDef): void;
  openPane(paneId: string): void; // singleton: focus if open, else create
  runCommand(commandId: string): void;
  listPanes(): IPaneDef[];
  listCommands(): ICommandDef[];
  resetLayout(): void;
}

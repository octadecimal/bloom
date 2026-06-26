import type { State } from '@hookstate/core';
import { rootStore } from '../../state/rootStore';
import { makePluginHooks } from '../../state/makePluginHooks';

export const PROPERTY_INSPECTOR_PLUGIN_ID = 'property-inspector';

export interface IPropertyInspectorState {
  collapsed: Record<string, boolean>; // prop path -> true when collapsed; absent = expanded
}

export function makeInitialState(): IPropertyInspectorState {
  return { collapsed: {} };
}

export const propertyInspectorHooks = makePluginHooks<IPropertyInspectorState>(PROPERTY_INSPECTOR_PLUGIN_ID);

export function propertyInspectorSlice(): State<IPropertyInspectorState> {
  return rootStore.plugins.nested(PROPERTY_INSPECTOR_PLUGIN_ID) as unknown as State<IPropertyInspectorState>;
}

import type { IPlugin } from '../host/types';
import { sceneStorePlugin } from '../scene/plugin';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';
import { assets } from './assets';
import { gdd } from './gdd';
import { game } from './game';
import { gameConfig } from './game-config';
import { gameStructure } from './game-structure';
import { sceneGraph } from './scene-graph';
import { propertyInspector } from './property-inspector';
import { regionOverrides } from './region-overrides';
import { math } from './math';

export const PLUGINS: IPlugin[] = [
  sceneStorePlugin,
  llmChat,
  assets,
  gdd,
  game,
  gameConfig,
  gameStructure,
  sceneGraph,
  propertyInspector,
  regionOverrides,
  math,
];

// Demo panes are dev-only fixtures (used by e2e chrome/panes/keyboard specs,
// which run against the dev server).
if (!import.meta.env.PROD) {
  PLUGINS.push(demoCounter, demoScratch);
}

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
  demoCounter,
  demoScratch,
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

import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';
import { assets } from './assets';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat, assets];

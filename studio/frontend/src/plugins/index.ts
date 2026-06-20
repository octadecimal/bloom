import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';
import { llmChat } from './llm-chat';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch, llmChat];

import type { IPlugin } from '../host/types';
import { demoCounter } from './demo-counter';
import { demoScratch } from './demo-scratch';

export const PLUGINS: IPlugin[] = [demoCounter, demoScratch];

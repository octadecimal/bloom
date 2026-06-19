import type { IPluginHost } from '../host/types';

let current: IPluginHost | null = null;

export function setHost(h: IPluginHost): void {
  current = h;
}

export function getHost(): IPluginHost {
  if (!current)
    throw new Error('Host not initialised — call setHost() during boot.');
  return current;
}

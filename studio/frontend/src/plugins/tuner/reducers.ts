import type { ITuneResult, ITunerState } from './state';

export function statusFromResult(r: ITuneResult): ITunerState['status'] {
  return r.status; // 'pass' | 'near_miss' | 'error'
}

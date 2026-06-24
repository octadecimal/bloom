import type { ICurationResult, ISimulatorState } from './state';

export function statusFromResult(r: ICurationResult): ISimulatorState['status'] {
  return r.status; // 'pass' | 'fail' | 'error'
}

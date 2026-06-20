import { describe, it, expect, vi, beforeEach } from 'vitest';

const toastError = vi.fn();
const toastInfo = vi.fn();
vi.mock('sonner', () => ({
  toast: { error: (m: string) => toastError(m), info: (m: string) => toastInfo(m) },
}));

import { notify } from './notify';

describe('notify seam', () => {
  beforeEach(() => {
    toastError.mockClear();
    toastInfo.mockClear();
  });

  it('delegates error() to sonner toast.error', () => {
    notify.error('boom');
    expect(toastError).toHaveBeenCalledWith('boom');
  });

  it('delegates info() to sonner toast.info', () => {
    notify.info('hello');
    expect(toastInfo).toHaveBeenCalledWith('hello');
  });
});

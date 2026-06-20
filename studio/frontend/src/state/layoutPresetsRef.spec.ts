import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setLayoutPresets, getLayoutPresets } from './layoutPresetsRef';
import { setSaveLayoutOpener, openSaveLayoutDialog } from './saveLayoutDialogRef';
import type { ILayoutPresetsService } from '../host/layoutPresets';

const svc = { saveAs: vi.fn(), apply: vi.fn(), list: vi.fn(() => []), delete: vi.fn() } as ILayoutPresetsService;

describe('layoutPresetsRef', () => {
  it('round-trips the service', () => {
    setLayoutPresets(svc);
    expect(getLayoutPresets()).toBe(svc);
  });
});

describe('saveLayoutDialogRef', () => {
  beforeEach(() => setSaveLayoutOpener(() => {}));
  it('invokes the registered opener', () => {
    const open = vi.fn();
    setSaveLayoutOpener(open);
    openSaveLayoutDialog();
    expect(open).toHaveBeenCalledTimes(1);
  });
  it('is a no-op when no opener is registered yet', () => {
    expect(() => openSaveLayoutDialog()).not.toThrow();
  });
});

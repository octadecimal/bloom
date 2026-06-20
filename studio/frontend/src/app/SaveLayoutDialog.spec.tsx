import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const saveAs = vi.fn();
vi.mock('../state/layoutPresetsRef', () => ({
  getLayoutPresets: () => ({ saveAs, apply: vi.fn(), list: () => [], delete: vi.fn() }),
}));

import { SaveLayoutDialog } from './SaveLayoutDialog';

describe('SaveLayoutDialog', () => {
  beforeEach(() => saveAs.mockReset());

  it('calls saveAs with the typed name and closes on success', () => {
    saveAs.mockReturnValue(true);
    const onOpenChange = vi.fn();
    render(<SaveLayoutDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByTestId('save-layout-name'), { target: { value: 'My view' } });
    fireEvent.click(screen.getByTestId('save-layout-confirm'));
    expect(saveAs).toHaveBeenCalledWith('My view');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('stays open when saveAs is rejected', () => {
    saveAs.mockReturnValue(false);
    const onOpenChange = vi.fn();
    render(<SaveLayoutDialog open onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByTestId('save-layout-name'), { target: { value: 'Chat' } });
    fireEvent.click(screen.getByTestId('save-layout-confirm'));
    expect(saveAs).toHaveBeenCalledWith('Chat');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

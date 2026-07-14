import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setHost } from '../state/hostRef';
import { CommandPalette } from './CommandPalette';
import type { IPluginHost } from '../host/types';

const openPane = vi.fn();
const runCommand = vi.fn();

function fakeHost(): IPluginHost {
  return {
    registerPane: vi.fn(),
    registerCommand: vi.fn(),
    openPane,
    runCommand,
    listPanes: () => [
      { id: 'gdd/viewer', title: 'Game Design Doc', component: () => null },
      { id: 'assets/board', title: 'Asset Board', component: () => null },
    ],
    listCommands: () => [{ id: 'shell/reset-layout', title: 'Reset layout', run: vi.fn() }],
    resetLayout: vi.fn(),
  };
}

beforeEach(() => {
  openPane.mockClear();
  runCommand.mockClear();
  setHost(fakeHost());
});

describe('CommandPalette', () => {
  it('lists an "Open <title>" entry for every registered pane plus all commands', () => {
    render(<CommandPalette open onOpenChange={() => {}} />);
    expect(screen.getByText('Open Game Design Doc')).toBeTruthy();
    expect(screen.getByText('Open Asset Board')).toBeTruthy();
    expect(screen.getByText('Reset layout')).toBeTruthy();
  });

  it('selecting an Open entry opens the pane and closes the palette', () => {
    const onOpenChange = vi.fn();
    render(<CommandPalette open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText('Open Asset Board'));
    expect(openPane).toHaveBeenCalledWith('assets/board');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when closed', () => {
    render(<CommandPalette open={false} onOpenChange={() => {}} />);
    expect(screen.queryByTestId('command-input')).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const resetLayout = vi.fn();
const apply = vi.fn();
const del = vi.fn();
vi.mock('../state/hostRef', () => ({
  getHost: () => ({ listPanes: () => [], openPane: vi.fn(), resetLayout }),
}));
vi.mock('../state/layoutPresetsRef', () => ({
  getLayoutPresets: () => ({
    list: () => [
      { name: 'Chat', kind: 'builtin' },
      { name: 'My view', kind: 'user' },
    ],
    apply,
    delete: del,
    saveAs: vi.fn(),
    onPresetsChange: () => () => {},
  }),
}));

import { AppMenubar } from './Menubar';

describe('AppMenubar — Layout menu', () => {
  beforeEach(() => {
    resetLayout.mockReset();
    apply.mockReset();
    del.mockReset();
  });

  it('applies a preset, deletes a user preset, and resets — and has no File menu', async () => {
    const user = userEvent.setup();
    render(<AppMenubar />);
    expect(screen.queryByTestId('menu-file')).toBeNull();

    await user.click(screen.getByTestId('menu-layout'));
    await user.click(screen.getByTestId('layout-apply-Chat'));
    expect(apply).toHaveBeenCalledWith('Chat');

    await user.click(screen.getByTestId('menu-layout'));
    await user.click(screen.getByTestId('layout-delete-My view'));
    expect(del).toHaveBeenCalledWith('My view');

    await user.click(screen.getByTestId('menu-layout'));
    await user.click(screen.getByTestId('menu-reset-layout'));
    expect(resetLayout).toHaveBeenCalledTimes(1);
  });

  it('shows no delete item for a built-in preset', async () => {
    const user = userEvent.setup();
    render(<AppMenubar />);
    await user.click(screen.getByTestId('menu-layout'));
    expect(screen.queryByTestId('layout-delete-Chat')).toBeNull();
  });
});

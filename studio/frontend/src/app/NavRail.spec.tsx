import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { setHost } from '../state/hostRef';
import { setDockviewApi, _resetDockviewApiForTests } from '../state/dockviewApiRef';
import { NavRail } from './NavRail';
import type { IPluginHost } from '../host/types';
import type { DockviewApi } from 'dockview-react';

const openPane = vi.fn();

function fakeHost(panes: Array<{ id: string; title: string }>): IPluginHost {
  return {
    registerPane: vi.fn(),
    registerCommand: vi.fn(),
    openPane,
    runCommand: vi.fn(),
    listPanes: () => panes.map((p) => ({ ...p, component: () => null }) as never),
    listCommands: () => [],
    resetLayout: vi.fn(),
  };
}

const PANES = [
  { id: 'llm-chat/room', title: 'Chat Room' },
  { id: 'llm-chat/settings', title: 'Chat Settings' },
  { id: 'llm-chat/skill-editor', title: 'Skill Editor' },
  { id: 'gdd/viewer', title: 'Game Design Doc' },
  { id: 'game/preview', title: 'Game Scene' },
  { id: 'assets/board', title: 'Asset Board' },
  { id: 'math/viewer', title: 'Math' },
];

beforeEach(() => {
  openPane.mockClear();
  _resetDockviewApiForTests();
  localStorage.clear();
  setHost(fakeHost(PANES));
});

describe('NavRail', () => {
  it('renders one launcher per registered pane, curated order first, utilities last', () => {
    render(<NavRail />);
    const ids = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('data-testid'))
      .filter((id) => id?.startsWith('rail-open-'));
    expect(ids).toEqual([
      'rail-open-llm-chat/room',
      'rail-open-gdd/viewer',
      'rail-open-game/preview',
      'rail-open-assets/board',
      'rail-open-math/viewer',
      'rail-open-llm-chat/settings',
      'rail-open-llm-chat/skill-editor',
    ]);
  });

  it('puts unknown panes at the end of the top stack with a letter fallback', () => {
    setHost(fakeHost([...PANES, { id: 'mystery/pane', title: 'Zephyr' }]));
    render(<NavRail />);
    const btn = screen.getByTestId('rail-open-mystery/pane');
    expect(btn).toHaveTextContent('Z');
    const ids = screen.getAllByRole('button').map((b) => b.getAttribute('data-testid'));
    // after the curated top groups, before the bottom-anchored utilities
    expect(ids.indexOf('rail-open-mystery/pane')).toBeGreaterThan(ids.indexOf('rail-open-math/viewer'));
    expect(ids.indexOf('rail-open-mystery/pane')).toBeLessThan(ids.indexOf('rail-open-llm-chat/settings'));
  });

  it('clicking a launcher opens that pane', () => {
    render(<NavRail />);
    fireEvent.click(screen.getByTestId('rail-open-math/viewer'));
    expect(openPane).toHaveBeenCalledWith('math/viewer');
  });

  it('tints the active pane and brightens open panes once the Dockview api attaches', () => {
    render(<NavRail />);
    // before attach: everything renders in the closed tier
    expect(screen.getByTestId('rail-open-game/preview').className).toContain('text-muted-foreground');

    const api = {
      getPanel: (id: string) => (id === 'game/preview' || id === 'llm-chat/room' ? {} : undefined),
      activePanel: { id: 'game/preview' },
      onDidLayoutChange: () => ({ dispose: vi.fn() }),
      onDidActivePanelChange: () => ({ dispose: vi.fn() }),
    } as unknown as DockviewApi;
    act(() => setDockviewApi(api));

    expect(screen.getByTestId('rail-open-game/preview').className).toContain('bg-selection');
    expect(screen.getByTestId('rail-open-llm-chat/room').className).toContain('text-foreground');
    expect(screen.getByTestId('rail-open-math/viewer').className).toContain('text-muted-foreground');
  });
});

describe('NavRail expand/collapse', () => {
  it('starts collapsed by default with an expand toggle', () => {
    render(<NavRail />);
    expect(screen.getByTestId('nav-rail').className).toContain('w-10');
    const toggle = screen.getByTestId('rail-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('title', 'Expand navigation');
  });

  it('toggle expands the rail and persists the choice', () => {
    render(<NavRail />);
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByTestId('nav-rail').className).toContain('w-44');
    expect(screen.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(localStorage.getItem('bloom.navRailExpanded')).toBe('1');
  });

  it('mounts expanded when persisted; collapsing clears the key', () => {
    localStorage.setItem('bloom.navRailExpanded', '1');
    render(<NavRail />);
    expect(screen.getByTestId('nav-rail').className).toContain('w-44');
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByTestId('nav-rail').className).toContain('w-10');
    expect(localStorage.getItem('bloom.navRailExpanded')).toBeNull();
  });
});

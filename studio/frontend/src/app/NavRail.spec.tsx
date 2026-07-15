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

  it('shows pane labels and group headers only when expanded', () => {
    render(<NavRail />);
    // collapsed: headers stay mounted (fixed-height slot keeps the layout
    // vertically inert across hover-expand) but are visually hidden
    expect(screen.getByText('Design')).toHaveClass('opacity-0');
    expect(screen.getByText('Design')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('rail-open-math/viewer')).not.toHaveTextContent('Math');
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByText('Design')).not.toHaveClass('opacity-0');
    expect(screen.getByText('Art')).toBeInTheDocument();
    expect(screen.getByTestId('rail-open-math/viewer')).toHaveTextContent('Math');
    expect(screen.getByTestId('rail-open-llm-chat/room')).toHaveTextContent('Chat Room');
  });

  it('drops the native tooltip when expanded (label is visible)', () => {
    render(<NavRail />);
    expect(screen.getByTestId('rail-open-math/viewer')).toHaveAttribute('title', 'Math');
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByTestId('rail-open-math/viewer')).not.toHaveAttribute('title');
  });

  it('expands as an overlay: the layout slot stays w-10 and the rail floats above the dock', () => {
    render(<NavRail />);
    const slot = screen.getByTestId('nav-rail-slot');
    expect(slot.className).toContain('w-10');
    fireEvent.click(screen.getByTestId('rail-toggle'));
    // the slot never grows — the dock area must not resize on expand
    expect(slot.className).toContain('w-10');
    expect(screen.getByTestId('nav-rail').className).toContain('absolute');
  });

  it('gives the uncurated overflow group no header when expanded', () => {
    setHost(fakeHost([...PANES, { id: 'mystery/pane', title: 'Zephyr' }]));
    render(<NavRail />);
    fireEvent.click(screen.getByTestId('rail-toggle'));
    expect(screen.getByTestId('rail-open-mystery/pane')).toHaveTextContent('Zephyr');
    expect(screen.queryByText('Other')).toBeNull();
  });
});

describe('NavRail hover expand', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expands after the hover-intent delay and collapses immediately on leave', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    fireEvent.mouseOver(nav);
    expect(nav.className).toContain('w-10'); // intent delay not elapsed yet
    act(() => vi.advanceTimersByTime(150));
    expect(nav.className).toContain('w-44');
    expect(screen.getByTestId('rail-toggle')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.mouseOut(nav);
    expect(nav.className).toContain('w-10');
  });

  it('never expands when the cursor skates through within the delay', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    fireEvent.mouseOver(nav);
    fireEvent.mouseOut(nav);
    act(() => vi.advanceTimersByTime(1000));
    expect(nav.className).toContain('w-10');
  });

  it('hover never writes the pin key; pinning while hovered survives leave', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    fireEvent.mouseOver(nav);
    act(() => vi.advanceTimersByTime(150));
    expect(localStorage.getItem('bloom.navRailExpanded')).toBeNull();
    fireEvent.click(screen.getByTestId('rail-toggle')); // pin while hover-expanded
    expect(localStorage.getItem('bloom.navRailExpanded')).toBe('1');
    fireEvent.mouseOut(nav); // pin wins
    expect(nav.className).toContain('w-44');
  });

  it('expands on focus with no delay and collapses when focus leaves the rail', () => {
    render(<NavRail />);
    const nav = screen.getByTestId('nav-rail');
    const btn = screen.getByTestId('rail-open-llm-chat/room');
    fireEvent.focus(btn);
    expect(nav.className).toContain('w-44');
    fireEvent.blur(btn, { relatedTarget: document.body });
    expect(nav.className).toContain('w-10');
  });

  it('stays expanded while focus moves between rail buttons', () => {
    render(<NavRail />);
    fireEvent.focus(screen.getByTestId('rail-open-llm-chat/room'));
    fireEvent.blur(screen.getByTestId('rail-open-llm-chat/room'), {
      relatedTarget: screen.getByTestId('rail-open-gdd/viewer'),
    });
    expect(screen.getByTestId('nav-rail').className).toContain('w-44');
  });
});

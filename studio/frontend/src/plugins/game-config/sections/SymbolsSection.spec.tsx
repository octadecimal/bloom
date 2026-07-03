import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import { SymbolsSection } from './SymbolsSection';

const applyModel = vi.fn();
const applyPresentation = vi.fn();
vi.mock('../actions', () => ({
  applyModel: (fn: unknown) => applyModel(fn),
  applyPresentation: (fn: unknown) => applyPresentation(fn),
}));

const MODEL = {
  symbols: [
    { id: 0, role: 'normal' as const },
    { id: 9, role: 'scatter' as const },
  ],
  reels: [[0, 9]],
  rows: 1,
  paylines: [[0]],
  paytable: { entries: [] },
  bonuses: [],
};

describe('SymbolsSection', () => {
  beforeEach(() => {
    applyModel.mockReset();
    applyPresentation.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().model.set(MODEL);
      gameConfigSlice().presentation.set({ symbols: { '0': { label: 'Ace', color: 'sym-1' } } });
    });
  });

  it('renders one row per symbol with label fallback', () => {
    render(<SymbolsSection />);
    expect((screen.getByTestId('gc-symbol-label-0') as HTMLInputElement).value).toBe('Ace');
    expect((screen.getByTestId('gc-symbol-label-9') as HTMLInputElement).value).toBe('S9');
    expect((screen.getByTestId('gc-symbol-role-9') as HTMLSelectElement).value).toBe('scatter');
  });

  it('label commit goes through applyPresentation', () => {
    render(<SymbolsSection />);
    const el = screen.getByTestId('gc-symbol-label-0') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'King' } });
    fireEvent.blur(el);
    expect(applyPresentation).toHaveBeenCalledTimes(1);
  });

  it('role change, swatch pick, delete, and add dispatch the right updates', () => {
    render(<SymbolsSection />);
    fireEvent.change(screen.getByTestId('gc-symbol-role-0'), { target: { value: 'wild' } });
    expect(applyModel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('gc-symbol-swatch-0-sym-4'));
    expect(applyPresentation).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId('gc-symbol-delete-9'));
    expect(applyModel).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId('gc-add-symbol'));
    expect(applyModel).toHaveBeenCalledTimes(3);
  });
});

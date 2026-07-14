import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { setLayoutPresets } from '../state/layoutPresetsRef';
import { PhaseSwitcher } from './PhaseSwitcher';
import type { ILayoutPresetsService } from '../host/layoutPresets';

const apply = vi.fn(() => true);
beforeEach(() => {
  apply.mockClear();
  setLayoutPresets({ apply, saveAs: vi.fn(), list: vi.fn(() => []), delete: vi.fn(), onPresetsChange: vi.fn(() => () => {}) } as ILayoutPresetsService);
});

describe('PhaseSwitcher', () => {
  it('renders the four journey phases in order', () => {
    render(<PhaseSwitcher />);
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Design', 'Art', 'Math', 'Play']);
  });

  it('clicking a phase applies that preset', () => {
    render(<PhaseSwitcher />);
    fireEvent.click(screen.getByTestId('phase-Math'));
    expect(apply).toHaveBeenCalledWith('Math');
  });

  it('has no active-phase highlight (stateless by design)', () => {
    render(<PhaseSwitcher />);
    fireEvent.click(screen.getByTestId('phase-Art'));
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
  });
});

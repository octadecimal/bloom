import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewToggle } from './ViewToggle';

describe('ViewToggle', () => {
  it('renders a button for each of the four modes', () => {
    render(<ViewToggle mode="medium" onChange={() => {}} />);
    expect(screen.getByTestId('view-mode-small')).toBeTruthy();
    expect(screen.getByTestId('view-mode-medium')).toBeTruthy();
    expect(screen.getByTestId('view-mode-large')).toBeTruthy();
    expect(screen.getByTestId('view-mode-list')).toBeTruthy();
  });

  it('marks the active mode with aria-pressed', () => {
    render(<ViewToggle mode="large" onChange={() => {}} />);
    expect(screen.getByTestId('view-mode-large').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('view-mode-small').getAttribute('aria-pressed')).toBe('false');
  });

  it('calls onChange with the clicked mode', () => {
    const onChange = vi.fn();
    render(<ViewToggle mode="medium" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('view-mode-list'));
    expect(onChange).toHaveBeenCalledWith('list');
  });
});

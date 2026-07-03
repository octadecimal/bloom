import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommittedInput } from './CommittedInput';

describe('CommittedInput', () => {
  it('commits the draft on blur', () => {
    const onCommit = vi.fn();
    render(<CommittedInput value="Ace" onCommit={onCommit} kind="text" testId="in" />);
    const el = screen.getByTestId('in') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'King' } });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledWith('King');
  });

  it('keeps the local draft while focused even if the value prop changes (external write guard)', () => {
    const onCommit = vi.fn();
    const { rerender } = render(<CommittedInput value="Ace" onCommit={onCommit} kind="text" testId="in" />);
    const el = screen.getByTestId('in') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'Ki' } });
    rerender(<CommittedInput value="Tuned" onCommit={onCommit} kind="text" testId="in" />);
    expect(el.value).toBe('Ki'); // draft survives the external re-hydration
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledWith('Ki'); // this field's value wins for this field only
  });

  it('shows the new prop value when not focused', () => {
    const { rerender } = render(<CommittedInput value="Ace" onCommit={vi.fn()} kind="text" testId="in" />);
    rerender(<CommittedInput value="Tuned" onCommit={vi.fn()} kind="text" testId="in" />);
    expect((screen.getByTestId('in') as HTMLInputElement).value).toBe('Tuned');
  });

  it('int kind commits parsed integers and reverts on garbage', () => {
    const onCommit = vi.fn();
    render(<CommittedInput value="5" onCommit={onCommit} kind="int" testId="in" />);
    const el = screen.getByTestId('in') as HTMLInputElement;
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: '12' } });
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledWith('12');
    onCommit.mockReset();
    fireEvent.focus(el);
    fireEvent.change(el, { target: { value: 'xyz' } });
    fireEvent.blur(el);
    expect(onCommit).not.toHaveBeenCalled();
    expect(el.value).toBe('5'); // reverted
  });
});

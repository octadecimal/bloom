import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as commit from './commit';
import { EditableValue } from './EditableValue';

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(commit, 'commitSetProp').mockImplementation(() => {});
});
afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('EditableValue', () => {
  it('renders the raw number and debounce-commits a parsed edit', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    expect(input.value).toBe('120');

    fireEvent.change(input, { target: { value: '130' } });
    expect(commit.commitSetProp).not.toHaveBeenCalled(); // debounced
    act(() => vi.advanceTimersByTime(80));
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'x', 130);
  });

  it('does not commit an empty/NaN number', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x');
    fireEvent.change(input, { target: { value: '' } });
    act(() => vi.advanceTimersByTime(80));
    expect(commit.commitSetProp).not.toHaveBeenCalled();
  });

  it('commits a boolean immediately on toggle', () => {
    render(<EditableValue nodeId="s1" path="visible" valueType="boolean" raw={true} />);
    const box = screen.getByTestId('inspector-edit-visible') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'visible', false);
  });

  it('reverts to raw on Escape', () => {
    render(<EditableValue nodeId="s1" path="name" valueType="string" raw="hero" />);
    const input = screen.getByTestId('inspector-edit-name') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'villain' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('hero');
  });

  it('syncs from a new raw value when not focused', () => {
    const { rerender } = render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    rerender(<EditableValue nodeId="s1" path="x" valueType="number" raw={200} />);
    expect((screen.getByTestId('inspector-edit-x') as HTMLInputElement).value).toBe('200');
  });

  it('does NOT clobber the field from a raw change while focused', () => {
    const { rerender } = render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '155' } });
    rerender(<EditableValue nodeId="s1" path="x" valueType="number" raw={999} />); // echo arrives mid-edit
    expect(input.value).toBe('155');
  });
});

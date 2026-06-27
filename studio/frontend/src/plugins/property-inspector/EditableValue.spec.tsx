import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as commit from './commit';
import { EditableValue } from './EditableValue';

beforeEach(() => {
  vi.spyOn(commit, 'commitSetProp').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('EditableValue', () => {
  it('renders the raw number and commits a parsed edit immediately', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x') as HTMLInputElement;
    expect(input.value).toBe('120');

    fireEvent.change(input, { target: { value: '130' } });
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'x', 130);
  });

  it('commits every change with no coalescing', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={0} />);
    const input = screen.getByTestId('inspector-edit-x');
    fireEvent.change(input, { target: { value: '1' } });
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.change(input, { target: { value: '100' } });
    expect(commit.commitSetProp).toHaveBeenCalledTimes(3);
    expect(commit.commitSetProp).toHaveBeenNthCalledWith(1, 's1', 'x', 1);
    expect(commit.commitSetProp).toHaveBeenNthCalledWith(2, 's1', 'x', 10);
    expect(commit.commitSetProp).toHaveBeenNthCalledWith(3, 's1', 'x', 100);
  });

  it('does not commit an empty/NaN number', () => {
    render(<EditableValue nodeId="s1" path="x" valueType="number" raw={120} />);
    const input = screen.getByTestId('inspector-edit-x');
    fireEvent.change(input, { target: { value: '' } });
    expect(commit.commitSetProp).not.toHaveBeenCalled();
  });

  it('commits a boolean immediately on toggle', () => {
    render(<EditableValue nodeId="s1" path="visible" valueType="boolean" raw={true} />);
    const box = screen.getByTestId('inspector-edit-visible') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(commit.commitSetProp).toHaveBeenCalledWith('s1', 'visible', false);
  });

  it('on Escape, restores the focus-time value to the field and re-commits it', () => {
    render(<EditableValue nodeId="s1" path="name" valueType="string" raw="hero" />);
    const input = screen.getByTestId('inspector-edit-name') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'villain' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('hero');
    // Escape re-commits the focus-time value so the live game reverts too.
    expect(commit.commitSetProp).toHaveBeenLastCalledWith('s1', 'name', 'hero');
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

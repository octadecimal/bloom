import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Select } from './select';

describe('Select', () => {
  it('renders a native select and forwards props + className', () => {
    const { getByTestId } = render(
      <Select data-testid="s" className="extra">
        <option value="a">A</option>
      </Select>,
    );
    const el = getByTestId('s') as HTMLSelectElement;
    expect(el.tagName).toBe('SELECT');
    expect(el.classList.contains('extra')).toBe(true);
    expect(el.classList.contains('border-input')).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Input } from './input';

describe('Input', () => {
  it('renders an input and forwards props + className', () => {
    const { getByPlaceholderText } = render(<Input placeholder="Name" className="extra" />);
    const el = getByPlaceholderText('Name') as HTMLInputElement;
    expect(el.tagName).toBe('INPUT');
    expect(el.classList.contains('extra')).toBe(true);
  });

  it('renders at the compact height', () => {
    const { getByPlaceholderText } = render(<Input placeholder="h" />);
    expect((getByPlaceholderText('h') as HTMLInputElement).className).toContain('h-7');
  });
});

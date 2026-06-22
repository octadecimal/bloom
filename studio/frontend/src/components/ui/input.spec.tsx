import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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

describe('Input is a raised field well with token chrome', () => {
  it('uses the raised surface and a hairline border', () => {
    render(<Input data-testid="f" placeholder="Name" />);
    const el = screen.getByTestId('f');
    expect(el.className).toContain('bg-raised');
    expect(el.className).toContain('border-input'); // → --hairline via remap
    expect(el.className).toContain('placeholder:text-faint'); // → --text-3 via remap
    expect(el.className).toContain('focus-visible:ring-ring'); // → --accent via remap
  });
});

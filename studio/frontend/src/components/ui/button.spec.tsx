import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  it('renders the destructive variant with the destructive token classes', () => {
    const { getByRole } = render(<Button variant="destructive">Delete</Button>);
    const cls = getByRole('button').className;
    expect(cls).toContain('bg-destructive');
    expect(cls).toContain('text-destructive-foreground');
  });

  it('renders the ghost variant', () => {
    const { getByRole } = render(<Button variant="ghost">Quiet</Button>);
    expect(getByRole('button').className).toContain('hover:bg-accent');
  });

  it('applies the sm size', () => {
    const { getByRole } = render(<Button size="sm">Small</Button>);
    expect(getByRole('button').className).toContain('h-8');
  });

  it('forwards className', () => {
    const { getByRole } = render(<Button className="extra">x</Button>);
    expect(getByRole('button').classList.contains('extra')).toBe(true);
  });
});

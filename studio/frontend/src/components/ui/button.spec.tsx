import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
    expect(getByRole('button').className).toContain('hover:bg-raised-hover');
  });

  it('applies the sm size', () => {
    const { getByRole } = render(<Button size="sm">Small</Button>);
    expect(getByRole('button').className).toContain('h-6');
  });

  it('applies the compact default height', () => {
    const { getByRole } = render(<Button>Go</Button>);
    expect(getByRole('button').className).toContain('h-7');
  });

  it('forwards className', () => {
    const { getByRole } = render(<Button className="extra">x</Button>);
    expect(getByRole('button').classList.contains('extra')).toBe(true);
  });

  it('renders the accentOutline variant', () => {
    const { getByRole } = render(<Button variant="accentOutline">Generate</Button>);
    const cls = getByRole('button').className;
    expect(cls).toContain('border-primary/45');
    expect(cls).toContain('text-accent-text');
  });
});

describe('Button variants follow accent rationing', () => {
  it('primary is the only accent fill', () => {
    render(<Button data-testid="b">Go</Button>);
    expect(screen.getByTestId('b').className).toContain('bg-primary'); // → --accent
  });
  it('ghost carries a hairline-strong edge, no fill', () => {
    render(
      <Button data-testid="g" variant="ghost">
        x
      </Button>,
    );
    const c = screen.getByTestId('g').className;
    expect(c).toContain('bg-transparent');
    expect(c).toContain('border-border-strong');
  });
});

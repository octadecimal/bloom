import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrandMark } from './BrandMark';

describe('BrandMark', () => {
  it('renders the Bloom Studio wordmark as a heading', () => {
    render(<BrandMark />);
    expect(screen.getByRole('heading', { name: 'Bloom Studio' })).toBeInTheDocument();
  });

  it('marks the monogram glyph as decorative (aria-hidden)', () => {
    render(<BrandMark />);
    const glyph = screen.getByText('b');
    expect(glyph).toHaveAttribute('aria-hidden');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaneErrorBoundary } from './PaneErrorBoundary';

function Boom(): never { throw new Error('boom'); }

describe('PaneErrorBoundary', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { errSpy.mockRestore(); });

  it('renders a fallback instead of propagating a render error', () => {
    render(<PaneErrorBoundary><Boom /></PaneErrorBoundary>);
    expect(screen.getByTestId('pane-error')).toBeTruthy();
  });
});

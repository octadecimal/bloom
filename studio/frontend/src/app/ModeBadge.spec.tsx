import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ModeBadge } from './ModeBadge';

afterEach(() => vi.restoreAllMocks());

describe('ModeBadge', () => {
  it('shows REPLAY when /health reports replay mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok', providerMode: 'replay' }), { status: 200 }));
    render(<ModeBadge />);
    await waitFor(() => expect(screen.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'replay'));
    expect(screen.getByTestId('mode-badge')).toHaveTextContent(/replay/i);
  });

  it('shows LIVE when /health reports live mode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'ok', providerMode: 'live' }), { status: 200 }));
    render(<ModeBadge />);
    await waitFor(() => expect(screen.getByTestId('mode-badge')).toHaveAttribute('data-mode', 'live'));
  });
});

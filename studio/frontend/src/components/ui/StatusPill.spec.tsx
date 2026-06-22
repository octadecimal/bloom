import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusPill } from './StatusPill';

describe('StatusPill', () => {
  it('renders children and forwards arbitrary props', () => {
    const { getByTestId } = render(
      <StatusPill tone="success" data-testid="p" data-state="connected">
        connected
      </StatusPill>,
    );
    const el = getByTestId('p');
    expect(el.textContent).toContain('connected');
    expect(el.getAttribute('data-state')).toBe('connected');
  });

  it('applies a tone dot class', () => {
    const { getByTestId } = render(
      <StatusPill tone="warning" data-testid="p">
        x
      </StatusPill>,
    );
    expect(getByTestId('p').querySelector('.bg-warning')).toBeTruthy();
  });
});

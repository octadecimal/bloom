import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PanelHeader } from './PanelHeader';

describe('PanelHeader', () => {
  it('renders an uppercase label and the testid', () => {
    const { getByTestId, getByText } = render(<PanelHeader label="Asset Board" />);
    expect(getByTestId('panel-header')).toBeTruthy();
    expect(getByText('Asset Board').className).toContain('uppercase');
  });

  it('renders the right slot when provided', () => {
    const { getByText } = render(<PanelHeader label="L" right={<span>game: skybloom</span>} />);
    expect(getByText('game: skybloom')).toBeTruthy();
  });
});

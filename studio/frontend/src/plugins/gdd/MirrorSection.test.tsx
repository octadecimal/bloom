import { render, screen } from '@testing-library/react';
import { MirrorSection } from './MirrorSection';

const model = {
  symbols: [
    { id: 0, role: 'wild' },
    { id: 1, role: 'normal' },
  ],
  paytable: { entries: [{ symbol: 0, count: 5, payout: 500 }] },
  bonuses: [{ FreeSpins: { config: { spins_awarded: 10 } } }],
};
const names = new Map([
  [0, 'Wild'],
  [1, 'Thor'],
]);

it('renders realized paytable rows with symbol names', () => {
  render(<MirrorSection aspect="paytable" model={model} names={names} />);
  expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('Realized');
  expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('Wild');
  expect(screen.getByTestId('gdd-mirror-paytable')).toHaveTextContent('500');
});

it('renders bonuses for bonus-features aspect', () => {
  render(<MirrorSection aspect="bonus-features" model={model} names={names} />);
  expect(screen.getByTestId('gdd-mirror-bonus-features')).toHaveTextContent('Free spins');
});

it('renders nothing without a model', () => {
  const { container } = render(<MirrorSection aspect="paytable" model={null} names={names} />);
  expect(container).toBeEmptyDOMElement();
});

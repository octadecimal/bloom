import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider, Tooltip, TooltipTrigger, TooltipContent } from './tooltip';

function Fixture() {
  return (
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button>seed</button>
        </TooltipTrigger>
        <TooltipContent>Seeds the RNG</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

describe('Tooltip', () => {
  it('is closed by default', () => {
    render(<Fixture />);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens on keyboard focus and renders the content', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.tab(); // focus-visible on the trigger
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Seeds the RNG');
  });

  it('opens on hover', async () => {
    const user = userEvent.setup();
    render(<Fixture />);
    await user.hover(screen.getByRole('button'));
    expect(await screen.findByRole('tooltip')).toBeTruthy();
  });
});

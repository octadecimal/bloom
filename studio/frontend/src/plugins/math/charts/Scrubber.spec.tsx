import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Scrubber } from './Scrubber';
import type { IGenFrame } from '../state';

function frame(generation: number): IGenFrame {
  return {
    generation,
    best: { fitness: -0.1 * generation, rtp: 0.9, volatility: 2 },
    population: { min: 0.1, q1: 0.2, median: 0.3, q3: 0.4, max: 0.5, mean: 0.3, diversity: 0.4 },
    geneAgreement: [0.5],
  };
}

const FRAMES = [frame(0), frame(1), frame(2), frame(3)];

describe('Scrubber', () => {
  it('renders a range input spanning the recorded generations', () => {
    render(<Scrubber frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('3');
  });

  it('tracks the newest generation while live', () => {
    render(<Scrubber frames={FRAMES} selectedGeneration="live" onScrub={vi.fn()} />);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.value).toBe('3');
    expect(screen.getByTestId('scrubber').textContent).toMatch(/live/i);
  });

  it('reflects a pinned (scrubbed) generation', () => {
    render(<Scrubber frames={FRAMES} selectedGeneration={1} onScrub={vi.fn()} />);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.value).toBe('1');
  });

  it('calls onScrub with the chosen generation as a number', () => {
    const onScrub = vi.fn();
    render(<Scrubber frames={FRAMES} selectedGeneration="live" onScrub={onScrub} />);
    const slider = screen.getByRole('slider');
    fireEvent.change(slider, { target: { value: '2' } });
    expect(onScrub).toHaveBeenCalledWith(2);
  });

  it('disables the slider when there are no frames yet', () => {
    render(<Scrubber frames={[]} selectedGeneration="live" onScrub={vi.fn()} />);
    const slider = screen.getByRole('slider') as HTMLInputElement;
    expect(slider.disabled).toBe(true);
  });
});

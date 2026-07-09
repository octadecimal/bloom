import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { TransitionsSection } from './TransitionsSection';
import { gameStructureSlice, makeInitialState } from '../state';
import { emptyDefinition } from '../model';

function seed() {
  const s = gameStructureSlice();
  s.set(makeInitialState());
  s.activeGameId.set('g1');
  s.definition.set({
    ...emptyDefinition(),
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: { rows: 3, events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }] } },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
    states: [
      { id: 'base', bindings: [{ mechanic: 'main_reels' }, { mechanic: 'bonus_meter' }], steps: { budget: 1 }, script: [] },
      { id: 'fs1', bindings: [{ mechanic: 'main_reels' }], steps: { budget: 'awarded', initial: 8 }, script: [] },
    ],
    start: 'base',
    transitions: [{ from: 'base', on: 'scatters:3', to: 'fs1' }],
    caps: { max_steps: 1000 },
  });
}

describe('TransitionsSection', () => {
  beforeEach(seed);

  it('renders a row per transition', () => {
    render(<TransitionsSection />);
    expect(screen.getByTestId('gs-tr-row-0')).toBeInTheDocument();
  });

  it('changing on writes the definition', () => {
    render(<TransitionsSection />);
    fireEvent.change(screen.getByTestId('gs-tr-on-0'), { target: { value: 'meter:full' } });
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.transitions[0].on).toBe('meter:full');
  });

  it('switching kind to effect swaps to for effect, then the steps stepper edits the amount', () => {
    render(<TransitionsSection />);
    fireEvent.change(screen.getByTestId('gs-tr-kind-0'), { target: { value: 'effect' } });
    let def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.transitions[0]).toEqual({ from: 'base', on: 'scatters:3', effect: 'steps:add:1' });

    fireEvent.click(screen.getByTestId('gs-tr-steps-0-inc'));
    def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.transitions[0].effect).toBe('steps:add:2');
  });

  it('start-select change writes start', () => {
    render(<TransitionsSection />);
    fireEvent.change(screen.getByTestId('gs-start-select'), { target: { value: 'fs1' } });
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.start).toBe('fs1');
  });

  it('max-steps stepper writes caps', () => {
    render(<TransitionsSection />);
    fireEvent.click(screen.getByTestId('gs-max-steps-inc'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.caps.max_steps).toBe(1001);
  });
});

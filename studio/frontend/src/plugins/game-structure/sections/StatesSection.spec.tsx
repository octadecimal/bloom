import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { StatesSection } from './StatesSection';
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
      {
        id: 'base',
        bindings: [{ mechanic: 'main_reels' }, { mechanic: 'bonus_meter' }],
        steps: { budget: 1 },
        script: [{ invoke: 'main_reels.spin' }, { invoke: 'bonus_meter.accumulate' }],
      },
      {
        id: 'fs1',
        bindings: [{ mechanic: 'main_reels', override: { multiplier: 2 } }],
        steps: { budget: 'awarded', initial: 8 },
        script: [{ invoke: 'main_reels.spin' }],
      },
    ],
    start: 'base',
    transitions: [{ from: 'base', on: 'scatters:3', to: 'fs1' }],
  });
}

describe('StatesSection', () => {
  beforeEach(seed);

  it('renders a card per state with id input and budget controls', () => {
    render(<StatesSection />);
    expect(screen.getByTestId('gs-state-card-base')).toBeInTheDocument();
    expect((screen.getByTestId('gs-state-id-base') as HTMLInputElement).value).toBe('base');
    expect((screen.getByTestId('gs-budget-mode-base') as HTMLSelectElement).value).toBe('fixed');
    expect((screen.getByTestId('gs-budget-mode-fs1') as HTMLSelectElement).value).toBe('awarded');
    expect(screen.getByTestId('gs-budget-initial-fs1')).toBeInTheDocument();
  });

  it('toggling a binding checkbox unbinds the mechanic', () => {
    render(<StatesSection />);
    fireEvent.click(screen.getByTestId('gs-binding-base-bonus_meter'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.states[0].bindings).toEqual([{ mechanic: 'main_reels' }]);
  });

  it('selecting a value in the script-add select appends the invoke', () => {
    render(<StatesSection />);
    fireEvent.change(screen.getByTestId('gs-script-add-fs1'), { target: { value: 'main_reels.spin' } });
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.states[1].script).toEqual([{ invoke: 'main_reels.spin' }, { invoke: 'main_reels.spin' }]);
  });

  it('add-state button appends a state_1-style state', () => {
    render(<StatesSection />);
    fireEvent.click(screen.getByTestId('gs-add-state'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.states).toHaveLength(3);
    expect(def.states[2].id).toBe('state_1');
  });
});

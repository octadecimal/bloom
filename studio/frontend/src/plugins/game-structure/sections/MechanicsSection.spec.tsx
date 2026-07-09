import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MechanicsSection } from './MechanicsSection';
import { gameStructureSlice, makeInitialState } from '../state';
import { emptyDefinition } from '../model';

function seed() {
  const s = gameStructureSlice();
  s.set(makeInitialState());
  s.activeGameId.set('g1');
  s.definition.set({
    ...emptyDefinition(),
    mechanics: [
      { id: 'main_reels', type: 'reels@1', config: { rows: 3, events: [{ symbol: 9, min_count: 3, emit: 'scatters:3' }], strips: [[0]] } },
      { id: 'bonus_meter', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
  });
}

describe('MechanicsSection', () => {
  beforeEach(seed);

  it('renders a card per instance with typed fields', () => {
    render(<MechanicsSection />);
    expect(screen.getByTestId('gs-mech-card-main_reels')).toBeInTheDocument();
    expect(screen.getByTestId('gs-meter-target-bonus_meter')).toBeInTheDocument();
    expect(screen.getByTestId('gs-reels-rows-main_reels')).toBeInTheDocument();
    expect((screen.getByTestId('gs-reels-event-emit-main_reels-0') as HTMLInputElement).value).toBe('scatters:3');
  });

  it('add buttons append catalog mechanics', () => {
    render(<MechanicsSection />);
    fireEvent.click(screen.getByTestId('gs-add-meter@1'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.mechanics).toHaveLength(3);
    expect(def.mechanics[2].type).toBe('meter@1');
  });

  it('config JSON apply replaces the config and flags parse errors', () => {
    render(<MechanicsSection />);
    const ta = screen.getByTestId('gs-mech-config-json-bonus_meter');
    fireEvent.change(ta, { target: { value: '{"target": 9}' } });
    fireEvent.click(screen.getByTestId('gs-mech-config-apply-bonus_meter'));
    const def = gameStructureSlice().definition.get({ noproxy: true })!;
    expect(def.mechanics[1].config).toEqual({ target: 9 });

    fireEvent.change(ta, { target: { value: '{oops' } });
    fireEvent.click(screen.getByTestId('gs-mech-config-apply-bonus_meter'));
    expect(screen.getByTestId('gs-mech-config-error-bonus_meter')).toBeInTheDocument();
  });
});

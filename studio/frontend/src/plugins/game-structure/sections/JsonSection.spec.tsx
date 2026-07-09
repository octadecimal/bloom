// studio/frontend/src/plugins/game-structure/sections/JsonSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_STRUCTURE_PLUGIN_ID, gameStructureSlice, makeInitialState } from '../state';
import { JsonSection } from './JsonSection';

const applyDocFromJson = vi.fn();
vi.mock('../actions', () => ({
  applyDocFromJson: (text: string) => applyDocFromJson(text),
}));

describe('JsonSection', () => {
  beforeEach(() => {
    applyDocFromJson.mockReset();
    rootStore.plugins.nested(GAME_STRUCTURE_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameStructureSlice().activeGameId.set('g1');
      gameStructureSlice().jsonDraft.set('{"rows": 3}');
    });
  });

  it('shows the draft and applies it via the Apply button', () => {
    render(<JsonSection />);
    const ta = screen.getByTestId('gs-json-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('{"rows": 3}');
    fireEvent.change(ta, { target: { value: '{"rows": 4}' } });
    fireEvent.click(screen.getByTestId('gs-json-apply'));
    expect(applyDocFromJson).toHaveBeenCalledWith('{"rows": 4}');
  });

  it('renders jsonError when set', () => {
    act(() => gameStructureSlice().jsonError.set('Unexpected token'));
    render(<JsonSection />);
    expect(screen.getByTestId('gs-json-error').textContent).toContain('Unexpected token');
  });
});

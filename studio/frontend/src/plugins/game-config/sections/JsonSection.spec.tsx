// studio/frontend/src/plugins/game-config/sections/JsonSection.spec.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { rootStore } from '../../../state/rootStore';
import { GAME_CONFIG_PLUGIN_ID, gameConfigSlice, makeInitialState } from '../state';
import { JsonSection } from './JsonSection';

const applyModelFromJson = vi.fn();
vi.mock('../actions', () => ({
  applyModelFromJson: (text: string) => applyModelFromJson(text),
}));

describe('JsonSection', () => {
  beforeEach(() => {
    applyModelFromJson.mockReset();
    rootStore.plugins.nested(GAME_CONFIG_PLUGIN_ID).set(makeInitialState() as never);
    act(() => {
      gameConfigSlice().activeGameId.set('g1');
      gameConfigSlice().jsonDraft.set('{"rows": 3}');
    });
  });

  it('shows the draft and applies it via the Apply button', () => {
    render(<JsonSection />);
    const ta = screen.getByTestId('gc-json-textarea') as HTMLTextAreaElement;
    expect(ta.value).toBe('{"rows": 3}');
    fireEvent.change(ta, { target: { value: '{"rows": 4}' } });
    fireEvent.click(screen.getByTestId('gc-json-apply'));
    expect(applyModelFromJson).toHaveBeenCalledWith('{"rows": 4}');
  });

  it('renders jsonError when set', () => {
    act(() => gameConfigSlice().jsonError.set('Unexpected token'));
    render(<JsonSection />);
    expect(screen.getByTestId('gc-json-error').textContent).toContain('Unexpected token');
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { rootStore } from '../../state/rootStore';
import { makeInitialState, LLM_CHAT_PLUGIN_ID } from './state';
import * as actions from './actions';
import * as rest from './restClient';
import { SettingsPane } from './SettingsPane';

vi.spyOn(actions, 'setDisplayName').mockReturnValue(undefined);
vi.spyOn(rest, 'getModels').mockReturnValue(new Promise(() => {}));

beforeEach(() => {
  rootStore.plugins.set({ [LLM_CHAT_PLUGIN_ID]: makeInitialState('guest-0001', null) });
  vi.clearAllMocks();
  vi.spyOn(actions, 'setDisplayName').mockReturnValue(undefined);
  vi.spyOn(rest, 'getModels').mockReturnValue(new Promise(() => {}));
});

describe('SettingsPane', () => {
  it('shows the current display name and commits edits', () => {
    render(<SettingsPane />);
    const input = screen.getByTestId('settings-displayname') as HTMLInputElement;
    expect(input.value).toBe('guest-0001');
    fireEvent.change(input, { target: { value: 'alice' } });
    fireEvent.blur(input);
    expect(actions.setDisplayName).toHaveBeenCalledWith('alice');
  });

  it('loads and lists models from GET /models', async () => {
    vi.spyOn(rest, 'getModels').mockResolvedValue([
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', free: false },
      { id: 'meta-llama/llama-3.2-3b-instruct:free', label: 'Llama 3.2 3B (free)', free: true },
    ]);
    render(<SettingsPane />);
    await waitFor(() => expect(screen.getByTestId('settings-model')).toBeTruthy());
    expect(screen.getByText('GPT-4o mini')).toBeTruthy();
    expect(screen.getByText('Llama 3.2 3B (free)')).toBeTruthy();
  });
});

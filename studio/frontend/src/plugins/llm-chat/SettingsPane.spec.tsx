import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import * as rest from './restClient';
import { SettingsPane } from './SettingsPane';

vi.spyOn(rest, 'getModels').mockReturnValue(new Promise(() => {}));

describe('SettingsPane', () => {
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

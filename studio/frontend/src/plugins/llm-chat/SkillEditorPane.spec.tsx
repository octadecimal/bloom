import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./restClient', () => ({
  getTools: vi.fn(async () => ['generate_asset']),
  getSkill: vi.fn(async () => ({ name: '', description: '', args: [], tools: [], body: '' })),
  saveSkill: vi.fn(async (p) => p),
}));

vi.mock('./actions', () => ({
  loadSkills: vi.fn(async () => {}),
}));

import { SkillEditorPane } from './SkillEditorPane';
import * as rest from './restClient';
import * as actions from './actions';

describe('SkillEditorPane', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads tools and saves an authored skill', async () => {
    render(<SkillEditorPane />);
    await waitFor(() => expect(screen.getByTestId('skill-editor-tool-generate_asset')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('skill-editor-name'), { target: { value: 'my-skill' } });
    fireEvent.change(screen.getByTestId('skill-editor-description'), { target: { value: 'd' } });
    fireEvent.change(screen.getByTestId('skill-editor-body'), { target: { value: 'use generate_asset' } });
    fireEvent.click(screen.getByTestId('skill-editor-tool-generate_asset'));
    fireEvent.click(screen.getByTestId('skill-editor-save'));
    await waitFor(() => expect(rest.saveSkill).toHaveBeenCalled());
    const arg = (rest.saveSkill as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.name).toBe('my-skill');
    expect(arg.tools).toContain('generate_asset');
    expect(actions.loadSkills).toHaveBeenCalled();
  });

  it('loads an existing skill into the form', async () => {
    (rest.getSkill as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      name: 'generate-background',
      description: 'a background',
      args: [{ name: 'mood', type: 'string', required: false, description: 'tone', default: 'neutral', enum: ['bright', 'dark'] }],
      tools: ['generate_asset'],
      body: 'use generate_asset',
    });
    render(<SkillEditorPane />);
    fireEvent.change(screen.getByTestId('skill-editor-name'), { target: { value: 'generate-background' } });
    fireEvent.click(screen.getByTestId('skill-editor-load'));
    await waitFor(() => expect(screen.getByTestId('skill-editor-description')).toHaveValue('a background'));
    expect(rest.getSkill).toHaveBeenCalledWith('generate-background');
    expect(screen.getByTestId('skill-editor-body')).toHaveValue('use generate_asset');
    expect(screen.getByTestId('skill-editor-arg-0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('mood')).toBeInTheDocument();
    expect(screen.getByDisplayValue('bright, dark')).toBeInTheDocument();
    expect(screen.getByTestId('skill-editor-preview')).toHaveTextContent('enum: [bright, dark]');
  });

  it('shows the error when load fails', async () => {
    (rest.getSkill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('skill not found'));
    render(<SkillEditorPane />);
    fireEvent.change(screen.getByTestId('skill-editor-name'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByTestId('skill-editor-load'));
    await waitFor(() => expect(screen.getByTestId('skill-editor-status')).toHaveTextContent('skill not found'));
  });

  it('shows the server error when save fails', async () => {
    (rest.saveSkill as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unknown tools'));
    render(<SkillEditorPane />);
    fireEvent.change(screen.getByTestId('skill-editor-name'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByTestId('skill-editor-save'));
    await waitFor(() => expect(screen.getByTestId('skill-editor-status')).toHaveTextContent('unknown tools'));
    expect(actions.loadSkills).not.toHaveBeenCalled();
  });
});

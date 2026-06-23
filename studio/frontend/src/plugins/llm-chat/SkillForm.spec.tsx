import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SkillForm } from './SkillForm';
import type { ISkill } from './state';

const skill: ISkill = {
  name: 'generate-background',
  description: 'bg',
  args: [
    { name: 'description', type: 'string', required: true },
    { name: 'mood', type: 'string', required: false, default: 'neutral', enum: ['bright', 'dark', 'neutral'] },
  ],
};

describe('SkillForm', () => {
  it('renders a field per arg and prefills the default', () => {
    render(<SkillForm skill={skill} onSubmit={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId('skill-form-field-description')).toBeInTheDocument();
    const mood = screen.getByTestId('skill-form-field-mood') as HTMLSelectElement;
    expect(mood.value).toBe('neutral');
  });

  it('blocks submit until required fields are filled', () => {
    const onSubmit = vi.fn();
    render(<SkillForm skill={skill} onSubmit={onSubmit} onCancel={vi.fn()} />);
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByTestId('skill-form-field-description'), { target: { value: 'a forest' } });
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ description: 'a forest', mood: 'neutral' });
  });
});

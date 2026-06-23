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

const numberSkill: ISkill = {
  name: 'count-things',
  description: 'counts',
  args: [
    { name: 'count', type: 'number', required: false, default: 1 },
  ],
};

const booleanSkill: ISkill = {
  name: 'detailed-report',
  description: 'report',
  args: [
    { name: 'detailed', type: 'boolean', required: false, default: false },
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

  it('prefills number default and submits as a number (not string)', () => {
    const onSubmit = vi.fn();
    render(<SkillForm skill={numberSkill} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const field = screen.getByTestId('skill-form-field-count') as HTMLInputElement;
    // default value renders
    expect(field.value).toBe('1');
    // change to '5' and submit — should arrive as number 5, not string '5'
    fireEvent.change(field, { target: { value: '5' } });
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ count: 5 });
    expect(typeof (onSubmit.mock.calls[0][0] as Record<string, unknown>).count).toBe('number');
  });

  it('renders boolean as unchecked checkbox; click toggles and submits true', () => {
    const onSubmit = vi.fn();
    render(<SkillForm skill={booleanSkill} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const checkbox = screen.getByTestId('skill-form-field-detailed') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId('skill-form-submit'));
    expect(onSubmit).toHaveBeenCalledWith({ detailed: true });
    expect(typeof (onSubmit.mock.calls[0][0] as Record<string, unknown>).detailed).toBe('boolean');
  });
});

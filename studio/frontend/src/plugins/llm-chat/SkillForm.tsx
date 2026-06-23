import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ISkill, ISkillArg } from './state';

function initialValue(a: ISkillArg): string | boolean {
  if (a.default !== undefined && a.default !== null) return a.default as string | boolean;
  return a.type === 'boolean' ? false : '';
}

export function SkillForm({ skill, onSubmit, onCancel }: { skill: ISkill; onSubmit: (args: Record<string, unknown>) => void; onCancel: () => void }) {
  const [values, setValues] = useState<Record<string, string | boolean>>(() => Object.fromEntries(skill.args.map((a) => [a.name, initialValue(a)])));

  const missingRequired = skill.args.some((a) => a.required && (values[a.name] === '' || values[a.name] === undefined));

  const set = (name: string, v: string | boolean) => setValues((prev) => ({ ...prev, [name]: v }));

  const submit = () => {
    if (missingRequired) return;
    const coerced: Record<string, unknown> = {};
    for (const a of skill.args) {
      const v = values[a.name];
      if (a.type === 'number' && !a.enum && typeof v === 'string') {
        if (v === '') {
          // optional empty number field — omit it so backend default applies
          if (a.required) coerced[a.name] = v;
        } else {
          coerced[a.name] = Number(v);
        }
      } else {
        coerced[a.name] = v;
      }
    }
    onSubmit(coerced);
  };

  return (
    <div data-testid="skill-form" className="flex flex-col gap-2 rounded-md border bg-surface p-2.5 text-sm shadow-md">
      <div className="text-[10.5px] font-semibold text-accent-text">/{skill.name}</div>
      {skill.args.map((a, i) => (
        <label key={a.name} className="flex flex-col gap-0.5">
          <span className="text-[10.5px] text-muted-foreground">
            {a.name}
            {a.required ? ' *' : ''}
            {a.description ? ` — ${a.description}` : ''}
          </span>
          {a.enum ? (
            <select
              autoFocus={i === 0}
              data-testid={`skill-form-field-${a.name}`}
              value={String(values[a.name] ?? '')}
              className="rounded border bg-raised px-2 py-1 text-foreground"
              onChange={(e) => set(a.name, e.target.value)}
            >
              {!a.required && <option value="" />}
              {a.enum.map((opt) => (
                <option key={String(opt)} value={String(opt)}>
                  {String(opt)}
                </option>
              ))}
            </select>
          ) : a.type === 'boolean' ? (
            <input
              autoFocus={i === 0}
              data-testid={`skill-form-field-${a.name}`}
              type="checkbox"
              checked={Boolean(values[a.name])}
              className="h-4 w-4 self-start"
              onChange={(e) => set(a.name, e.target.checked)}
            />
          ) : (
            <Input
              autoFocus={i === 0}
              data-testid={`skill-form-field-${a.name}`}
              type={a.type === 'number' ? 'number' : 'text'}
              value={String(values[a.name] ?? '')}
              onChange={(e) => set(a.name, e.target.value)}
            />
          )}
        </label>
      ))}
      <div className="flex justify-end gap-2">
        <Button data-testid="skill-form-cancel" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button data-testid="skill-form-submit" size="sm" disabled={missingRequired} onClick={submit}>
          Run
        </Button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getTools, saveSkill } from './restClient';
import type { ISkillArg, ISkillFull } from './state';

interface IArgRow {
  name: string;
  type: 'string' | 'number' | 'boolean';
  required: boolean;
  description: string;
  default: string;
  enumCsv: string;
}

function rowToArg(r: IArgRow): ISkillArg {
  const arg: ISkillArg = { name: r.name, type: r.type, required: r.required };
  if (r.description) arg.description = r.description;
  if (r.default !== '') arg.default = r.type === 'number' ? Number(r.default) : r.default;
  const en = r.enumCsv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (en.length) arg.enum = en;
  return arg;
}

function previewMarkdown(skill: ISkillFull): string {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`, `tools: [${skill.tools.join(', ')}]`, '---', '', skill.body];
  return lines.join('\n');
}

export function SkillEditorPane() {
  const [tools, setTools] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [rows, setRows] = useState<IArgRow[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    void getTools()
      .then(setTools)
      .catch(() => setTools([]));
  }, []);

  const skill: ISkillFull = {
    name,
    description,
    body,
    tools: selectedTools,
    args: rows.map(rowToArg),
  };

  const toggleTool = (t: string) => setSelectedTools((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const addRow = () => setRows((prev) => [...prev, { name: '', type: 'string', required: false, description: '', default: '', enumCsv: '' }]);

  const setRow = (i: number, patch: Partial<IArgRow>) => setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setStatus(null);
    try {
      await saveSkill(skill);
      setStatus({ ok: true, msg: `Saved to skills/${name}.md — commit + PR it.` });
    } catch (e) {
      setStatus({ ok: false, msg: (e as Error).message });
    }
  };

  return (
    <div data-testid="skill-editor-pane" className="flex h-full flex-col gap-2 overflow-auto bg-surface p-2.5 text-sm">
      <h2 className="text-base font-semibold text-foreground">Skill Editor</h2>
      <Input data-testid="skill-editor-name" placeholder="name (a-z0-9-)" value={name} onChange={(e) => setName(e.target.value)} />
      <Input data-testid="skill-editor-description" placeholder="description" value={description} onChange={(e) => setDescription(e.target.value)} />

      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">Tools</span>
        <div className="flex flex-wrap gap-2">
          {tools.map((t) => (
            <label key={t} className="flex items-center gap-1 text-foreground">
              <input data-testid={`skill-editor-tool-${t}`} type="checkbox" checked={selectedTools.includes(t)} onChange={() => toggleTool(t)} />
              {t}
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10.5px] text-muted-foreground">Args</span>
          <Button data-testid="skill-editor-add-arg" size="sm" variant="ghost" onClick={addRow}>
            + arg
          </Button>
        </div>
        {rows.map((r, i) => (
          <div key={i} data-testid={`skill-editor-arg-${i}`} className="flex flex-wrap gap-1 rounded border bg-raised p-1">
            <Input className="w-24" placeholder="name" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} />
            <select
              className="rounded border bg-surface px-1 text-foreground"
              value={r.type}
              onChange={(e) => setRow(i, { type: e.target.value as IArgRow['type'] })}
            >
              <option value="string">string</option>
              <option value="number">number</option>
              <option value="boolean">boolean</option>
            </select>
            <label className="flex items-center gap-1 text-muted-foreground">
              <input type="checkbox" checked={r.required} onChange={(e) => setRow(i, { required: e.target.checked })} />
              req
            </label>
            <Input className="w-28" placeholder="description" value={r.description} onChange={(e) => setRow(i, { description: e.target.value })} />
            <Input className="w-20" placeholder="default" value={r.default} onChange={(e) => setRow(i, { default: e.target.value })} />
            <Input className="w-28" placeholder="enum a,b,c" value={r.enumCsv} onChange={(e) => setRow(i, { enumCsv: e.target.value })} />
          </div>
        ))}
      </div>

      <textarea
        data-testid="skill-editor-body"
        className="min-h-[120px] rounded border bg-raised p-2 font-mono text-foreground"
        placeholder="skill body (prompt)…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <div className="flex flex-col gap-1">
        <span className="text-[10.5px] text-muted-foreground">Preview</span>
        <pre data-testid="skill-editor-preview" className="overflow-auto rounded border bg-raised p-2 font-mono text-[11px] text-muted-foreground">
          {previewMarkdown(skill)}
        </pre>
      </div>

      <div className="flex items-center justify-between gap-2">
        {status && (
          <span data-testid="skill-editor-status" className={status.ok ? 'text-accent-text' : 'text-destructive'}>
            {status.msg}
          </span>
        )}
        <Button data-testid="skill-editor-save" size="sm" className="ml-auto" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

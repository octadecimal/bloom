// composed@1 GameDefinition — Rust serde wire shape (snake_case), kept 1:1 with
// trusted/math/src/mechanics/composed/definition.rs. Mechanic config and binding
// override are opaque JSON here; the kernel is the only validator.

export interface IMechanicDecl {
  id: string;
  type: string;
  config: Record<string, unknown>;
}

export interface IBinding {
  mechanic: string;
  override?: Record<string, unknown>;
}

export interface IStepsSpec {
  budget: number | 'awarded';
  initial?: number;
}

export interface IScriptEntry {
  invoke: string; // "<instance_id>.<action>"
}

export interface IStateDef {
  id: string;
  bindings: IBinding[];
  steps: IStepsSpec;
  script: IScriptEntry[];
}

export interface ITransitionRow {
  from: string;
  on: string;
  to?: string;
  effect?: string; // "steps:add:<n>"
}

export interface IGameDefinition {
  family: string;
  mechanics: IMechanicDecl[];
  states: IStateDef[];
  start: string;
  transitions: ITransitionRow[];
  caps: { max_steps: number };
}

export function emptyDefinition(): IGameDefinition {
  return { family: 'composed@1', mechanics: [], states: [], start: '', transitions: [], caps: { max_steps: 1000 } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pure. Top-level shape repair only; deep mechanic config / overrides pass through. */
export function normalizeDefinition(raw: unknown): IGameDefinition {
  if (!isRecord(raw)) return emptyDefinition();
  const base = emptyDefinition();
  const caps = isRecord(raw.caps) && typeof raw.caps.max_steps === 'number' ? { max_steps: raw.caps.max_steps } : base.caps;
  return {
    family: typeof raw.family === 'string' ? raw.family : base.family,
    mechanics: Array.isArray(raw.mechanics) ? (raw.mechanics as IMechanicDecl[]) : [],
    states: Array.isArray(raw.states) ? (raw.states as IStateDef[]) : [],
    start: typeof raw.start === 'string' ? raw.start : '',
    transitions: Array.isArray(raw.transitions) ? (raw.transitions as ITransitionRow[]) : [],
    caps,
  };
}

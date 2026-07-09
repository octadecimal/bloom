import type { IGameDefinition, IBinding, IStateDef, ITransitionRow } from './model';
import { MECHANIC_CATALOG } from './vocab';

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Mechanics

export function addMechanic(def: IGameDefinition, type: string): IGameDefinition {
  const entry = MECHANIC_CATALOG.find((c) => c.type === type);
  if (!entry) return def;
  const base = type.split('@')[0];
  const id = uniqueId(base, new Set(def.mechanics.map((m) => m.id)));
  return { ...def, mechanics: [...def.mechanics, { id, type, config: structuredClone(entry.defaultConfig) }] };
}

export function renameMechanic(def: IGameDefinition, index: number, newId: string): IGameDefinition {
  const old = def.mechanics[index]?.id;
  if (!old || !newId || def.mechanics.some((m, i) => i !== index && m.id === newId)) return def;
  return {
    ...def,
    mechanics: def.mechanics.map((m, i) => (i === index ? { ...m, id: newId } : m)),
    states: def.states.map((s) => ({
      ...s,
      bindings: s.bindings.map((b) => (b.mechanic === old ? { ...b, mechanic: newId } : b)),
      script: s.script.map((e) => (e.invoke.startsWith(`${old}.`) ? { invoke: `${newId}.${e.invoke.slice(old.length + 1)}` } : e)),
    })),
  };
}

export function removeMechanic(def: IGameDefinition, index: number): IGameDefinition {
  const gone = def.mechanics[index]?.id;
  if (gone === undefined) return def;
  return {
    ...def,
    mechanics: def.mechanics.filter((_, i) => i !== index),
    states: def.states.map((s) => ({
      ...s,
      bindings: s.bindings.filter((b) => b.mechanic !== gone),
      script: s.script.filter((e) => !e.invoke.startsWith(`${gone}.`)),
    })),
  };
}

export function setMechanicConfig(def: IGameDefinition, index: number, config: Record<string, unknown>): IGameDefinition {
  if (!def.mechanics[index]) return def;
  return {
    ...def,
    mechanics: def.mechanics.map((m, i) => (i === index ? { ...m, config } : m)),
  };
}

// States

export function addState(def: IGameDefinition): IGameDefinition {
  let n = 1;
  const taken = new Set(def.states.map((s) => s.id));
  while (taken.has(`state_${n}`)) n++;
  const newStateId = `state_${n}`;
  const newState: IStateDef = {
    id: newStateId,
    bindings: [],
    steps: { budget: 1 },
    script: [],
  };
  // Only set start to newStateId if this is the genuinely first state
  const start = def.states.length === 0 ? newStateId : def.start;
  return {
    ...def,
    states: [...def.states, newState],
    start,
  };
}

export function removeState(def: IGameDefinition, index: number): IGameDefinition {
  const gone = def.states[index]?.id;
  if (gone === undefined) return def;
  return {
    ...def,
    states: def.states.filter((_, i) => i !== index),
    transitions: def.transitions.filter((t) => t.from !== gone && t.to !== gone),
    start: def.start === gone ? '' : def.start,
  };
}

export function renameState(def: IGameDefinition, index: number, newId: string): IGameDefinition {
  const old = def.states[index]?.id;
  if (!old || !newId || def.states.some((s, i) => i !== index && s.id === newId)) return def;
  return {
    ...def,
    states: def.states.map((s, i) => (i === index ? { ...s, id: newId } : s)),
    start: def.start === old ? newId : def.start,
    transitions: def.transitions.map((t) => ({
      ...t,
      from: t.from === old ? newId : t.from,
      to: t.to === old ? newId : t.to,
    })),
  };
}

export function setStateBudget(def: IGameDefinition, index: number, budget: number | 'awarded', initial?: number): IGameDefinition {
  if (!def.states[index]) return def;
  const newSteps = typeof budget === 'number' ? { budget } : { budget, initial };
  return {
    ...def,
    states: def.states.map((s, i) => (i === index ? { ...s, steps: newSteps } : s)),
  };
}

export function toggleBinding(def: IGameDefinition, stateIndex: number, mechanicId: string): IGameDefinition {
  const state = def.states[stateIndex];
  if (!state) return def;
  const exists = state.bindings.some((b) => b.mechanic === mechanicId);
  if (exists) {
    // Remove binding and its script steps
    return {
      ...def,
      states: def.states.map((s, i) =>
        i === stateIndex
          ? {
              ...s,
              bindings: s.bindings.filter((b) => b.mechanic !== mechanicId),
              script: s.script.filter((e) => !e.invoke.startsWith(`${mechanicId}.`)),
            }
          : s,
      ),
    };
  } else {
    // Add binding
    return {
      ...def,
      states: def.states.map((s, i) => (i === stateIndex ? { ...s, bindings: [...s.bindings, { mechanic: mechanicId }] } : s)),
    };
  }
}

export function setBindingOverride(
  def: IGameDefinition,
  stateIndex: number,
  bindingIndex: number,
  override: Record<string, unknown> | undefined,
): IGameDefinition {
  const state = def.states[stateIndex];
  if (!state || !state.bindings[bindingIndex]) return def;
  const newBinding: IBinding = override ? { ...state.bindings[bindingIndex], override } : { mechanic: state.bindings[bindingIndex].mechanic };
  return {
    ...def,
    states: def.states.map((s, i) =>
      i === stateIndex ? { ...s, bindings: s.bindings.map((b, j) => (j === bindingIndex ? newBinding : b)) } : s,
    ),
  };
}

export function addScriptStep(def: IGameDefinition, stateIndex: number, invoke: string): IGameDefinition {
  if (!def.states[stateIndex]) return def;
  return {
    ...def,
    states: def.states.map((s, i) =>
      i === stateIndex ? { ...s, script: [...s.script, { invoke }] } : s,
    ),
  };
}

export function removeScriptStep(def: IGameDefinition, stateIndex: number, stepIndex: number): IGameDefinition {
  const state = def.states[stateIndex];
  if (!state || !state.script[stepIndex]) return def;
  return {
    ...def,
    states: def.states.map((s, i) =>
      i === stateIndex ? { ...s, script: s.script.filter((_, j) => j !== stepIndex) } : s,
    ),
  };
}

export function moveScriptStep(def: IGameDefinition, stateIndex: number, stepIndex: number, dir: -1 | 1): IGameDefinition {
  const state = def.states[stateIndex];
  if (!state || !state.script[stepIndex]) return def;
  const newIndex = stepIndex + dir;
  if (newIndex < 0 || newIndex >= state.script.length) return def;
  const newScript = [...state.script];
  [newScript[stepIndex], newScript[newIndex]] = [newScript[newIndex], newScript[stepIndex]];
  return {
    ...def,
    states: def.states.map((s, i) => (i === stateIndex ? { ...s, script: newScript } : s)),
  };
}

// Transitions + Caps

export function addTransition(def: IGameDefinition): IGameDefinition {
  const from = def.start || (def.states[0]?.id ?? '');
  const to = def.states[0]?.id ?? '';
  return {
    ...def,
    transitions: [...def.transitions, { from, on: '', to }],
  };
}

export function removeTransition(def: IGameDefinition, index: number): IGameDefinition {
  if (!def.transitions[index]) return def;
  return {
    ...def,
    transitions: def.transitions.filter((_, i) => i !== index),
  };
}

export function setTransition(def: IGameDefinition, index: number, row: ITransitionRow): IGameDefinition {
  if (!def.transitions[index]) return def;
  const clean: ITransitionRow = { from: row.from, on: row.on };
  if (row.effect !== undefined) clean.effect = row.effect;
  else if (row.to !== undefined) clean.to = row.to;
  return { ...def, transitions: def.transitions.map((t, i) => (i === index ? clean : t)) };
}

export function setStart(def: IGameDefinition, stateId: string): IGameDefinition {
  return { ...def, start: stateId };
}

export function setMaxSteps(def: IGameDefinition, n: number): IGameDefinition {
  return { ...def, caps: { max_steps: n } };
}

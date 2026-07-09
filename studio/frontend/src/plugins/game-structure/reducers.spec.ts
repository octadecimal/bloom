import { describe, expect, it } from 'vitest';
import { emptyDefinition, type IGameDefinition } from './model';
import {
  addMechanic,
  addScriptStep,
  addState,
  addTransition,
  moveScriptStep,
  removeMechanic,
  removeScriptStep,
  removeState,
  removeTransition,
  renameMechanic,
  renameState,
  setBindingOverride,
  setMaxSteps,
  setMechanicConfig,
  setStart,
  setStateBudget,
  setTransition,
  toggleBinding,
} from './reducers';

function base(): IGameDefinition {
  return {
    family: 'composed@1',
    mechanics: [
      { id: 'r', type: 'reels@1', config: { rows: 3, events: [] } },
      { id: 'm', type: 'meter@1', config: { target: 6, count_symbol: 9, reset_on_full: true } },
    ],
    states: [
      { id: 'base', bindings: [{ mechanic: 'r' }, { mechanic: 'm' }], steps: { budget: 1 }, script: [{ invoke: 'r.spin' }, { invoke: 'm.accumulate' }] },
      { id: 'fs1', bindings: [{ mechanic: 'r', override: { multiplier: 2 } }], steps: { budget: 'awarded', initial: 8 }, script: [{ invoke: 'r.spin' }] },
    ],
    start: 'base',
    transitions: [{ from: 'base', on: 'scatters:3', to: 'fs1' }],
    caps: { max_steps: 1000 },
  };
}

describe('purity', () => {
  it('reducers never mutate their input', () => {
    const d = base();
    const snapshot = JSON.stringify(d);
    addMechanic(d, 'meter@1');
    renameMechanic(d, 0, 'r2');
    removeState(d, 0);
    setTransition(d, 0, { from: 'fs1', on: 'meter:full', effect: 'steps:add:3' });
    expect(JSON.stringify(d)).toBe(snapshot);
  });
});

describe('mechanics', () => {
  it('addMechanic clones the catalog default config and generates unique ids', () => {
    let d = addMechanic(base(), 'reels@1');
    expect(d.mechanics[2].id).toBe('reels');
    d = addMechanic(d, 'reels@1');
    expect(d.mechanics[3].id).toBe('reels_2');
    d.mechanics[2].config.rows = 99 as unknown as number;
    expect(addMechanic(base(), 'reels@1').mechanics[2].config.rows).toBe(3);
  });

  it('renameMechanic rewrites bindings and script invokes', () => {
    const d = renameMechanic(base(), 0, 'wheel');
    expect(d.states[0].bindings[0].mechanic).toBe('wheel');
    expect(d.states[0].script[0].invoke).toBe('wheel.spin');
    expect(d.states[1].script[0].invoke).toBe('wheel.spin');
  });

  it('removeMechanic drops dependent bindings and script steps', () => {
    const d = removeMechanic(base(), 0);
    expect(d.mechanics.map((m) => m.id)).toEqual(['m']);
    expect(d.states[0].bindings).toEqual([{ mechanic: 'm' }]);
    expect(d.states[0].script).toEqual([{ invoke: 'm.accumulate' }]);
    expect(d.states[1].bindings).toEqual([]);
  });
});

describe('states', () => {
  it('addState numbers uniquely and first state becomes start', () => {
    let d = emptyDefinition();
    d = addState(d);
    expect(d.states[0].id).toBe('state_1');
    expect(d.start).toBe('state_1');
    d = addState(d);
    expect(d.states[1].id).toBe('state_2');
    expect(d.start).toBe('state_1');
  });

  it('renameState rewrites start and transitions', () => {
    const d = renameState(base(), 0, 'main');
    expect(d.start).toBe('main');
    expect(d.transitions[0].from).toBe('main');
  });

  it('removeState drops its transitions and clears a dangling start', () => {
    const d = removeState(base(), 0);
    expect(d.states.map((s) => s.id)).toEqual(['fs1']);
    expect(d.transitions).toEqual([]);
    expect(d.start).toBe('');
  });

  it('setStateBudget switches fixed/awarded shapes', () => {
    let d = setStateBudget(base(), 0, 'awarded', 5);
    expect(d.states[0].steps).toEqual({ budget: 'awarded', initial: 5 });
    d = setStateBudget(d, 0, 3);
    expect(d.states[0].steps).toEqual({ budget: 3 });
  });

  it('toggleBinding removes the binding and its script steps', () => {
    const d = toggleBinding(base(), 0, 'm');
    expect(d.states[0].bindings).toEqual([{ mechanic: 'r' }]);
    expect(d.states[0].script).toEqual([{ invoke: 'r.spin' }]);
    const back = toggleBinding(d, 0, 'm');
    expect(back.states[0].bindings).toEqual([{ mechanic: 'r' }, { mechanic: 'm' }]);
  });

  it('setBindingOverride sets and clears', () => {
    let d = setBindingOverride(base(), 0, 0, { multiplier: 3 });
    expect(d.states[0].bindings[0].override).toEqual({ multiplier: 3 });
    d = setBindingOverride(d, 0, 0, undefined);
    expect(d.states[0].bindings[0]).toEqual({ mechanic: 'r' });
  });

  it('script add/remove/move', () => {
    let d = addScriptStep(base(), 1, 'r.spin');
    expect(d.states[1].script).toHaveLength(2);
    d = moveScriptStep(base(), 0, 1, -1);
    expect(d.states[0].script.map((s) => s.invoke)).toEqual(['m.accumulate', 'r.spin']);
    d = removeScriptStep(base(), 0, 0);
    expect(d.states[0].script).toEqual([{ invoke: 'm.accumulate' }]);
  });
});

describe('transitions + caps', () => {
  it('setTransition keeps exactly one of to/effect', () => {
    let d = setTransition(base(), 0, { from: 'base', on: 'meter:full', effect: 'steps:add:8' });
    expect(d.transitions[0]).toEqual({ from: 'base', on: 'meter:full', effect: 'steps:add:8' });
    d = setTransition(d, 0, { from: 'base', on: 'meter:full', to: 'fs1' });
    expect(d.transitions[0]).toEqual({ from: 'base', on: 'meter:full', to: 'fs1' });
  });

  it('add/removeTransition, setStart, setMaxSteps', () => {
    let d = addTransition(base());
    expect(d.transitions).toHaveLength(2);
    d = removeTransition(d, 0);
    expect(d.transitions).toHaveLength(1);
    d = setStart(d, 'fs1');
    expect(d.start).toBe('fs1');
    d = setMaxSteps(d, 200);
    expect(d.caps.max_steps).toBe(200);
  });
});

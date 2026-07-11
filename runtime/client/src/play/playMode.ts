import type { IGameDocument, JsonValue, IModuleDecl } from '../model/document';
import type { InboundMessage } from '../protocol/messages';
import type { IOutcome } from '../modules/module';
import type { IPresentation, IRuntimeClient, IHandshakeResponse } from './wireTypes';
import { validatePresentation, validatePresentationShape, toReelsConfig, PlayModeError } from './presentationConfig';
import { toClientOutcome } from './outcomeAdapter';
import { validateDefinition, type IGameDefinition } from './composedTypes';
import { TraceWalker, type ITriggerTarget } from '../orchestration/traceWalker';

/** The minimal slices play-mode needs from the engine + DOM (so the orchestrator
 *  is unit-testable with fakes). The real ProtocolHost, event bus, and
 *  Orchestrator satisfy these structurally. */
export interface IPlayHost {
  handle(msg: InboundMessage): Promise<void>;
}
export interface IPlayBus {
  on(event: string, cb: (payload: unknown) => void): () => void;
  emit(event: string, payload: unknown): void;
}
export interface IPlayOrchestrator {
  spin(outcome: IOutcome): void;
}
export interface IPlayModeDeps {
  client: IRuntimeClient;
  host: IPlayHost;
  bus: IPlayBus;
  orchestrator: IPlayOrchestrator;
  /** TraceWalker module lookup by mechanic instance id (composed@1 only). */
  resolveTarget: (mechanicId: string) => ITriggerTarget | null;
  spinButton: HTMLButtonElement;
  errorEl: HTMLElement;
  rootSize?: { width: number; height: number };
}

/** Default scene reference frame. The reels auto-fit/portrait layout rework is a
 *  separate deferred design; play-mode renders the demo presentation as-is. */
const DEFAULT_ROOT_SIZE = { width: 720, height: 1280 };

/** Build the init document: a Root sized to the scene plus a reels module
 *  declaration. ModuleManager.sync projects + mounts it, so the grid renders
 *  before the first spin. */
export function buildPlayDocument(pres: IPresentation, rootSize = DEFAULT_ROOT_SIZE): IGameDocument {
  return {
    version: 1,
    nodes: {
      root: { id: 'root', type: 'Root', props: { width: rootSize.width, height: rootSize.height } },
    },
    edges: [],
    modules: [{ id: 'reels', type: 'reels', config: toReelsConfig(pres) }],
  };
}

function toMeterConfig(config: unknown): Record<string, JsonValue> {
  const target = (config as { target?: unknown } | null)?.target;
  if (typeof target !== 'number') {
    throw new PlayModeError('meter@1 mechanic config missing numeric target');
  }
  return { target };
}

/** Build the composed init document: module instances come from the Game
 *  Definition's mechanics list (keyed by instance id); the presentation
 *  manifest stays the visual source of truth for the reels grid. */
export function buildComposedPlayDocument(def: IGameDefinition, pres: IPresentation, rootSize = DEFAULT_ROOT_SIZE): IGameDocument {
  const modules = def.mechanics.map((m): IModuleDecl => {
    if (m.type === 'reels@1') return { id: m.id, type: 'reels', config: toReelsConfig(pres) };
    if (m.type === 'meter@1') return { id: m.id, type: 'meter', config: toMeterConfig(m.config) };
    throw new PlayModeError(`unsupported mechanic type: ${m.type}`);
  });
  return {
    version: 1,
    nodes: {
      root: { id: 'root', type: 'Root', props: { width: rootSize.width, height: rootSize.height } },
    },
    edges: [],
    modules,
  };
}

function showError(el: HTMLElement, err: unknown): void {
  el.textContent = err instanceof Error ? err.message : String(err);
  el.hidden = false;
}

async function runSpin(deps: IPlayModeDeps): Promise<void> {
  deps.spinButton.disabled = true;
  try {
    const res = await deps.client.spin(1);
    deps.orchestrator.spin(toClientOutcome(res));
  } catch (err) {
    showError(deps.errorEl, err);
    deps.spinButton.disabled = false;
  }
}

async function runComposedSpin(deps: IPlayModeDeps, walker: TraceWalker): Promise<void> {
  deps.spinButton.disabled = true;
  try {
    const res = await deps.client.spin(1);
    if (!res.trace) throw new PlayModeError('composed spin response carries no trace');
    await walker.walk(res.trace);
  } catch (err) {
    showError(deps.errorEl, err);
  } finally {
    deps.spinButton.disabled = false;
  }
}

/** Boot direct play-mode: handshake -> render scene -> wire the Spin gesture.
 *  Branches on the package family: slots@1 drives the Orchestrator (unchanged);
 *  composed@1 walks served traces through the TraceWalker. */
export async function startPlayMode(deps: IPlayModeDeps): Promise<void> {
  let hs: IHandshakeResponse;
  try {
    hs = await deps.client.handshake();
    if (hs.mechanic === 'composed@1') {
      const def = validateDefinition(hs.definition);
      const pres = validatePresentationShape(hs.presentation);
      await deps.host.handle({ v: 1, kind: 'init', id: 'play', document: buildComposedPlayDocument(def, pres, deps.rootSize) });
      const walker = new TraceWalker({ bus: deps.bus, resolve: deps.resolveTarget });
      deps.spinButton.hidden = false;
      deps.spinButton.addEventListener('click', () => {
        void runComposedSpin(deps, walker);
      });
      return;
    }
    const pres = validatePresentation(hs); // throws on any non-slots mechanic
    await deps.host.handle({ v: 1, kind: 'init', id: 'play', document: buildPlayDocument(pres, deps.rootSize) });
  } catch (err) {
    showError(deps.errorEl, err);
    return;
  }
  deps.bus.on('reels:settled', () => {
    deps.spinButton.disabled = false;
  });
  deps.spinButton.hidden = false;
  deps.spinButton.addEventListener('click', () => {
    void runSpin(deps);
  });
}

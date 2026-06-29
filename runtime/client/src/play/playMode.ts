import type { IGameDocument } from '../model/document';
import type { InboundMessage } from '../protocol/messages';
import type { IOutcome } from '../modules/module';
import type { IPresentation, IRuntimeClient } from './wireTypes';
import { validatePresentation, toReelsConfig } from './presentationConfig';
import { toClientOutcome } from './outcomeAdapter';

/** The minimal slices play-mode needs from the engine + DOM (so the orchestrator
 *  is unit-testable with fakes). The real ProtocolHost, event bus, and
 *  Orchestrator satisfy these structurally. */
export interface IPlayHost {
  handle(msg: InboundMessage): Promise<void>;
}
export interface IPlayBus {
  on(event: string, cb: (payload: unknown) => void): () => void;
}
export interface IPlayOrchestrator {
  spin(outcome: IOutcome): void;
}
export interface IPlayModeDeps {
  client: IRuntimeClient;
  host: IPlayHost;
  bus: IPlayBus;
  orchestrator: IPlayOrchestrator;
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

/** Boot direct play-mode: handshake -> render scene -> wire the Spin gesture. */
export async function startPlayMode(deps: IPlayModeDeps): Promise<void> {
  let pres: IPresentation;
  try {
    pres = validatePresentation(await deps.client.handshake());
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

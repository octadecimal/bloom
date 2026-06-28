import { PixiRenderer } from './render/pixiRenderer';
import { resolveTextureSrc } from './render/resolveSrc';
import { createEngine } from './engine';
import type { InboundMessage, OutboundMessage } from './protocol/messages';
import { parseParentOrigin, originAllowed } from './protocol/origin';
import { createSerializer } from './serialize';
import { domHostSurface, type IViewport } from './render/viewportController';
import { ReelsModule } from './modules/reels/reelsModule';

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage element');

const params = new URLSearchParams(window.location.search);

// When embedded by the studio, the iframe src carries ?parentOrigin=<studio origin>.
// Standalone (no param) keeps Plan 1 behavior: accept any origin, post with '*'.
const expectedOrigin = parseParentOrigin(window.location.search);

// The studio also passes ?mediaBase=<backend origin> so root-relative /media paths
// resolve to the cross-origin backend. Empty in standalone → identity resolution.
const mediaBase = params.get('mediaBase') ?? '';

const post = (m: OutboundMessage) => window.parent?.postMessage(m, expectedOrigin ?? '*');
const renderer = new PixiRenderer(stage, (s) => resolveTextureSrc(s, mediaBase));
const surface = domHostSurface(stage);
const { host, model, modules, viewport } = createEngine({ renderer, post, surface });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;
(window as unknown as { __engineRenderer: typeof renderer }).__engineRenderer = renderer;

// Standalone (no studio parent) keeps a default reels module so the runtime is
// usable on its own; embedded studio mode instead instantiates from the
// document's `modules` declaration on init.
if (!expectedOrigin) {
  modules.manager.sync([{ id: 'reels', type: 'reels', config: { parentId: 'root' } }]);
}

const reels = () => modules.manager.byType('reels') as ReelsModule | undefined;

const settledEvents: Array<{ grid: string[][] }> = [];
modules.bus.on<{ grid: string[][] }>('reels:settled', (e) => settledEvents.push(e));
(window as unknown as { __engineModules: unknown }).__engineModules = {
  spin: (outcome: { grid: string[][] }) => modules.orchestrator.spin(outcome),
  setConfig: (partial: Record<string, unknown>) => {
    const r = reels();
    if (r) {
      r.setConfig(partial as Record<string, never>);
      r.project();
    }
  },
  project: () => reels()?.project(),
  state: () => reels()?.debugState() ?? { phase: 'idle', grid: [] },
  settled: () => settledEvents,
};

(window as unknown as { __engineViewport: () => IViewport | null }).__engineViewport = () => viewport?.current() ?? null;
const viewportEvents: IViewport[] = [];
modules.bus.on<IViewport>('viewport:changed', (e) => viewportEvents.push(e));
(window as unknown as { __engineViewportEvents: IViewport[] }).__engineViewportEvents = viewportEvents;

// Serialize message handling: each handle() must complete before the next starts.
// Without this, concurrent handles race on async operations like renderer.mount()
// (which awaits Pixi's app.init()), causing setParent to silently no-op because
// the root object is not yet in the renderer's object map.
// createSerializer() also catches handle() rejections so a single failure cannot
// wedge the chain and drop all subsequent messages.
const enqueue = createSerializer();
window.addEventListener('message', (event: MessageEvent) => {
  if (!originAllowed(expectedOrigin, event.origin)) return;
  const msg = event.data as InboundMessage;
  enqueue(() => host.handle(msg));
});

host.start();

// Standalone mode: ?doc=<url> loads a document file directly (no studio).
const docUrl = params.get('doc');
if (docUrl) {
  void fetch(docUrl)
    .then((r) => r.json())
    .then((document) => host.handle({ v: 1, kind: 'init', id: 'standalone', document }));
}

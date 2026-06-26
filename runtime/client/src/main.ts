import { PixiRenderer } from './render/pixiRenderer';
import { resolveTextureSrc } from './render/resolveSrc';
import { createEngine } from './engine';
import type { InboundMessage, OutboundMessage } from './protocol/messages';
import { parseParentOrigin, originAllowed } from './protocol/origin';
import { createSerializer } from './serialize';

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
const { host, model, modules } = createEngine({ renderer, post });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;
(window as unknown as { __engineRenderer: typeof renderer }).__engineRenderer = renderer;

const settledEvents: Array<{ grid: string[][] }> = [];
modules.bus.on<{ grid: string[][] }>('reels:settled', (e) => settledEvents.push(e));
(window as unknown as { __engineModules: unknown }).__engineModules = {
  spin: (outcome: { grid: string[][] }) => modules.orchestrator.spin(outcome),
  setConfig: (partial: Record<string, unknown>) => {
    modules.reels.setConfig(partial as Record<string, never>);
    modules.reels.project();
  },
  project: () => modules.reels.project(),
  state: () => modules.reels.debugState(),
  settled: () => settledEvents,
};

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

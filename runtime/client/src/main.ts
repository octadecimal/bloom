import { PixiRenderer } from './render/pixiRenderer';
import { createEngine } from './engine';
import type { InboundMessage, OutboundMessage } from './protocol/messages';

const stage = document.getElementById('stage');
if (!stage) throw new Error('missing #stage element');

const post = (m: OutboundMessage) => window.parent?.postMessage(m, '*');
const renderer = new PixiRenderer(stage);
const { host, model } = createEngine({ renderer, post });

// Test/standalone observability.
(window as unknown as { __engineModel: typeof model }).__engineModel = model;

window.addEventListener('message', (event: MessageEvent) => {
  void host.handle(event.data as InboundMessage);
});

host.start();

// Standalone mode: ?doc=<url> loads a document file directly (no studio).
const docUrl = new URLSearchParams(window.location.search).get('doc');
if (docUrl) {
  void fetch(docUrl)
    .then((r) => r.json())
    .then((document) => host.handle({ v: 1, kind: 'init', id: 'standalone', document }));
}

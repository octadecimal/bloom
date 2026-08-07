// The judging UI is a single static page with inline script; this harness
// boots it in a fresh jsdom per test and drives it the way the operator does
// (keyboard events, controlled fetch). jsdom never fires image load events on
// its own, so the tests dispatch them explicitly — which also models the real
// browser behavior under test: assigning src its CURRENT value fires nothing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { expect, it, vi } from 'vitest';

const HTML = readFileSync(
  fileURLToPath(new URL('../matte_bench/static/index.html', import.meta.url)),
  'utf8',
);
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(HTML)![1];

const json = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
});

const COMPARISON = {
  subject: 's1',
  bucket: 'wispy',
  cls: 'B',
  left: 'aaaa11112222',
  right: 'bbbb33334444',
  plate_hash: null,
  repeat_of: null,
};

function boot(overrides: { next?: () => unknown } = {}) {
  const dom = new JSDOM(HTML, { url: 'http://localhost:8400/', runScripts: 'outside-only' });
  const w = dom.window;
  let resolveTechniques: (m: unknown) => void = () => {};
  const techniques = new Promise((r) => {
    resolveTechniques = (m: unknown) => r(json(m));
  });
  const fetch = vi.fn((url: string) => {
    if (url === '/api/techniques') return techniques;
    if (url === '/api/next')
      return Promise.resolve(overrides.next ? overrides.next() : json({ status: 'ready', comparison: COMPARISON }));
    if (url === '/api/progress') return Promise.resolve(json({ classes: [] }));
    if (url === '/api/verdict') return Promise.resolve(json({ recorded: true }));
    return Promise.resolve(json({}));
  });
  (w as unknown as { fetch: typeof fetch }).fetch = fetch;
  w.eval(SCRIPT);
  const img = (id: string) => w.document.getElementById(id) as HTMLImageElement;
  return {
    w,
    fetch,
    resolveTechniques,
    src: (id: string) => img(id).getAttribute('src'),
    fireLoads: () => {
      for (const id of ['imgL', 'imgR']) img(id).dispatchEvent(new w.Event('load'));
    },
    key: (k: string) => w.dispatchEvent(new w.KeyboardEvent('keydown', { key: k })),
    status: () => w.document.getElementById('status')!.textContent,
    meta: () => w.document.getElementById('meta')!.textContent,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

async function firstComparisonOnScreen(p: ReturnType<typeof boot>) {
  await vi.waitFor(() => {
    expect(p.src('imgL')).toBe(`/render/s1/${COMPARISON.left}.png`);
    expect(p.src('imgR')).toBe(`/render/s1/${COMPARISON.right}.png`);
  });
  p.fireLoads();
  await vi.waitFor(() => expect(p.meta()).toContain('s1'));
}

it('o-toggle before /api/techniques resolves shows own originals, not the plate', async () => {
  const p = boot();
  await firstComparisonOnScreen(p);

  // Operator hits `o` while the techniques map is still in flight. A Class B
  // side must never fall back to the shared plate — that is exactly the
  // misleading-original confusion the per-side originals were built to fix.
  p.key('o');
  await flush();
  expect(p.src('imgL')).toBe(`/render/s1/${COMPARISON.left}.png`);
  expect(p.src('imgR')).toBe(`/render/s1/${COMPARISON.right}.png`);

  p.resolveTechniques({
    [COMPARISON.left]: { label: 'backdrop-key/chroma-green', cls: 'B' },
    [COMPARISON.right]: { label: 'backdrop-key/chroma-magenta', cls: 'B' },
  });
  await vi.waitFor(() => {
    expect(p.src('imgL')).toBe(`/original/s1/${COMPARISON.left}.png`);
    expect(p.src('imgR')).toBe(`/original/s1/${COMPARISON.right}.png`);
  });
});

it('an o-press abandoned before /api/techniques resolves paints nothing later', async () => {
  const p = boot();
  await firstComparisonOnScreen(p);

  // Operator presses `o` with the techniques map still in flight, then
  // changes their mind and toggles back to render mode. When the map
  // finally lands, the abandoned original-paint must not fire — a stale
  // original silently replacing the current render-mode view is the exact
  // wrong-image failure a judging tool can least afford.
  p.key('o');
  await flush();
  p.key('o');
  await flush();
  p.resolveTechniques({
    [COMPARISON.left]: { label: 'backdrop-key/chroma-green', cls: 'B' },
    [COMPARISON.right]: { label: 'backdrop-key/chroma-magenta', cls: 'B' },
  });
  await flush();
  expect(p.src('imgL')).toBe(`/render/s1/${COMPARISON.left}.png`);
  expect(p.src('imgR')).toBe(`/render/s1/${COMPARISON.right}.png`);
});

it('a repeat comparison with identical render URLs still finishes loading', async () => {
  const p = boot();
  await firstComparisonOnScreen(p);

  // Voting brings back the same comparison (repeat pairs do this). The src
  // assignments are byte-identical, so the browser fires no load event — the
  // page must not hang on "loading images…" forever. (The alpha re-toggle
  // stalls the same way via identical canvas dataURLs, but jsdom has no
  // canvas — that path shares the setSrc mechanism pinned here.)
  p.key('ArrowDown');
  await vi.waitFor(() => expect(p.fetch.mock.calls.filter(([u]) => u === '/api/next').length).toBe(2));
  await vi.waitFor(() => {
    expect(p.status()).toBe('');
    expect(p.meta()).toContain('s1');
  });
});

it('a server error surfaces its detail in the status bar', async () => {
  // The live failure this pins: ComfyUI outages used to render as a bare
  // "Error: 500 Internal Server Error" (or worse, "No comparisons left").
  const p = boot({
    next: () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ detail: 'ComfyUI unreachable at http://gpu:8188: timed out' }),
    }),
  });
  await vi.waitFor(() => {
    expect(p.status()).toContain('ComfyUI unreachable at http://gpu:8188: timed out');
    expect(p.status()).toContain('reload to retry');
  });
});

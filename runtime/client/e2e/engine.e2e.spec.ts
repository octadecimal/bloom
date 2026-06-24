import { test, expect } from '@playwright/test';

const HARNESS = `
  <iframe id="engine" src="http://localhost:4300/" width="640" height="480" style="border:0"></iframe>
  <script>
    window.__inbound = [];
    const frame = document.getElementById('engine');
    window.addEventListener('message', (e) => window.__inbound.push(e.data));
    window.send = (msg) => frame.contentWindow.postMessage(msg, '*');
    window.engineModel = () => frame.contentWindow.__engineModel.toDocument();
  </script>`;

test('engine handshakes, accepts live ops, and reflects them in the model', async ({ page }) => {
  await page.goto('http://localhost:4300/');
  await page.setContent(HARNESS);

  // Handshake: the iframe posts `ready` to the parent.
  await expect.poll(() => page.evaluate(() => (window as any).__inbound.some((m: any) => m.kind === 'ready'))).toBe(true);

  // Live ops: build a root + sprite with no reload.
  await page.evaluate(() => {
    (window as any).send({ v: 1, kind: 'op', id: '1', op: { kind: 'addNode', id: 'root', type: 'Root', props: { width: 640, height: 480 } } });
    (window as any).send({ v: 1, kind: 'op', id: '2', op: { kind: 'addNode', id: 's', type: 'Sprite' } });
    (window as any).send({
      v: 1,
      kind: 'op',
      id: '3',
      op: { kind: 'connect', edgeId: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's', port: 'parent' } },
    });
  });

  await expect.poll(() => page.evaluate(() => (window as any).__inbound.filter((m: any) => m.kind === 'ack').length)).toBeGreaterThanOrEqual(3);
  const doc = await page.evaluate(() => (window as any).engineModel());
  expect(doc.nodes.s).toBeTruthy();
  expect(doc.edges).toHaveLength(1);
});

test('standalone mode builds a scene from ?doc=', async ({ page }) => {
  // Serve the fixture inline via a data URL passed to ?doc=.
  const doc = encodeURIComponent(
    JSON.stringify({
      version: 1,
      nodes: { root: { id: 'root', type: 'Root', props: { width: 640, height: 480 } }, s1: { id: 's1', type: 'Sprite', props: {} } },
      edges: [{ id: 'e1', type: 'child', from: { node: 'root', port: 'children' }, to: { node: 's1', port: 'parent' } }],
    }),
  );
  await page.goto(`http://localhost:4300/?doc=data:application/json,${doc}`);
  await expect.poll(() => page.evaluate(() => (window as any).__engineModel?.toDocument().nodes.s1 != null)).toBe(true);
});

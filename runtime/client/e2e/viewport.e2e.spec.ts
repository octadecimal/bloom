import { test, expect } from '@playwright/test';

const DOC = encodeURIComponent(
  JSON.stringify({
    version: 1,
    nodes: {
      root: {
        id: 'root',
        type: 'Root',
        props: { safeArea: { landscape: { width: 1280, height: 720 }, portrait: { width: 720, height: 1280 } } },
      },
    },
    edges: [],
  }),
);

const HARNESS = `
  <iframe id="engine" src="/?doc=data:application/json,${DOC}" width="1000" height="450" style="border:0"></iframe>
  <script>
    const frame = document.getElementById('engine');
    window.vp = () => frame.contentWindow.__engineViewport();
    window.vpEventCount = () => (frame.contentWindow.__engineViewportEvents || []).length;
    window.canvasWidth = () => {
      const c = frame.contentDocument.querySelector('canvas');
      return c ? c.clientWidth : null;
    };
    window.setFrame = (w, h) => { frame.width = w; frame.height = h; };
  </script>`;

test('fits the landscape safe area, centers it, and bleeds horizontally', async ({ page }) => {
  await page.goto('/');
  await page.setContent(HARNESS);

  await expect.poll(() => page.evaluate(() => (window as any).vp()?.orientation)).toBe('landscape');
  const vp = await page.evaluate(() => (window as any).vp());
  expect(vp.scale).toBeCloseTo(0.625, 3);
  expect(vp.offset).toEqual({ x: 100, y: 0 }); // symmetric horizontal bleed
  expect(vp.safeArea).toEqual({ width: 1280, height: 720 });

  // Canvas fills the host viewport (no fixed design buffer, no letterbox element).
  const cw = await page.evaluate(() => (window as any).canvasWidth());
  expect(Math.abs(cw - 1000)).toBeLessThanOrEqual(2);
});

test('swaps to the portrait safe area and fires viewport:changed on orientation flip', async ({ page }) => {
  await page.goto('/');
  await page.setContent(HARNESS);
  await expect.poll(() => page.evaluate(() => (window as any).vp()?.orientation)).toBe('landscape');

  await page.evaluate(() => (window as any).setFrame(450, 1000));

  await expect.poll(() => page.evaluate(() => (window as any).vp()?.orientation)).toBe('portrait');
  const vp = await page.evaluate(() => (window as any).vp());
  expect(vp.scale).toBeCloseTo(0.625, 3);
  expect(vp.offset).toEqual({ x: 0, y: 100 }); // vertical bleed now
  expect(vp.safeArea).toEqual({ width: 720, height: 1280 });

  // At least the initial landscape emit + the portrait emit.
  await expect.poll(() => page.evaluate(() => (window as any).vpEventCount())).toBeGreaterThanOrEqual(2);
});

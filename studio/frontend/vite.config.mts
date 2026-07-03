/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import path from 'node:path';

export default defineConfig(() => {
  // Per-worktree dev ports derive from a single BLOOM_PORT_OFFSET (0 = primary
  // checkout = today's defaults). Inline on purpose — keep the base values in sync
  // with the justfile and the other configs. See docs/worktrees.md.
  const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
  const frontend = 4200 + offset;
  const target = `http://localhost:${8000 + offset}`;
  // Derive VITE_BLOOM_ENGINE_PORT and VITE_BLOOM_BACKEND_PORT from BLOOM_PORT_OFFSET
  // when not explicitly set, so a fresh checkout with only BLOOM_PORT_OFFSET works
  // without any .env lines. Explicit env overrides still win (backward compatible).
  const enginePort = process.env.VITE_BLOOM_ENGINE_PORT ?? String(4300 + offset);
  const backendPort = process.env.VITE_BLOOM_BACKEND_PORT ?? String(8000 + offset);
  return {
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/studio/frontend',
    server: {
      port: frontend,
      host: '0.0.0.0',
      // Dev proxy: the browser talks only to the frontend origin and Vite forwards
      // API + WebSocket to the backend. Both ports follow BLOOM_PORT_OFFSET so
      // parallel worktrees never collide. Set the client's backend base URL to ''
      // (same-origin) to use this — see config.ts.
      proxy: {
        '/rooms': { target, changeOrigin: true },
        '/models': { target, changeOrigin: true },
        '/skills': { target, changeOrigin: true },
        '/tools': { target, changeOrigin: true },
        '/health': { target, changeOrigin: true },
        '/socket.io': { target, changeOrigin: true, ws: true },
        '/games': { target, changeOrigin: true },
        '/assets': { target, changeOrigin: true },
        '/media': { target, changeOrigin: true },
        '/analytics': { target, changeOrigin: true },
      },
    },
    preview: { port: frontend, host: '0.0.0.0' },
    define: {
      // Inject derived ports so import.meta.env.VITE_BLOOM_*_PORT resolve correctly
      // without needing .env lines. Explicit env overrides are already folded in above.
      'import.meta.env.VITE_BLOOM_ENGINE_PORT': JSON.stringify(enginePort),
      'import.meta.env.VITE_BLOOM_BACKEND_PORT': JSON.stringify(backendPort),
    },
    plugins: [react(), tailwindcss(), nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: '../../dist/studio/frontend',
      emptyOutDir: true,
      reportCompressedSize: true,
      commonjsOptions: {
        transformMixedEsModules: true,
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      include: ['src/**/*.{spec,test}.{ts,tsx}'],
      reporters: ['default'],
      setupFiles: ['./vitest.setup.ts'],
    },
  };
});

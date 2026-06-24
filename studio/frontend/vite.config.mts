/// <reference types='vitest' />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin';
import path from 'node:path';
import { resolvePorts, readRepoEnv } from '../../tools/ports.mts';

export default defineConfig(() => {
  const { backend, frontend } = resolvePorts(readRepoEnv());
  const target = `http://localhost:${backend}`;
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
      },
    },
    preview: { port: frontend, host: '0.0.0.0' },
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

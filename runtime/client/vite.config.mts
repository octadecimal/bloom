/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/runtime/client',
  server: { port: 4300, host: '0.0.0.0' },
  preview: { port: 4300, host: '0.0.0.0' },
  plugins: [nxViteTsPaths()],
  build: {
    outDir: '../../dist/runtime/client',
    emptyOutDir: true,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{spec,test}.ts'],
    reporters: ['default'],
  },
}));

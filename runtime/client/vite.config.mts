/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { resolvePorts, readRepoEnv } from '../../tools/ports.mts';

export default defineConfig(() => {
  const { runtime } = resolvePorts(readRepoEnv());
  return {
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/runtime/client',
    server: { port: runtime, host: '0.0.0.0' },
    preview: { port: runtime, host: '0.0.0.0' },
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
  };
});

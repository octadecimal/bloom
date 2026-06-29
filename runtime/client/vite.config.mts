/// <reference types='vitest' />
import { defineConfig } from 'vite';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';

export default defineConfig(() => {
  // Runtime dev port derives from BLOOM_PORT_OFFSET (0 = default 4300). See docs/worktrees.md.
  const offset = Number(process.env.BLOOM_PORT_OFFSET ?? 0) || 0;
  const runtime = 4300 + offset;
  return {
    root: import.meta.dirname,
    cacheDir: '../../node_modules/.vite/runtime/client',
    server: { port: runtime, host: '0.0.0.0' },
    preview: { port: runtime, host: '0.0.0.0' },
    plugins: [nxViteTsPaths()],
    define: {
      'import.meta.env.VITE_RUNTIME_SERVER_PORT': JSON.stringify(String(9000 + offset)),
    },
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

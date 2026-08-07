import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['ui-tests/**/*.spec.ts'],
  },
});

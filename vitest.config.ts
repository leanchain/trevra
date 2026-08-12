import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000
  }
});

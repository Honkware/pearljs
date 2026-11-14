import { defineConfig } from 'vitest/config';

// Live tests against a regtest pearld. They share one node and mine on it, so
// files run one at a time.
export default defineConfig({
  test: {
    include: ['test-live/**/*.test.ts'],
    globalSetup: ['test-live/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

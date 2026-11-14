import { defineConfig } from 'vitest/config';

// The live tests need pearld; they run through vitest.live.config.ts.
export default defineConfig({
  // XMSS keygen takes several seconds on a loaded machine.
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});

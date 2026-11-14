import { defineConfig } from 'vitest/config';

// The live tests need pearld; they run through vitest.live.config.ts.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'] },
});

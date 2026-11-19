import { defineConfig } from 'vitest/config';

// Mainnet blocks and transactions pearljs got wrong, saved by
// scripts/mainnet/walk.mjs and the other mainnet checks. No node is needed:
//
//   npx vitest run --config test-mainnet/vitest.config.ts
export default defineConfig({
  test: { root: '.', include: ['test-mainnet/**/*.test.ts'], testTimeout: 120_000 },
});

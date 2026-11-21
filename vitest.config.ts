import { configDefaults, defineConfig } from 'vitest/config';

// The suites under test/live, test/network and test/mainnet-blocks need a node or their own setup, and run through their own configs.
export default defineConfig({
  // XMSS keygen takes several seconds on a loaded machine.
  test: { include: ['test/**/*.test.ts'], exclude: [...configDefaults.exclude, 'test/live/**', 'test/network/**', 'test/mainnet-blocks/**'], testTimeout: 30_000 },
});

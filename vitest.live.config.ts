import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// The fresh-chain tests need a node that has seen no transaction, and the
// reorg replaces blocks under whatever runs after it.
const rank = (spec: TestSpecification): number =>
  spec.moduleId.endsWith('fresh-chain.test.ts') ? 0 : spec.moduleId.endsWith('reorg.test.ts') ? 2 : 1;

class InOrder extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId));
  }
}

// Live tests against a regtest pearld. They share one node and mine on it, so
// files run one at a time.
export default defineConfig({
  test: {
    include: ['test-live/**/*.test.ts'],
    globalSetup: ['test-live/global-setup.ts'],
    fileParallelism: false,
    sequence: { sequencer: InOrder },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

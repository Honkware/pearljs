import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// The fresh-chain tests need a node that has seen no transaction. The
// timelock tests come next, while the median time past is still that of the
// setup blocks. The files that walk every block run after the ones that make
// them, the reorg replaces blocks under whatever follows it, the interpreter
// test reads what every file before it sent to the node, and the Oyster feed
// test leaves Oyster without block notifications.
const ORDER = ['fresh-chain', 'timelocks', '', 'consensus', 'filters', 'reorg', 'interpreter', 'oyster-feed'];
const rank = (spec: TestSpecification): number => {
  const name = spec.moduleId.slice(spec.moduleId.lastIndexOf('/') + 1).replace('.test.ts', '');
  return ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.indexOf('');
};

class InOrder extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId));
  }
}

// Live tests against a regtest pearld. They share one node and mine on it, so
// files run one at a time. Proving a block takes seconds on an idle machine
// and several times that on a busy one, and a test that times out leaves its
// generate call running under the next test, so the time limits are generous.
export default defineConfig({
  test: {
    include: ['test-live/**/*.test.ts'],
    globalSetup: ['test-live/global-setup.ts'],
    fileParallelism: false,
    sequence: { sequencer: InOrder },
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

// Tests against a public test network: blocks come when other people mine
// them, so a test waits for them, and files run one at a time because they
// share one wallet store. The coin-free files come first, then the funded
// ones in the order they spend.
const ORDER = ['relay', 'messages', 'public-backends', 'wallet', 'backends', 'fees', 'p2mr', 'htlc', 'sweep-psbt', 'invoices'];
const rank = (spec: TestSpecification): number => {
  const id = spec.moduleId;
  const name = id.slice(id.lastIndexOf('/') + 1).replace('.test.ts', '');
  return ORDER.includes(name) ? ORDER.indexOf(name) : ORDER.length;
};

class InOrder extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return [...files].sort((a, b) => rank(a) - rank(b) || a.moduleId.localeCompare(b.moduleId));
  }
}

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    include: ['test-testnet/**/*.test.ts'],
    fileParallelism: false,
    sequence: { sequencer: InOrder },
    testTimeout: 4 * 3600_000,
    hookTimeout: 3600_000,
  },
});

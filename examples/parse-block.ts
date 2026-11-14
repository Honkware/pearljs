/**
 * Parse a full block, check what can be checked without the proof, and read
 * the consensus numbers for its header.
 *
 * Runs offline from the repository root: the blocks come from
 * vectors/pearl-go.json, which Pearl's Go code wrote. From a node, the bytes
 * come from PearldClient.getRawBlock.
 */
import { readFileSync } from 'node:fs';
import {
  blockHashHex,
  blockSize,
  blockVsize,
  checkCertificateBinding,
  checkMerkleRoot,
  checkWitnessCommitment,
  difficultyForBits,
  isMoECertificate,
  networks,
  parseBlock,
  transactionId,
  workForBits,
} from 'pearljs';

interface BlockVector {
  name: string;
  hex: string;
  hash: string;
}
const vectors = JSON.parse(readFileSync('vectors/pearl-go.json', 'utf8')) as { blocks: BlockVector[] };

for (const name of ['v1-one-spend', 'v2-dense-two-spends', 'v3-four-spends']) {
  const vector = vectors.blocks.find((block) => block.name === name);
  if (vector === undefined) throw new Error(`no block vector named ${name}`);
  const block = parseBlock(Buffer.from(vector.hex, 'hex'));

  // Each throws when the block does not hold together.
  checkCertificateBinding(block);
  checkWitnessCommitment(block);
  checkMerkleRoot(block);

  const { certificate, header } = block;
  console.log(name);
  console.log('  hash       ', blockHashHex(header), blockHashHex(header) === vector.hash ? '(matches Pearl)' : '(differs)');
  console.log('  time       ', new Date(header.timestamp * 1000).toISOString());
  console.log('  certificate', certificate === null ? 'none' : `V${certificate.version}, ${certificate.proof.length} byte proof, MoE ${isMoECertificate(certificate)}`);
  console.log('  size       ', blockSize(block), 'bytes,', blockVsize(block), 'vbytes');
  console.log('  difficulty ', difficultyForBits(header.bits, networks.mainnet), 'work', workForBits(header.bits));
  console.log('  txids      ', block.transactions.map((tx) => transactionId(tx).slice(0, 12)).join(' '));
}

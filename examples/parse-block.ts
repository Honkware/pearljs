/**
 * Parse a full block, check what can be checked without the proof, and read
 * the consensus numbers for its header.
 *
 * Runs offline: the block comes from pearljs/testing's SimulatedChain, which
 * builds real headers, merkle roots and witness commitments around a
 * placeholder proof. From a node, the bytes come from
 * PearldClient.getRawBlock.
 */
import {
  blockHashHex,
  blockSize,
  blockVsize,
  checkCertificateBinding,
  checkMerkleRoot,
  checkWitnessCommitment,
  difficultyForBits,
  isMoECertificate,
  parseBlock,
  serializeBlock,
  transactionId,
  workForBits,
} from 'pearljs';
import { SimulatedChain, testAccount } from 'pearljs/testing';

const chain = new SimulatedChain();
const account = testAccount(0, chain.network);
for (let i = 0; i < 3; i += 1) chain.pay(account.deriveAddress(i), 1_000_000n * BigInt(i + 1));
chain.mine();

// The bytes getblock returns with verbosity 0.
const raw = serializeBlock(chain.tip.block);
const block = parseBlock(raw);

// Each throws when the block does not hold together.
checkCertificateBinding(block);
checkWitnessCommitment(block);
checkMerkleRoot(block);

const { certificate, header } = block;
console.log('hash       ', blockHashHex(header));
console.log('time       ', new Date(header.timestamp * 1000).toISOString());
console.log('certificate', certificate === null ? 'none' : `V${certificate.version}, ${certificate.proof.length} byte proof, MoE ${isMoECertificate(certificate)}`);
console.log('size       ', blockSize(block), 'bytes,', blockVsize(block), 'vbytes');
console.log('difficulty ', difficultyForBits(header.bits, chain.network), 'work', workForBits(header.bits));
console.log('txids      ', block.transactions.map((tx) => transactionId(tx).slice(0, 12)).join(' '));

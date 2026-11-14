// Network parameters for Pearl, mirroring chaincfg/params.go in the Pearl
// source. Pearl has no signet in operation, so none is defined here. Values
// that Pearl does not use (pubKeyHash, scriptHash) are deliberately absent
// rather than filled with Bitcoin defaults.

/**
 * The five Pearl networks and their parameters, from Pearl's Go source.
 *
 * @module
 */

/** The name of a Pearl network, a key of `networks`. */
export type PearlNetworkName = 'mainnet' | 'testnet' | 'testnet2' | 'regtest' | 'simnet';

/** Parameters of one Pearl network, from Pearl's chaincfg. */
export interface PearlNetwork {
  /** Lowercase canonical name, e.g. "mainnet". */
  name: PearlNetworkName;
  /** P2P message magic, wire.PearlNet. */
  magic: number;
  /** Default peer-to-peer port. */
  defaultPort: number;
  /** Bech32m human-readable part for witness addresses. */
  bech32Hrp: string;
  /** First byte of a WIF private key. */
  wif: number;
  /** 4-byte version prefix of an HD private key, big-endian. */
  hdPrivateKeyId: number;
  /** 4-byte version prefix of an HD public key, big-endian. */
  hdPublicKeyId: number;
  /** BIP-44 coin type. */
  coinType: number;
  /** Genesis block hash as display-order hex (reversed from wire order). */
  genesisHash: string;
  /**
   * Header used by Pearl's signed-message format, from
   * messageSignatureHeader in rpcserver.go. Pearl does not vary it per
   * network.
   */
  messagePrefix: string;
  /**
   * Heights at which Pearl's forks activate, 0 where a fork is disabled. MoE
   * and SaltedSeed are hard forks to V2 and V3 certificates; DenseOnly and
   * RankPenalty are soft forks that tighten what a certificate may carry.
   */
  forkHeights: ForkHeights;
  /** Known-good blocks, oldest first, hashes as display-order hex. */
  checkpoints: readonly Checkpoint[];
  /** DNS seed hostnames. Empty on regtest and simnet. */
  dnsSeeds: readonly string[];
  /** TargetTimePerBlock in seconds; also sets the emission curve. */
  targetSpacing: number;
  /** WTEMAHalfLife of the per-block difficulty filter, in seconds. */
  wtemaHalfLife: number;
  /** The highest target a block may have. */
  powLimit: bigint;
  /** powLimit in compact form, the bits getdifficulty divides by. */
  powLimitBits: number;
  /** Confirmations before a coinbase output can be spent. 100 on every network. */
  coinbaseMaturity: number;
}

/** Activation heights of Pearl's forks on one network, 0 where a fork is off. */
export interface ForkHeights {
  /** From this height blocks need a V2 certificate. */
  moe: number;
  /** From this height MoE proofs are refused. */
  denseOnly: number;
  /** From this height the rank-penalty rule applies. pearljs does not check that rule. */
  rankPenalty: number;
  /** From this height blocks need a V3 certificate. */
  saltedSeed: number;
}

/** A known-good block. */
export interface Checkpoint {
  height: number;
  /** Display-order hex. */
  hash: string;
}

const MESSAGE_PREFIX = 'Pearl Signed Message:\n';
const TARGET_SPACING = 194; // 3 minutes 14 seconds
const WTEMA_HALF_LIFE = 168 * 60 * 60; // one week
const COINBASE_MATURITY = 100;
// Mainnet and the testnets share 2^208 - 1.
const PUBLIC_POW_LIMIT = (1n << 208n) - 1n;
const LOCAL_POW_LIMIT = (1n << 233n) - 1n;
const seeds = (domain: string): string[] => ['reef', 'tide', 'stream'].map((name) => `${name}.seeder.${domain}`);

/** Pearl mainnet. Addresses start with prl1, coin type 808276. */
export const mainnet: PearlNetwork = {
  name: 'mainnet',
  magic: 0x50524c4d, // "PRLM"
  defaultPort: 44108,
  bech32Hrp: 'prl',
  wif: 0x80,
  hdPrivateKeyId: 0x04b2430c, // zprv
  hdPublicKeyId: 0x04b24746, // zpub
  coinType: 808276,
  genesisHash:
    'a18d3093b7ff618f0cdd073fa3d10374e2e0105fe7ef53ff48b55f41c58dadd7',
  messagePrefix: MESSAGE_PREFIX,
  forkHeights: { moe: 71935, denseOnly: 91630, rankPenalty: 96251, saltedSeed: 99000 },
  checkpoints: [
    { height: 10000, hash: 'a3c196fb1c3f7837bbebd69b98fc451d88d48083af98c318c78486d7f1888490' },
    { height: 20000, hash: '513270b25c6d538f38b26ecdc014f2a809639ec7ebd3c09e4685675311420273' },
    { height: 30000, hash: 'fd61132c2ad6c22fa48a8df483bc6b885c12ceeb3fe0a9fa55eb5beb849fac7b' },
    { height: 40000, hash: '35aac0e2a1e7f2d54924d584cf423b56f0d72d6770ee8365dc1667dbb5b5b320' },
    { height: 50000, hash: '608f32e5390b2ae964c986a53e1be10ba4a640f3ccecf96d6b7838e06cb517ff' },
    { height: 60000, hash: '5a7f0590c3a89099b2d0f1509d2186c73bc3d8e2e4a60e7ce4ec236856900dad' },
    { height: 70000, hash: '281a3469d55226bb9e1b3ccee06eeb923177817b4cdead75131074b171b215c1' },
    { height: 80000, hash: '69d40caca39b3c04ee55589d13cd1c5c546a3eb8712a3367840c5f67ab707cfc' },
    { height: 90000, hash: '0738b30bb353820a4f97331d805d134de4321a5fc5c8b2955988e7291a0c8562' },
    { height: 100000, hash: 'ca8d5f604a9021e538f31472d9a9641c7bc46a6b8d591748e2869429571edbfb' },
    { height: 110000, hash: 'c119b81da722428e61dcda4ec1d6a2a56e6e40acb29592d11081538ab3d50630' },
    { height: 120000, hash: 'a5f57e441de1da43a27b4bee471c7a7bdd8e36664050385bf0a1b760d2a84b7d' },
  ],
  dnsSeeds: seeds('pearlnetwork.net'),
  targetSpacing: TARGET_SPACING,
  wtemaHalfLife: WTEMA_HALF_LIFE,
  powLimit: PUBLIC_POW_LIMIT,
  powLimitBits: 0x1b00ffff,
  coinbaseMaturity: COINBASE_MATURITY,
};

/** The first test network. Shares its address prefix (tprl), WIF byte and HD versions with testnet2. */
export const testnet: PearlNetwork = {
  name: 'testnet',
  magic: 0x50524c31, // "PRL1"
  defaultPort: 44110,
  bech32Hrp: 'tprl',
  wif: 0xef,
  hdPrivateKeyId: 0x045f18bc, // vprv
  hdPublicKeyId: 0x045f1cf6, // vpub
  coinType: 1,
  genesisHash:
    '10f0be7be9950f74021d0f7c62989d1e2541c4d46f3c95b74e61679864b43d18',
  messagePrefix: MESSAGE_PREFIX,
  forkHeights: { moe: 1, denseOnly: 28262, rankPenalty: 36763, saltedSeed: 38648 },
  checkpoints: [],
  dnsSeeds: seeds('testnet.pearlnetwork.net'),
  targetSpacing: TARGET_SPACING,
  wtemaHalfLife: WTEMA_HALF_LIFE,
  powLimit: PUBLIC_POW_LIMIT,
  powLimitBits: 0x1b00ffff,
  coinbaseMaturity: COINBASE_MATURITY,
};

// Testnet2 is a fresh chain that keeps the testnet address and HD params.
/** The test network v2, a fresh chain with testnet's address and key parameters. Pearl's desktop wallet uses it for its Testnet setting. */
export const testnet2: PearlNetwork = {
  name: 'testnet2',
  magic: 0x50524c32, // "PRL2"
  defaultPort: 44112,
  bech32Hrp: 'tprl',
  wif: 0xef,
  hdPrivateKeyId: 0x045f18bc, // vprv
  hdPublicKeyId: 0x045f1cf6, // vpub
  coinType: 1,
  genesisHash:
    'b0c86d0cd8825f4d72260d2de46f470429eece413811d5d82b5f2e2ea0336f96',
  messagePrefix: MESSAGE_PREFIX,
  forkHeights: { moe: 54869, denseOnly: 80051, rankPenalty: 80627, saltedSeed: 83109 },
  checkpoints: [],
  dnsSeeds: seeds('testnet2.pearlnetwork.net'),
  targetSpacing: TARGET_SPACING,
  wtemaHalfLife: WTEMA_HALF_LIFE,
  powLimit: PUBLIC_POW_LIMIT,
  powLimitBits: 0x1b00ffff,
  coinbaseMaturity: COINBASE_MATURITY,
};

/** The regression test network, for local nodes. Shares its address prefix (rprl) with simnet. */
export const regtest: PearlNetwork = {
  name: 'regtest',
  magic: 0x50524c52, // "PRLR"
  defaultPort: 18444,
  bech32Hrp: 'rprl',
  wif: 0xef,
  hdPrivateKeyId: 0x045f18bc, // vprv
  hdPublicKeyId: 0x045f1cf6, // vpub
  coinType: 1,
  genesisHash:
    '78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832',
  messagePrefix: MESSAGE_PREFIX,
  forkHeights: { moe: 1, denseOnly: 0, rankPenalty: 1, saltedSeed: 1 },
  checkpoints: [],
  dnsSeeds: [],
  targetSpacing: TARGET_SPACING,
  wtemaHalfLife: WTEMA_HALF_LIFE,
  powLimit: LOCAL_POW_LIMIT,
  powLimitBits: 0x1e010000,
  coinbaseMaturity: COINBASE_MATURITY,
};

// Simnet shares the regtest genesis block but has its own magic, port,
// WIF byte and HD key IDs (sprv/spub).
/** The simulation test network. Shares regtest's genesis block and address prefix; has its own WIF byte and HD versions. */
export const simnet: PearlNetwork = {
  name: 'simnet',
  magic: 0x50524c53, // "PRLS"
  defaultPort: 18555,
  bech32Hrp: 'rprl',
  wif: 0x64,
  hdPrivateKeyId: 0x0420b900, // sprv
  hdPublicKeyId: 0x0420bd3a, // spub
  coinType: 1,
  genesisHash:
    '78d0ab27df6a51a8e9dbbdefffca1ebbbeb3818cb083ce2c2f43b047247e5832',
  messagePrefix: MESSAGE_PREFIX,
  forkHeights: { moe: 1, denseOnly: 0, rankPenalty: 0, saltedSeed: 1 },
  checkpoints: [],
  dnsSeeds: [],
  targetSpacing: TARGET_SPACING,
  wtemaHalfLife: WTEMA_HALF_LIFE,
  powLimit: LOCAL_POW_LIMIT,
  powLimitBits: 0x1e010000,
  coinbaseMaturity: COINBASE_MATURITY,
};

/** The five Pearl networks by name. */
export const networks: Readonly<Record<PearlNetworkName, PearlNetwork>> = {
  mainnet,
  testnet,
  testnet2,
  regtest,
  simnet,
};



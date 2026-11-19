// Every error a caller would plausibly catch is a PearlError with a stable
// string code. Wrong argument types and out-of-range indices stay TypeError
// and RangeError: those are mistakes in the calling code, not conditions to
// branch on.
//
// Messages are for people and may gain detail; codes are the contract. No
// message or field holds key material, a mnemonic word, a WIF or a password.

/**
 * The errors pearljs throws, each with a stable `code`.
 *
 * @module
 */

/** Every code a PearlError can carry. docs/errors.md says when each is thrown. */
export type PearlErrorCode =
  // Addresses
  | 'ADDRESS_MALFORMED'
  | 'ADDRESS_BAD_CHECKSUM'
  | 'ADDRESS_WRONG_NETWORK'
  | 'ADDRESS_UNSUPPORTED_VERSION'
  | 'ADDRESS_WRONG_LENGTH'
  | 'ADDRESS_UNSUPPORTED_SCRIPT'
  // Amounts and fee rates
  | 'AMOUNT_INVALID'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'FEE_RATE_INVALID'
  // Keys, WIF, mnemonics
  | 'KEY_INVALID'
  | 'WIF_MALFORMED'
  | 'WIF_BAD_CHECKSUM'
  | 'WIF_WRONG_NETWORK'
  | 'MNEMONIC_INVALID'
  | 'SEED_INVALID'
  | 'EXTENDED_KEY_INVALID'
  // Parsing
  | 'TX_MALFORMED'
  | 'PSBT_MALFORMED'
  | 'BLOCK_MALFORMED'
  | 'CERTIFICATE_MALFORMED'
  | 'FILTER_MALFORMED'
  | 'SIGNATURE_MALFORMED'
  // Scripts and trees
  | 'SCRIPT_MALFORMED'
  | 'SCRIPT_INVALID'
  | 'SCRIPT_TREE_INVALID'
  | 'CONTROL_BLOCK_INVALID'
  | 'LEAF_COMMITMENT_MISMATCH'
  | 'SCRIPT_REJECTED'
  // Block checks
  | 'BLOCK_CERTIFICATE_INVALID'
  | 'BLOCK_MERKLE_ROOT_MISMATCH'
  | 'BLOCK_WITNESS_COMMITMENT_INVALID'
  | 'BLOCK_HEADER_INVALID'
  | 'FILTER_HEADER_MISMATCH'
  | 'CROSS_CHECK_FAILED'
  | 'CROSS_CHECK_UNSUPPORTED'
  // checkSanity
  | 'SANITY_NO_INPUTS'
  | 'SANITY_NO_OUTPUTS'
  | 'SANITY_TX_TOO_LARGE'
  | 'SANITY_OUTPUT_SCRIPT'
  | 'SANITY_OUTPUT_NEGATIVE'
  | 'SANITY_OUTPUT_TOO_LARGE'
  | 'SANITY_TOTAL_TOO_LARGE'
  | 'SANITY_DUPLICATE_INPUTS'
  | 'SANITY_COINBASE_SCRIPT'
  | 'SANITY_COINBASE'
  | 'SANITY_NULL_INPUT'
  | 'SANITY_INPUTS_BELOW_OUTPUTS'
  // checkStandard
  | 'POLICY_NO_WITNESS'
  | 'POLICY_TX_TOO_SMALL'
  | 'POLICY_VERSION'
  | 'POLICY_NOT_FINAL'
  | 'POLICY_TX_TOO_LARGE'
  | 'POLICY_SIGSCRIPT_SIZE'
  | 'POLICY_SIGSCRIPT_NOT_PUSH_ONLY'
  | 'POLICY_DUST'
  | 'POLICY_MULTIPLE_NULLDATA'
  | 'POLICY_NONSTANDARD_INPUT'
  | 'POLICY_FEE_TOO_LOW'
  | 'POLICY_FEE_TOO_HIGH'
  // Replacement and package limits
  | 'RBF_TOO_MANY_EVICTIONS'
  | 'RBF_NOT_REPLACEABLE'
  | 'RBF_SPENDS_CONFLICT'
  | 'RBF_FEE_RATE_TOO_LOW'
  | 'RBF_FEE_TOO_LOW'
  | 'RBF_NEW_UNCONFIRMED_INPUT'
  | 'PACKAGE_TOO_LONG'
  // Building payments
  | 'PAYMENT_INVALID'
  | 'UTXO_INVALID'
  | 'INSUFFICIENT_FUNDS'
  // Signing
  | 'SIGHASH_NOT_ALLOWED'
  | 'SIGHASH_UNSUPPORTED'
  | 'PREVIOUS_TRANSACTIONS_MISSING'
  | 'PREVOUT_MISMATCH'
  | 'FEE_TOO_HIGH'
  | 'OUTPUTS_EXCEED_INPUTS'
  | 'INPUT_UNPREPARED'
  | 'INPUT_MISMATCH'
  | 'DERIVATION_NOT_FOUND'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURES_MISSING'
  | 'WITNESS_ITEMS_NEEDED'
  | 'INPUT_NOT_FINALIZED'
  | 'OUTPUT_MISMATCH'
  | 'PSBT_RECIPIENT_MISSING'
  | 'PSBT_OUTPUT_UNEXPECTED'
  | 'TRANSACTION_MISMATCH'
  | 'SIGNER_DESTROYED'
  // XMSS
  | 'XMSS_INDEX_EXHAUSTED'
  | 'XMSS_INDEX_REUSE'
  | 'XMSS_STORE_LOCKED'
  | 'XMSS_STORE_INVALID'
  | 'XMSS_KEY_INVALID'
  | 'XMSS_SIGNATURE_INVALID'
  | 'XMSS_KEY_RESTORED'
  | 'XMSS_KEY_BEHIND'
  // Messages
  | 'MESSAGE_INVALID'
  // RPC and backends
  | 'RPC_ERROR'
  | 'RPC_HTTP'
  | 'RPC_NETWORK'
  | 'RPC_RESPONSE'
  | 'BACKEND_MISSING_INDEX'
  | 'BACKEND_UNSUPPORTED'
  | 'BACKEND_RESPONSE'
  | 'BACKEND_WRONG_NETWORK'
  // Invoices
  | 'INVOICE_INVALID'
  | 'INVOICE_JSON_INVALID'
  | 'INVOICE_PAYER_UNKNOWN'
  | 'INVOICE_GAP_LIMIT'
  // Reading the chain
  | 'INSPECT_PREVOUTS'
  | 'PREVOUT_NOT_FOUND'
  | 'FOLLOW_REORG_TOO_DEEP'
  | 'FOLLOW_START_UNKNOWN'
  // The test kit
  | 'SIMULATION_INVALID'
  | 'REGTEST_FAILED'
  // Wallet stores
  | 'STORE_LOCKED'
  | 'STORE_NOT_FOUND'
  | 'STORE_EXISTS'
  | 'STORE_INVALID'
  | 'STORE_CLOSED'
  | 'STORE_UNAVAILABLE'
  | 'STORE_CONFLICT'
  | 'STORE_WRITE_FAILED'
  // Keystore
  | 'KEYSTORE_BAD_PASSPHRASE'
  | 'KEYSTORE_TAMPERED'
  | 'KEYSTORE_INVALID'
  | 'KEYSTORE_LOCKED'
  | 'KEYSTORE_NO_SECRET'
  // Wallet
  | 'WALLET_LOCKED'
  | 'WALLET_WATCH_ONLY'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_EXISTS'
  | 'WALLET_WRONG_NETWORK'
  | 'WALLET_SCHEMA'
  | 'WALLET_UNKNOWN'
  | 'WALLET_DUPLICATE'
  | 'WALLET_GAP_LIMIT'
  | 'WALLET_NOT_REPLACEABLE'
  | 'WALLET_BROADCAST_REFUSED'
  | 'WALLET_BROADCAST_UNCERTAIN'
  | 'WALLET_TRANSACTION_KNOWN'
  | 'WALLET_BACKUP_INVALID'
  | 'WALLET_NOT_PREPARED'
  | 'WALLET_CLOSED'
  // Mining
  | 'MINING_TEMPLATE_INVALID'
  | 'JACKPOT_ABOVE_TARGET'
  | 'GATEWAY_MESSAGE_INVALID';

/** What toJSON returns and fromJSON reads. */
export interface PearlErrorJson {
  name: string;
  code: PearlErrorCode;
  message: string;
}

/**
 * The base of every error pearljs throws for a condition a caller can act
 * on. Branch on `code`; the message is for people.
 *
 * structuredClone and postMessage keep an error's message and drop its
 * other fields, so send `error.toJSON()` across a worker boundary and
 * rebuild it with PearlError.fromJSON.
 */
export class PearlError extends Error {
  override name = 'PearlError';
  readonly code: PearlErrorCode;

  constructor(code: PearlErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }

  /** The name, code and message. Fields a subclass adds, and the cause, are left out. */
  toJSON(): PearlErrorJson {
    return { name: this.name, code: this.code, message: this.message };
  }

  /** A PearlError with the code and message of toJSON output. The subclass is not restored. */
  static fromJSON(json: { code: PearlErrorCode; message: string }): PearlError {
    return new PearlError(json.code, json.message);
  }
}

/** Text that is not an address for the network, or a script that has no address. */
export class AddressError extends PearlError {
  override name = 'AddressError';
}

/**
 * A transaction pearld would refuse. The message is pearld's own; the code
 * names the rule: SANITY_* from checkSanity, POLICY_* from checkStandard,
 * RBF_* from checkReplacement and PACKAGE_TOO_LONG from checkPackageLimits.
 */
export class PolicyError extends PearlError {
  override name = 'PolicyError';
}

/** A signer or finalizer refused, before or after signing. Nothing was broadcast. */
export class SigningError extends PearlError {
  override name = 'SigningError';
}

/** An XMSS key, signature or index store problem. */
export class XmssError extends PearlError {
  override name = 'XmssError';
}

/** A wallet store that is locked, missing, damaged, closed, written by someone else, or unable to write. */
export class StoreError extends PearlError {
  override name = 'StoreError';
}

/** A keystore that is locked, damaged, or opened with the wrong passphrase. Never carries a passphrase or a secret. */
export class KeystoreError extends PearlError {
  override name = 'KeystoreError';
}

/** A wallet operation refused: locked, watch-only, unknown item, gap limit, a broadcast that failed. */
export class WalletError extends PearlError {
  override name = 'WalletError';
}

/**
 * Where a call failed: `rpc` is an error reply from the server, `http` an HTTP
 * error status, `network` an unreachable server or a timeout, `response` a reply
 * that is not JSON-RPC.
 */
export type RpcErrorKind = 'rpc' | 'http' | 'network' | 'response';

const RPC_CODES = { rpc: 'RPC_ERROR', http: 'RPC_HTTP', network: 'RPC_NETWORK', response: 'RPC_RESPONSE' } as const;

/**
 * Any failed call: an RPC error reply, an HTTP failure, an unreachable server
 * or a malformed reply. `code` follows `kind`; the number the server sent is
 * `rpcCode`.
 */
export class PearlRpcError extends PearlError {
  override name = 'PearlRpcError';
  readonly kind: RpcErrorKind;
  readonly method: string;
  /** JSON-RPC error code, for kind "rpc"; compare with RPC_ERROR_CODES. */
  readonly rpcCode: number | undefined;
  /** HTTP status, for kind "http". */
  readonly status: number | undefined;

  constructor(
    kind: RpcErrorKind,
    method: string,
    message: string,
    extra: { rpcCode?: number; status?: number; cause?: unknown } = {},
  ) {
    super(RPC_CODES[kind], `${method}: ${message}`, extra);
    this.kind = kind;
    this.method = method;
    this.rpcCode = extra.rpcCode;
    this.status = extra.status;
  }
}

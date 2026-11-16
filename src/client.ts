/**
 * Minimal read-only chain view used by watch-only invoice monitoring.
 *
 * A ChainClient abstracts where chain data comes from (an indexer, an
 * Electrum or Esplora endpoint, a full node, or an in-memory fake for
 * tests and demos). The invoice module depends only on this interface,
 * never on a concrete RPC transport.
 *
 * @module
 */

/** Reference to a block in the best chain. */
export interface BlockRef {
  readonly height: number;
  readonly hash: string;
  /**
   * The block header's timestamp, epoch seconds, when the backend knows it.
   * Invoices judge a confirmed payment's punctuality by it; without it they
   * can only go by when they first saw the payment.
   */
  readonly time?: number;
}

/**
 * A transaction paying an address, possibly still unconfirmed. A backend
 * aggregates all outputs to that address into one amount per transaction.
 */
export interface AddressPayment {
  readonly txid: string;
  /** Total paid to the address by this transaction, in grains. */
  readonly amount: bigint;
  /** Confirming block, or null while the payment sits in the mempool. */
  readonly block: BlockRef | null;
  /**
   * When the backend itself first saw the transaction, epoch seconds, if it
   * keeps that. Invoices take the earlier of this and their own first sight.
   */
  readonly seenAt?: number;
}

/** A transaction as currently known to the chain view. */
export interface ChainTransaction {
  readonly txid: string;
  /** Confirming block, or null while the transaction is unconfirmed. */
  readonly block: BlockRef | null;
}

/** Read-only view of the chain required to refresh invoices. */
export interface ChainClient {
  /** Current tip of the best chain. */
  getTip(): Promise<BlockRef>;
  /** All payments currently observed paying the given address. */
  getAddressActivity(address: string): Promise<readonly AddressPayment[]>;
  /** A transaction by txid, or null when the chain view no longer knows it. */
  getTransaction(txid: string): Promise<ChainTransaction | null>;
}

# Scope

pearljs is the client side of Pearl, for wallets and payment services as well as pools, explorers and scripts. It holds keys, builds and signs transactions, and reads the chain through a pearld node, an Oyster wallet or a Blockbook server. It leaves the rest to the node and to the application that uses it.

## Covered

### Keys and addresses

pearljs reads recovery phrases and derives BIP86 accounts from them, makes watch-only accounts from an extended public key, and reads single keys in WIF. It handles both of Pearl's address types, P2TR and P2MR. For a recovery phrase whose restore shows less than it should, it derives the phrase every way Pearl's wallets have and reports what each derivation holds ([Recover a seed that shows zero](../guides/recovery.md)).

### Transactions

Coins are selected the way Oyster selects them, and a payment can add change, send everything, or raise the fee of an earlier payment.

pearljs signs on key paths and on the script paths of both output types, including multisig, timelock, hash timelock and XMSS leaves, and its signing handles annexes and code separators. The outputs it builds are P2TR, P2MR and OP_RETURN, the three kinds Pearl's consensus accepts.

PSBTs carry a transaction from a watch-only machine to an offline signer, between co-signers, and to hardware and other asynchronous signers. Messages are signed and verified in three formats: Oyster's, BIP-322's and pearld's legacy format.

### Nodes, servers and wallets

Typed clients cover every pearld and Oyster RPC method except `help`, over HTTP and websocket, and other clients cover Blockbook's REST and websocket APIs.

A wallet backend reads the chain through pearld's address index or its compact filters, or through Oyster or a Blockbook ([Choosing a backend](choosing-a-backend.md)). pearljs also discovers an account's addresses, follows the chain through reorganizations, and tracks invoices.

### Wallet state

An encrypted keystore holds the secrets, and sessions unlock it again in a browser extension's restarted worker. The wallet keeps its addresses, transactions and pending sends in step with the chain through reorganizations, restarts and restores.

### Chain data and mining

pearljs parses blocks and their V1 to V4 certificates. It carries the consensus parameters of the five networks and the relay policy pearld applies, and its script interpreter follows Pearl's engine.

For mining, it turns block templates into blocks and computes the hashes and bounds that bind a miner's work to a header. It also speaks pearl-gateway's protocol and computes a pool's effort and luck. Pearl's verifier, compiled to WebAssembly, checks a V1 to V4 certificate's ZK proof and a miner's plain proof.

### Testing

A simulated chain, node and Blockbook serve an application's tests, and a launcher starts a real pearld on regtest.

[Compatibility verification](../project/verification.md) describes how each part is checked against Pearl's own code, a live pearld and Pearl's servers.

## Left to the node

A node decides what is valid, and pearljs builds what a node accepts and reads what a node has accepted. It checks a block's certificate, roots and proof, and runs a transaction's scripts as Pearl's engine does, but it does not track a chain's UTXO set or speak the peer-to-peer protocol. Validating a chain therefore still takes a pearld, or a server that runs one.

## Left to the application

Outside the wallet module, pearljs keeps no state between calls. Its functions are given what they need, such as a list of unspent outputs, a mempool or an invoice.

`PearlWallet` is the part that remembers. It keeps which addresses were handed out and which outputs are spent by sends not yet confirmed, along with history, locked outputs and XMSS indices, and it keeps the keys too, encrypted. All of this goes in a store the application chooses: memory, a file under Node, or IndexedDB in a browser ([Wallets](../concepts/wallet.md)).

The application still decides where that store lives and backs it up. It also keeps its own open invoices, and it decides what to sign.

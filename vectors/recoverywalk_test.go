// Which payments Oyster's restore finds, for test/fixtures/oyster-recovery-walk.json.
// The file joins Oyster's wallet package through a build overlay, so it can
// run the real recovery (Wallet.recovery, recoverScopedAddresses), which is
// unexported. From a Pearl source checkout:
//
//	echo '{"Replace":{"/path/to/pearl/wallet/wallet/pearljs_recoverywalk_test.go":"/path/to/pearljs/vectors/recoverywalk_test.go"}}' > /tmp/overlay.json
//	PEARLJS_RECOVERY_WALK=/path/to/pearljs/test/fixtures/oyster-recovery-walk.json \
//	  go -C /path/to/pearl test -overlay /tmp/overlay.json -run TestPearljsRecoveryWalk -count=1 ./wallet/wallet
//
// Each scenario is a chain of blocks paying the receive (branch 0) and change
// (branch 1) addresses of account 0 of a restored wallet. The chain client
// serves those blocks and filters them as the RPC client's FilterBlocks does
// once a compact filter has matched (wallet/chain/btcd.go), and the wallet
// restores from height 0 with the recovery window of 250 Oyster's loader
// uses. A payment is found when its output is among the wallet's unspent
// outputs afterwards.
package wallet

import (
	"encoding/json"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/pearl-research-labs/pearl/node/btcec/schnorr"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/btcutil/hdkeychain"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/wallet/chain"
	"github.com/pearl-research-labs/pearl/wallet/waddrmgr"
	"github.com/pearl-research-labs/pearl/wallet/walletdb"
	bip39 "github.com/tyler-smith/go-bip39"
)

type walkPayment struct {
	Change  bool   `json:"change"`
	Index   uint32 `json:"index"`
	Amount  int64  `json:"amount"`
	Address string `json:"address"`
	Found   bool   `json:"found"`
}

type walkBlock struct {
	Height   int32         `json:"height"`
	Payments []walkPayment `json:"payments"`
}

type walkScenario struct {
	Name   string      `json:"name"`
	Blocks []walkBlock `json:"blocks"`
}

type walkFixtures struct {
	Source         string         `json:"source"`
	Network        string         `json:"network"`
	Mnemonic       string         `json:"mnemonic"`
	RecoveryWindow uint32         `json:"recoveryWindow"`
	Scenarios      []walkScenario `json:"scenarios"`
}

// walkChain serves a fixed chain to the recovery.
type walkChain struct {
	*mockChainClient
	params *chaincfg.Params
	blocks []*wire.MsgBlock
}

func (c *walkChain) GetBestBlock() (*chainhash.Hash, int32, error) {
	hash := c.blocks[len(c.blocks)-1].BlockHash()
	return &hash, int32(len(c.blocks) - 1), nil
}

func (c *walkChain) GetBlockHash(height int64) (*chainhash.Hash, error) {
	hash := c.blocks[height].BlockHash()
	return &hash, nil
}

func (c *walkChain) GetBlockHeader(hash *chainhash.Hash) (*wire.BlockHeader, error) {
	for _, block := range c.blocks {
		if block.BlockHash() == *hash {
			return block.BlockHeader(), nil
		}
	}
	panic("unknown block")
}

// FilterBlocks is RPCClient.FilterBlocks for blocks whose filter matched:
// the first block with a relevant transaction answers.
func (c *walkChain) FilterBlocks(req *chain.FilterBlocksRequest) (*chain.FilterBlocksResponse, error) {
	filterer := chain.NewBlockFilterer(c.params, req)
	for i, meta := range req.Blocks {
		if !filterer.FilterBlock(c.blocks[meta.Height]) {
			continue
		}
		return &chain.FilterBlocksResponse{
			BatchIndex: uint32(i), BlockMeta: meta,
			FoundExternalAddrs: filterer.FoundExternal, FoundInternalAddrs: filterer.FoundInternal,
			FoundOutPoints: filterer.FoundOutPoints, RelevantTxns: filterer.RelevantTxns,
		}, nil
	}
	return nil, nil
}

type payment struct {
	change bool
	index  uint32
}

func TestPearljsRecoveryWalk(t *testing.T) {
	out := os.Getenv("PEARLJS_RECOVERY_WALK")
	if out == "" {
		t.Skip("PEARLJS_RECOVERY_WALK not set")
	}
	const mnemonic = "legal winner thank year wave sausage worth useful legal winner thank yellow"
	params := &chaincfg.RegressionNetParams
	r := func(index uint32) payment { return payment{false, index} }
	c := func(index uint32) payment { return payment{true, index} }
	scenarios := []struct {
		name   string
		blocks map[int32][]payment
	}{
		{"index-order", map[int32][]payment{1: {r(0)}, 2: {r(200)}, 3: {r(300)}}},
		{"window-reached-a-block-late", map[int32][]payment{1: {r(0)}, 2: {r(300)}, 3: {r(200)}}},
		{"window-reached-in-the-same-block", map[int32][]payment{1: {r(0)}, 2: {r(200), r(300)}}},
		{"first-block-past-the-window", map[int32][]payment{1: {r(100), r(250)}, 2: {r(249)}}},
		{"paid-again-later", map[int32][]payment{1: {r(0)}, 2: {r(300)}, 3: {r(200)}, 4: {r(300)}}},
		{"change-chain", map[int32][]payment{1: {c(0)}, 2: {c(260)}, 3: {c(240)}}},
		{"chains-apart", map[int32][]payment{1: {r(0), c(0)}, 2: {c(200)}, 3: {r(260)}, 4: {r(240), c(400)}}},
		{"window-edges", map[int32][]payment{1: {r(249)}, 2: {r(499)}, 3: {r(750)}, 4: {r(749)}}},
		{"across-recovery-batches", map[int32][]payment{1: {r(0)}, 1990: {r(300)}, 2050: {r(200)}, 2101: {r(301)}}},
	}

	seed := bip39.NewSeed(mnemonic, "")
	master, err := hdkeychain.NewMaster(seed, params)
	if err != nil {
		t.Fatal(err)
	}
	h := uint32(hdkeychain.HardenedKeyStart)
	addressOf := func(p payment) btcutil.Address {
		key := master
		branch := uint32(0)
		if p.change {
			branch = 1
		}
		for _, step := range []uint32{86 + h, params.HDCoinType + h, h, branch, p.index} {
			key, err = key.Derive(step)
			if err != nil {
				t.Fatal(err)
			}
		}
		pub, err := key.ECPubKey()
		if err != nil {
			t.Fatal(err)
		}
		addr, err := btcutil.NewAddressTaproot(schnorr.SerializePubKey(txscript.ComputeTaprootKeyNoScript(pub)), params)
		if err != nil {
			t.Fatal(err)
		}
		return addr
	}

	// Oyster's main sets the BIP86 scope's coin type for the network.
	waddrmgr.InitKeyScopes(params.HDCoinType)
	defer waddrmgr.InitKeyScopes(chaincfg.MainNetParams.HDCoinType)
	fixtures := walkFixtures{Source: "github.com/pearl-research-labs/pearl", Network: params.Name, Mnemonic: mnemonic, RecoveryWindow: 250}
	for _, scenario := range scenarios {
		t.Cleanup(useFastScrypt())
		loader := NewLoader(params, t.TempDir(), true, defaultDBTimeout, 250)
		privPass := []byte("walk")
		w, err := loader.CreateNewWallet([]byte(InsecurePubPassphrase), privPass, seed, time.Unix(1724644369, 0))
		if err != nil {
			t.Fatal(err)
		}
		if err := w.Unlock(privPass, nil); err != nil {
			t.Fatal(err)
		}

		var top int32
		for height := range scenario.blocks {
			if height > top {
				top = height
			}
		}
		blocks := make([]*wire.MsgBlock, top+1)
		outpoints := map[wire.OutPoint]*walkPayment{}
		var heights []int32
		listed := map[int32]*walkBlock{}
		var prev chainhash.Hash
		for height := int32(0); height <= top; height++ {
			block := wire.NewMsgBlock(&wire.BlockHeader{Version: 1, PrevBlock: prev, Timestamp: time.Unix(1724644369+int64(height)*600, 0), Bits: params.PowLimitBits})
			// A distinct input per transaction keeps every txid apart.
			for i, p := range scenario.blocks[height] {
				tx := wire.NewMsgTx(2)
				tx.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: chainhash.Hash{byte(height), byte(height >> 8), byte(i), 0xaa}, Index: 0}, nil, nil))
				amount := int64(100_000_000) * int64(i+1)
				script, err := txscript.PayToAddrScript(addressOf(p))
				if err != nil {
					t.Fatal(err)
				}
				tx.AddTxOut(wire.NewTxOut(amount, script))
				block.AddTransaction(tx)
				if listed[height] == nil {
					listed[height] = &walkBlock{Height: height}
					heights = append(heights, height)
				}
				listed[height].Payments = append(listed[height].Payments, walkPayment{Change: p.change, Index: p.index, Amount: amount, Address: addressOf(p).EncodeAddress()})
			}
			for i := range listed[height].paymentsOrNil() {
				outpoints[wire.OutPoint{Hash: block.Transactions[i].TxHash(), Index: 0}] = &listed[height].Payments[i]
			}
			blocks[height] = block
			prev = block.BlockHash()
		}

		genesis := blocks[0].BlockHash()
		start := &waddrmgr.BlockStamp{Hash: genesis, Height: 0, Timestamp: blocks[0].BlockHeader().Timestamp}
		if err := walletdb.Update(w.db, func(tx walletdb.ReadWriteTx) error {
			return w.Manager.SetSyncedTo(tx.ReadWriteBucket(waddrmgrNamespaceKey), start)
		}); err != nil {
			t.Fatal(err)
		}
		if err := w.recovery(&walkChain{mockChainClient: &mockChainClient{}, params: params, blocks: blocks}, start); err != nil {
			t.Fatal(err)
		}
		if err := walletdb.View(w.db, func(tx walletdb.ReadTx) error {
			credits, err := w.TxStore.UnspentOutputs(tx.ReadBucket(wtxmgrNamespaceKey))
			for _, credit := range credits {
				outpoints[credit.OutPoint].Found = true
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}

		sort.Slice(heights, func(i, j int) bool { return heights[i] < heights[j] })
		result := walkScenario{Name: scenario.name}
		for _, height := range heights {
			result.Blocks = append(result.Blocks, *listed[height])
		}
		fixtures.Scenarios = append(fixtures.Scenarios, result)
		if err := loader.UnloadWallet(); err != nil {
			t.Fatal(err)
		}
	}

	data, err := json.MarshalIndent(fixtures, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (b *walkBlock) paymentsOrNil() []walkPayment {
	if b == nil {
		return nil
	}
	return b.Payments
}

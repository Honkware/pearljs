// RPC response fixtures for pearljs's JSON-RPC client. The file joins pearld's
// package main through a build overlay, so it can call the real handlers and
// amount encoders, which are unexported. From a Pearl source checkout:
//
//	echo '{"Replace":{"/path/to/pearl/node/pearljs_rpcfixtures_test.go":"/path/to/pearljs/vectors/rpcfixtures_test.go"}}' > /tmp/overlay.json
//	PEARLJS_RPC_FIXTURES=/path/to/pearljs/test/fixtures/rpc-responses.json \
//	  go -C /path/to/pearl/node test -overlay /tmp/overlay.json -run TestPearljsRPCFixtures -count=1 .
//
// Each fixture is the exact body pearld or Oyster writes, plus the values the
// TypeScript side must decode from it, computed here from integer grains.
package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"testing"

	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcjson"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/mempool"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/wallet/rpc/jsonrpc"
	"github.com/stretchr/testify/mock"
)

type rpcFixture struct {
	Body   string         `json:"body"`
	Expect map[string]any `json:"expect,omitempty"`
}

func grains(v int64) string { return strconv.FormatInt(v, 10) }

func TestPearljsRPCFixtures(t *testing.T) {
	out := os.Getenv("PEARLJS_RPC_FIXTURES")
	if out == "" {
		t.Skip("PEARLJS_RPC_FIXTURES not set")
	}
	params := &chaincfg.RegressionNetParams
	fixtures := map[string]rpcFixture{}
	id := 0
	reply := func(name string, result any, err error, expect map[string]any) {
		t.Helper()
		id++
		body, merr := createMarshalledReply(btcjson.RpcVersion1, id, result, err)
		if merr != nil {
			t.Fatal(merr)
		}
		fixtures[name] = rpcFixture{Body: string(body) + "\n", Expect: expect}
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}

	priv, _ := btcec.PrivKeyFromBytes(bytesOf(0x11, 32))
	outputKey := txscript.ComputeTaprootKeyNoScript(priv.PubKey())
	addr, err := btcutil.NewAddressTaproot(outputKey.SerializeCompressed()[1:], params)
	must(err)
	p2tr, err := txscript.PayToAddrScript(addr)
	must(err)

	// A P2TR spend with an exact large output, a one-grain output and an
	// OP_RETURN, so value encoding is exercised at both ends.
	const big = int64(2099999999999999999)
	tx := wire.NewMsgTx(2)
	prev := wire.OutPoint{Hash: chainhash.Hash(bytesOf(0x22, 32)), Index: 1}
	tx.AddTxIn(wire.NewTxIn(&prev, nil, [][]byte{bytesOf(0x33, 64)}))
	tx.AddTxOut(wire.NewTxOut(big, p2tr))
	tx.AddTxOut(wire.NewTxOut(1, p2tr))
	tx.AddTxOut(wire.NewTxOut(0, []byte{txscript.OP_RETURN, 0x01, 0x2a}))
	txHash := tx.TxHash()
	txHex, err := messageToHex(tx)
	must(err)

	genesis := btcutil.NewBlock(params.GenesisBlock)
	genesisBytes, err := genesis.Bytes()
	must(err)
	genesisHash := params.GenesisHash.String()

	// pearld results.
	reply("getblockcount", int64(321), nil, nil)
	reply("getbestblockhash", genesisHash, nil, nil)
	reply("getblockhash", genesisHash, nil, nil)
	reply("getblock-raw", hexOf(genesisBytes), nil, map[string]any{"hash": genesisHash})
	reply("getblockchaininfo", &btcjson.GetBlockChainInfoResult{
		Chain:         params.Name,
		Blocks:        321,
		Headers:       321,
		BestBlockHash: genesisHash,
		Difficulty:    getDifficultyRatio(params.PowLimitBits, params),
		MedianTime:    1767225600,
		Pruned:        false,
		SoftForks: &btcjson.SoftForks{
			SoftForks: []*btcjson.SoftForkDescription{},
			Bip9SoftForks: map[string]*btcjson.Bip9SoftForkDescription{
				"dummy": {Status: "defined", Bit: 28, StartTime2: 0, Timeout: 1767225600},
			},
		},
	}, nil, nil)
	reply("getrawtransaction-hex", txHex, nil, map[string]any{"txid": txHash.String()})

	header := params.GenesisBlock.BlockHeader()
	verbose, err := createTxRawResult(params, tx, txHash.String(), header, genesisHash, 0, 5)
	must(err)
	reply("getrawtransaction-verbose", verbose, nil, map[string]any{
		"values": []string{grains(big), grains(1), grains(0)}, "address": addr.EncodeAddress(),
	})

	coinbase := params.GenesisBlock.Transactions[0]
	cbResult, err := createTxRawResult(params, coinbase, coinbase.TxHash().String(), nil, "", 0, 0)
	must(err)
	reply("getrawtransaction-coinbase", cbResult, nil, map[string]any{
		"value": grains(coinbase.TxOut[0].Value),
	})

	disasm, _ := txscript.DisasmString(p2tr)
	class, addrs, reqSigs, _ := txscript.ExtractPkScriptAddrs(p2tr, params)
	reply("gettxout", &rpcGetTxOutResult{
		Value: rpcAmount(150000000),
		GetTxOutResult: btcjson.GetTxOutResult{
			BestBlock:     genesisHash,
			Confirmations: 6,
			ScriptPubKey: btcjson.ScriptPubKeyResult{
				Asm: disasm, Hex: hexOf(p2tr), ReqSigs: int32(reqSigs), Type: class.String(),
				Address: addrs[0].EncodeAddress(), Addresses: []string{addrs[0].EncodeAddress()},
			},
			Coinbase: false,
		},
	}, nil, map[string]any{"value": grains(150000000)})
	reply("gettxout-spent", nil, nil, nil)

	mm := &mempool.MockTxMempool{}
	s := &rpcServer{cfg: rpcserverConfig{TxMemPool: mm, ChainParams: params}}

	// searchrawtransactions as handleSearchRawTransactions builds it: one
	// confirmed transaction, then from the mempool one that pays the address
	// twice and somewhere else once, and one that spends from the address
	// without paying it.
	other := append([]byte{txscript.OP_1, txscript.OP_DATA_32}, bytesOf(0x44, 32)...)
	pending := wire.NewMsgTx(2)
	pending.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: txHash, Index: 1}, nil, [][]byte{bytesOf(0x55, 64)}))
	pending.AddTxOut(wire.NewTxOut(30000000, p2tr))
	pending.AddTxOut(wire.NewTxOut(70000000, other))
	pending.AddTxOut(wire.NewTxOut(20000000, p2tr))
	spend := wire.NewMsgTx(2)
	spend.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: pending.TxHash(), Index: 0}, nil, [][]byte{bytesOf(0x66, 64)}))
	spend.AddTxOut(wire.NewTxOut(29000000, other))
	search := make([]rpcSearchRawTransactionsResult, 3)
	for i, mtx := range []*wire.MsgTx{tx, pending, spend} {
		r := &search[i]
		r.Hex, err = messageToHex(mtx)
		must(err)
		r.Txid = mtx.TxHash().String()
		r.Vin, err = createVinListPrevOut(s, mtx, params, false, nil)
		must(err)
		r.Vout = createVoutList(mtx, params, nil)
		r.Version = mtx.Version
		r.LockTime = mtx.LockTime
	}
	search[0].Time = header.Timestamp.Unix()
	search[0].Blocktime = header.Timestamp.Unix()
	search[0].BlockHash = genesisHash
	search[0].Confirmations = 6
	reply("searchrawtransactions", search, nil, map[string]any{
		"confirmed": txHash.String(), "pending": pending.TxHash().String(),
		"confirmedAmount": grains(big + 1), "pendingAmount": grains(50000000),
	})
	reply("searchrawtransactions-none", nil, &btcjson.RPCError{
		Code: btcjson.ErrRPCNoTxInfo, Message: "No information available about address",
	}, nil)
	var res any
	_, herr := handleSearchRawTransactions(s, btcjson.NewSearchRawTransactionsCmd(addr.EncodeAddress(), nil, nil, nil, nil, nil, nil), nil)
	reply("searchrawtransactions-noindex", nil, herr, nil)
	reply("getblockheader", btcjson.GetBlockHeaderVerboseResult{
		Hash:            genesisHash,
		Confirmations:   6,
		Height:          316,
		Version:         header.Version,
		VersionHex:      fmt.Sprintf("%08x", header.Version),
		MerkleRoot:      header.MerkleRoot.String(),
		PreviousHash:    header.PrevBlock.String(),
		Time:            header.Timestamp.Unix(),
		Bits:            strconv.FormatInt(int64(header.Bits), 16),
		Difficulty:      getDifficultyRatio(header.Bits, params),
		ProofCommitment: header.ProofCommitment.String(),
	}, nil, nil)
	mm.On("Count").Return(2)
	mm.On("PoolBytes").Return(uint64(431))
	mm.On("MaxMempoolSize").Return(uint64(300000000))
	res, herr = handleGetMempoolInfo(s, &btcjson.GetMempoolInfoCmd{}, nil)
	reply("getmempoolinfo", res, herr, nil)

	desc := &mempool.TxDesc{}
	desc.Tx = btcutil.NewTx(tx)
	mm.On("TxDescs").Return([]*mempool.TxDesc{desc})
	res, herr = handleGetRawMempool(s, &btcjson.GetRawMempoolCmd{Verbose: btcjson.Bool(false)}, nil)
	reply("getrawmempool", res, herr, map[string]any{"txid": txHash.String()})

	const mempoolFee = int64(1)
	mm.On("RawMempoolVerbose").Return(map[string]*btcjson.GetRawMempoolVerboseResult{
		txHash.String(): {
			Size: int32(tx.SerializeSize()), Vsize: 121, Fee: btcutil.Amount(mempoolFee).ToPRL(),
			Time: 1767225600, Height: 320, Depends: []string{},
		},
	})
	res, herr = handleGetRawMempool(s, &btcjson.GetRawMempoolCmd{Verbose: btcjson.Bool(true)}, nil)
	reply("getrawmempool-verbose", res, herr, map[string]any{"txid": txHash.String(), "fee": grains(mempoolFee)})

	mm.On("CheckMempoolAcceptance", mock.Anything).Return(&mempool.MempoolAcceptResult{TxFee: 1210, TxSize: 121}, nil).Once()
	res, herr = handleTestMempoolAccept(s, btcjson.NewTestMempoolAcceptCmd([]string{txHex}, 0), nil)
	reply("testmempoolaccept-allowed", res, herr, map[string]any{
		"txid": txHash.String(), "wtxid": tx.WitnessHash().String(), "fee": grains(1210), "feeRate": grains(10000),
	})
	mm.On("CheckMempoolAcceptance", mock.Anything).Return(nil, mempool.RuleError{Err: mempool.TxRuleError{
		RejectCode: wire.RejectInsufficientFee, Description: "transaction has insufficient priority",
	}}).Once()
	res, herr = handleTestMempoolAccept(s, btcjson.NewTestMempoolAcceptCmd([]string{txHex}, 0), nil)
	reply("testmempoolaccept-rejected", res, herr, nil)

	mm.On("ProcessTransaction", mock.Anything, false, false, mempool.Tag(0)).Return(
		nil, mempool.RuleError{Err: mempool.TxRuleError{
			RejectCode: wire.RejectNonstandard, Description: "transaction version 3 is not standard",
		}}).Once()
	_, herr = handleSendRawTransaction(s, btcjson.NewSendRawTransactionCmd(txHex, nil), nil)
	reply("sendrawtransaction-rejected", nil, herr, nil)
	reply("sendrawtransaction", txHash.String(), nil, nil)

	s.cfg.FeeEstimator = mempool.NewFeeEstimator(mempool.DefaultEstimateFeeMaxRollback, mempool.DefaultEstimateFeeMinRegisteredBlocks)
	_, herr = handleEstimateFee(s, &btcjson.EstimateFeeCmd{NumBlocks: 6}, nil)
	reply("estimatefee-unavailable", nil, herr, nil)
	reply("estimatefee", float64(mempool.GrainPerByte(12.5).ToPrlPerKb()), nil, map[string]any{"rate": grains(12500)})

	reply("method-not-found", nil, btcjson.ErrRPCMethodNotFound, nil)
	reply("getrawtransaction-missing", nil, rpcNoTxInfoError(&txHash), nil)
	reply("limited-user", nil, internalRPCError("limited user not authorized for this method", ""), nil)

	// Oyster results. Oyster replies through btcjson.MarshalResponse with
	// JSON-RPC 1.0 on every request, the same envelope as above.
	const balance = int64(1234567800)
	reply("getbalance", btcutil.Amount(balance).ToPRL(), nil, map[string]any{"balance": grains(balance)})
	reply("getbalance-one-grain", btcutil.Amount(1).ToPRL(), nil, map[string]any{"balance": grains(1)})
	reply("getnewaddress", addr.EncodeAddress(), nil, nil)
	reply("listunspent", []*btcjson.ListUnspentResult{{
		TxID: txHash.String(), Vout: 0, Address: addr.EncodeAddress(), Account: "default",
		ScriptPubKey: hexOf(p2tr), Amount: btcutil.Amount(150000000).ToPRL(), Confirmations: 6, Spendable: true,
	}}, nil, map[string]any{"amount": grains(150000000)})
	sig, err := jsonrpc.BIP322SignMessageSimple(priv, addr, "pearljs")
	must(err)
	reply("signmessage", sig, nil, map[string]any{"address": addr.EncodeAddress(), "message": "pearljs"})
	reply("verifymessage", true, nil, nil)
	wif, err := btcutil.NewWIF(priv, params, true)
	must(err)
	reply("dumpprivkey", wif.String(), nil, nil)
	reply("importprivkey", nil, nil, nil)
	reply("walletpassphrase", nil, nil, nil)
	reply("walletlock", nil, nil, nil)
	reply("sendtoaddress", txHash.String(), nil, nil)
	reply("wallet-locked", nil, &jsonrpc.ErrWalletUnlockNeeded, nil)
	reply("wallet-unsupported", nil, &btcjson.RPCError{Code: -1, Message: "Request unsupported by Oyster"}, nil)
	// jsonError in Oyster's methods.go gives plain wallet errors code -4.
	reply("wallet-error", nil, &btcjson.RPCError{Code: btcjson.ErrRPCWallet, Message: "insufficient funds"}, nil)

	data, err := json.MarshalIndent(fixtures, "", "  ")
	must(err)
	must(os.WriteFile(out, append(data, '\n'), 0o644))
}

func bytesOf(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func hexOf(b []byte) string { return hex.EncodeToString(b) }

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
// Three kinds: results of pearld's handlers called directly, bodies served
// by pearld's HTTP handler over a chain holding the regtest genesis block
// (servedFixtures), and btcjson results filled in as the handlers fill them
// where a handler needs peers, mined blocks or a wallet database. Everything
// is reproducible except getblocktemplate, which carries the clock, and
// getmininginfo, which reports this machine's CPU count.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/pearl-research-labs/pearl/node/blockchain"
	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcjson"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/btcutil/gcs/builder"
	"github.com/pearl-research-labs/pearl/node/btcutil/hdkeychain"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/database"
	_ "github.com/pearl-research-labs/pearl/node/database/ffldb"
	"github.com/pearl-research-labs/pearl/node/mempool"
	"github.com/pearl-research-labs/pearl/node/mining"
	"github.com/pearl-research-labs/pearl/node/mining/cpuminer"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/wallet/rpc/jsonrpc"
	"github.com/pearl-research-labs/pearl/wallet/wallet/txrules"
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

	served := servedFixtures(t, params, mm)
	for name, f := range served {
		fixtures[name] = f
	}
	structFixtures(t, params, reply, priv)
	backendFixtures(t, params, s, reply)
	laterFixtures(t, params, reply, priv)
	fixtures["handler-tables"] = rpcFixture{Body: "", Expect: handlerTables(t)}

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

// The stubs stand in for the peer-to-peer side of pearld, which the handlers
// reach through these two interfaces.
type fixtureConnMgr struct{ rpcserverConnManager }

func (fixtureConnMgr) ConnectedCount() int32            { return 3 }
func (fixtureConnMgr) ConnectedPeers() []rpcserverPeer  { return nil }
func (fixtureConnMgr) Connect(string, bool) error       { return nil }
func (fixtureConnMgr) RemoveByAddr(string) error        { return nil }
func (fixtureConnMgr) DisconnectByID(int32) error       { return nil }
func (fixtureConnMgr) DisconnectByAddr(string) error    { return nil }
func (fixtureConnMgr) RemoveByID(int32) error           { return nil }
func (fixtureConnMgr) PersistentPeers() []rpcserverPeer { return nil }

type fixtureSyncMgr struct {
	rpcserverSyncManager
	headers []wire.MsgHeader
	reject  error
}

func (m *fixtureSyncMgr) IsCurrent() bool   { return true }
func (m *fixtureSyncMgr) SyncPeerID() int32 { return 0 }
func (m *fixtureSyncMgr) SubmitBlock(*btcutil.Block, blockchain.BehaviorFlags) (bool, error) {
	return m.reject == nil, m.reject
}
func (m *fixtureSyncMgr) LocateHeaders([]*chainhash.Hash, *chainhash.Hash, bool) []wire.MsgHeader {
	return m.headers
}

type noTransactions struct{}

func (noTransactions) LastUpdated() time.Time               { return time.Unix(1767225600, 0) }
func (noTransactions) MiningDescs() []*mining.TxDesc        { return nil }
func (noTransactions) HaveTransaction(*chainhash.Hash) bool { return false }

// servedFixtures posts real requests to pearld's own HTTP handler
// (jsonRPCRead) over a chain that holds the regtest genesis block, so the
// bodies, batches included, are byte for byte what pearld sends.
func servedFixtures(t *testing.T, params *chaincfg.Params, mm *mempool.MockTxMempool) map[string]rpcFixture {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	savedCfg := cfg
	cfg = &config{RegressionTest: true, minRelayTxFee: mempool.DefaultMinRelayTxFee}
	defer func() { cfg = savedCfg }()

	db, err := database.Create("ffldb", t.TempDir(), params.Net)
	must(err)
	defer db.Close()
	timeSource := blockchain.NewMedianTime()
	sigCache := txscript.NewSigCache(100)
	hashCache := txscript.NewHashCache(100)
	chain, err := blockchain.New(&blockchain.Config{
		DB: db, ChainParams: params, TimeSource: timeSource, SigCache: sigCache, HashCache: hashCache,
	})
	must(err)
	generator := mining.NewBlkTmplGenerator(
		&mining.Policy{BlockMaxVsize: blockchain.MaxBlockVsize}, params, noTransactions{}, chain,
		timeSource, sigCache, hashCache,
	)
	genesisHash := params.GenesisHash.String()
	sync := &fixtureSyncMgr{headers: []wire.MsgHeader{params.GenesisBlock.MsgHeader}}
	s := &rpcServer{
		cfg: rpcserverConfig{
			ChainParams: params, Chain: chain, DB: db, TimeSource: timeSource, TxMemPool: mm,
			ConnMgr: fixtureConnMgr{}, SyncMgr: sync, Generator: generator,
			CPUMiner: cpuminer.New(&cpuminer.Config{}),
		},
		statusLines:            make(map[int]string),
		gbtWorkState:           newGbtWorkState(timeSource, params.MaxTimeOffsetMinutes),
		helpCacher:             newHelpCacher(),
		requestProcessShutdown: make(chan struct{}, 1),
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.jsonRPCRead(w, r, true)
	}))
	defer server.Close()

	// The same handler as pearld serves its limited user (--rpclimituser):
	// methods outside rpcLimited are refused, the rest answered as for the
	// admin.
	limited := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.jsonRPCRead(w, r, false)
	}))
	defer limited.Close()

	fixtures := map[string]rpcFixture{}
	postTo := func(url, body string) string {
		t.Helper()
		resp, err := http.Post(url, "application/json", bytes.NewBufferString(body))
		must(err)
		defer resp.Body.Close()
		out, err := io.ReadAll(resp.Body)
		must(err)
		return string(out)
	}
	post := func(body string) string { return postTo(server.URL, body) }
	id := 100
	request := func(method string, params ...any) string {
		t.Helper()
		id++
		if params == nil {
			params = []any{}
		}
		raw, err := json.Marshal(map[string]any{"jsonrpc": "1.0", "id": id, "method": method, "params": params})
		must(err)
		return string(raw)
	}
	serve := func(name string, expect map[string]any, method string, params ...any) {
		t.Helper()
		fixtures[name] = rpcFixture{Body: post(request(method, params...)), Expect: expect}
	}

	genesis := btcutil.NewBlock(params.GenesisBlock)
	coinbase := params.GenesisBlock.Transactions[0]
	serve("getbestblock", nil, "getbestblock")
	serve("getblock-verbose", map[string]any{"txid": coinbase.TxHash().String()}, "getblock", genesisHash, 1)
	serve("getblock-transactions", map[string]any{"value": grains(coinbase.TxOut[0].Value)}, "getblock", genesisHash, 2)
	serve("getblock-missing", nil, "getblock", hexOf(bytesOf(0x77, 32)), 1)
	serve("getchaintips", nil, "getchaintips")
	serve("getdifficulty", nil, "getdifficulty")
	serve("getnetworkhashps", nil, "getnetworkhashps", 120, -1)
	serve("getmininginfo", nil, "getmininginfo")
	serve("getinfo", map[string]any{"relayFee": grains(int64(mempool.DefaultMinRelayTxFee))}, "getinfo")
	serve("getnetworkinfo", map[string]any{"relayFee": grains(int64(mempool.DefaultMinRelayTxFee))}, "getnetworkinfo")
	serve("getconnectioncount", nil, "getconnectioncount")
	serve("getpeerinfo-none", nil, "getpeerinfo")
	var headerBuf bytes.Buffer
	must(params.GenesisBlock.MsgHeader.Serialize(&headerBuf))
	serve("getheaders", map[string]any{"header": hexOf(headerBuf.Bytes()), "hash": genesisHash}, "getheaders", []string{genesisHash}, "")
	serve("getcfilter-noindex", nil, "getcfilter", genesisHash, 0)
	serve("getblocktemplate", map[string]any{
		"coinbaseValue": grains(blockchain.CalcBlockSubsidy(1, params)),
	}, "getblocktemplate", map[string]any{"capabilities": []string{"coinbasevalue"}})

	priv, _ := btcec.PrivKeyFromBytes(bytesOf(0x11, 32))
	addr, err := btcutil.NewAddressTaproot(txscript.ComputeTaprootKeyNoScript(priv.PubKey()).SerializeCompressed()[1:], params)
	must(err)
	p2tr, err := txscript.PayToAddrScript(addr)
	must(err)
	serve("validateaddress", map[string]any{"address": addr.EncodeAddress(), "program": hexOf(addr.WitnessProgram())},
		"validateaddress", addr.EncodeAddress())
	serve("validateaddress-invalid", nil, "validateaddress", "prl1notanaddress")
	serve("decodescript", map[string]any{"address": addr.EncodeAddress()}, "decodescript", hexOf(p2tr))

	const big = int64(2099999999999999999)
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: chainhash.Hash(bytesOf(0x22, 32)), Index: 1}, nil, [][]byte{bytesOf(0x33, 64)}))
	tx.AddTxOut(wire.NewTxOut(big, p2tr))
	tx.AddTxOut(wire.NewTxOut(1, p2tr))
	txHex, err := messageToHex(tx)
	must(err)
	serve("decoderawtransaction", map[string]any{"txid": tx.TxHash().String(), "values": []string{grains(big), grains(1)}},
		"decoderawtransaction", txHex)

	// gettxspendingprevout looks in the mempool only: one output a mempool
	// transaction spends and one nothing spends.
	spent := wire.OutPoint{Hash: chainhash.Hash(bytesOf(0x22, 32)), Index: 1}
	unspent := wire.OutPoint{Hash: tx.TxHash(), Index: 0}
	mm.On("CheckSpend", spent).Return(btcutil.NewTx(tx))
	mm.On("CheckSpend", unspent).Return(nil)
	serve("gettxspendingprevout", map[string]any{"spender": tx.TxHash().String()}, "gettxspendingprevout", []map[string]any{
		{"txid": spent.Hash.String(), "vout": spent.Index}, {"txid": unspent.Hash.String(), "vout": unspent.Index},
	})

	// Without --txindex pearld answers code -5 for any transaction outside
	// the mempool, the code it also uses for one it does not know.
	mm.On("FetchTransaction", mock.Anything).Return(nil, errors.New("not in the mempool"))
	serve("getrawtransaction-noindex", nil, "getrawtransaction", tx.TxHash().String(), 1)

	genesisBytes, err := genesis.Bytes()
	must(err)
	serve("submitblock-accepted", nil, "submitblock", hexOf(genesisBytes))
	sync.reject = errors.New("already have block " + genesisHash)
	serve("submitblock-rejected", nil, "submitblock", hexOf(genesisBytes))
	serve("submitblock-undecodable", nil, "submitblock", "00")
	serve("generate-no-address", nil, "generate", 1)
	serve("addnode", nil, "addnode", "127.0.0.1:18444", "add")
	serve("node", nil, "node", "connect", "127.0.0.1:18444", "temp")
	serve("stop", nil, "stop")

	// One batch as pearld answers it: results, an RPC error and an unknown
	// method side by side, each under the id of its request.
	id = 0
	batch := "[" + request("getblockcount") + "," + request("getbestblockhash") + "," +
		request("getblock", hexOf(bytesOf(0x77, 32)), 1) + "," + request("getinfo") + "," + request("frobnicate") + "]"
	fixtures["batch"] = rpcFixture{Body: post(batch), Expect: map[string]any{"hash": genesisHash, "relayFee": grains(int64(mempool.DefaultMinRelayTxFee))}}
	fixtures["batch-empty"] = rpcFixture{Body: post("[]")}
	fixtures["batch-unreadable"] = rpcFixture{Body: post("[{]")}

	// What a capability probe sends: harmless calls whose answers tell the
	// admin from the limited user and show which indexes are on.
	serve("sendrawtransaction-undecodable", nil, "sendrawtransaction", "00")
	serve("gettxspendingprevout-empty", nil, "gettxspendingprevout", []any{})
	serveLimited := func(name, method string, params ...any) {
		t.Helper()
		fixtures[name] = rpcFixture{Body: postTo(limited.URL, request(method, params...))}
	}
	serveLimited("limited-getblockchaininfo", "getblockchaininfo")
	serveLimited("limited-sendrawtransaction", "sendrawtransaction", "00")
	serveLimited("limited-gettxspendingprevout", "gettxspendingprevout", []any{})
	serveLimited("limited-getbestblock", "getbestblock")

	// Node administration and the remaining chain methods, from the handlers
	// that need no peers.
	serve("version", nil, "version")
	serve("getcurrentnet", map[string]any{"net": uint32(params.Net)}, "getcurrentnet")
	serve("getgenerate", nil, "getgenerate")
	serve("setgenerate-off", nil, "setgenerate", false)
	serve("setgenerate-no-address", nil, "setgenerate", true, 1)
	serve("verifychain", nil, "verifychain", 3, 1)
	serve("getaddednodeinfo-none", nil, "getaddednodeinfo", false)
	serve("debuglevel-show", nil, "debuglevel", "show")
	serve("debuglevel-invalid", nil, "debuglevel", "nosuchsubsystem=trace")
	serve("invalidateblock-unknown", nil, "invalidateblock", hexOf(bytesOf(0x77, 32)))
	serve("reconsiderblock-unknown", nil, "reconsiderblock", hexOf(bytesOf(0x77, 32)))
	wif, err := btcutil.NewWIF(priv, params, true)
	must(err)
	serve("signmessagewithprivkey", map[string]any{"wif": wif.String(), "message": "pearljs"}, "signmessagewithprivkey", wif.String(), "pearljs")
	serve("signmessagewithprivkey-bad-key", nil, "signmessagewithprivkey", "notawif", "pearljs")
	prevTxid := hexOf(bytesOf(0x22, 32))
	serve("createrawtransaction", map[string]any{
		"txid": prevTxid, "address": addr.EncodeAddress(), "amount": grains(150000001), "locktime": 500,
	}, "createrawtransaction", []map[string]any{{"txid": prevTxid, "vout": 1}}, map[string]any{addr.EncodeAddress(): 1.50000001}, 500)
	serve("createrawtransaction-wrong-network", nil, "createrawtransaction", []map[string]any{{"txid": prevTxid, "vout": 1}},
		map[string]any{"prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74": 1})
	return fixtures
}

// structFixtures holds results that need a peer, a mined chain or a wallet
// database, built from the btcjson types the handlers fill in and the same
// amount conversions.
func structFixtures(t *testing.T, params *chaincfg.Params, reply func(string, any, error, map[string]any), priv *btcec.PrivateKey) {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	addr, err := btcutil.NewAddressTaproot(txscript.ComputeTaprootKeyNoScript(priv.PubKey()).SerializeCompressed()[1:], params)
	must(err)
	p2tr, err := txscript.PayToAddrScript(addr)
	must(err)
	genesis := params.GenesisBlock
	genesisHash := params.GenesisHash.String()
	txid := hexOf(bytesOf(0xab, 32))

	reply("getpeerinfo", []*btcjson.GetPeerInfoResult{{
		ID: 7, Addr: "127.0.0.1:18444", AddrLocal: "127.0.0.1:50211", Services: fmt.Sprintf("%08d", uint64(wire.SFNodeNetwork)),
		RelayTxes: true, LastSend: 1767225600, LastRecv: 1767225601, BytesSent: 1234, BytesRecv: 5678,
		ConnTime: 1767225000, PingTime: float64(1500), Version: 70016, SubVer: "/pearld:0.1.0/", Inbound: false,
		StartingHeight: 300, CurrentHeight: 321, BanScore: 0, FeeFilter: 1000, SyncNode: true, V2Connection: true,
	}}, nil, map[string]any{"feeFilter": grains(1000)})
	reply("generate", []string{genesisHash}, nil, nil)
	reply("estimatefee-negative", float64(-1), nil, nil)

	// The filter of a block holding the genesis coinbase and one P2TR spend.
	spend := wire.NewMsgTx(2)
	spend.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: chainhash.Hash(bytesOf(0x22, 32)), Index: 1}, nil, [][]byte{bytesOf(0x33, 64)}))
	spend.AddTxOut(wire.NewTxOut(1, p2tr))
	filtered := *genesis
	filtered.Transactions = []*wire.MsgTx{genesis.Transactions[0], spend}
	spentScript := append([]byte{txscript.OP_1, txscript.OP_DATA_32}, bytesOf(0x44, 32)...)
	filter, err := builder.BuildBasicFilter(&filtered, [][]byte{spentScript})
	must(err)
	filterBytes, err := filter.NBytes()
	must(err)
	header, err := builder.MakeHeaderForFilter(filter, chainhash.Hash{})
	must(err)
	reply("getcfilter", hexOf(filterBytes), nil, map[string]any{
		"n": filter.N(), "paid": hexOf(p2tr), "spent": hexOf(spentScript), "prevHeader": chainhash.Hash{}.String(),
	})
	reply("getcfilterheader", header.String(), nil, nil)

	// Oyster. A send of 1.5 PRL at a fee of 1210 grains, a payment received,
	// and an immature coinbase output, as transactionEntries lists them.
	const sent, fee, received, subsidy = int64(150000000), int64(1210), int64(70000000), int64(5000000000)
	negFee := btcutil.Amount(-fee).ToPRL()
	entries := []btcjson.ListTransactionsResult{
		{
			Address: addr.EncodeAddress(), Amount: -btcutil.Amount(sent).ToPRL(), Category: "send", Fee: &negFee,
			BlockHash: genesisHash, BlockTime: 1767225600, Confirmations: 6, Time: 1767225500, TimeReceived: 1767225500,
			TxID: txid, Vout: 0, WalletConflicts: []string{},
		},
		{
			Account: "default", Address: addr.EncodeAddress(), Amount: btcutil.Amount(received).ToPRL(), Category: "receive",
			Time: 1767225700, TimeReceived: 1767225700, TxID: hexOf(bytesOf(0xac, 32)), Vout: 1, WalletConflicts: []string{},
		},
		{
			Account: "default", Address: addr.EncodeAddress(), Amount: btcutil.Amount(subsidy).ToPRL(), Category: "immature",
			Generated: true, BlockHash: genesisHash, BlockTime: 1767225600, Confirmations: 10, Time: 1767225600,
			TimeReceived: 1767225600, TxID: hexOf(bytesOf(0xad, 32)), Vout: 0, WalletConflicts: []string{},
		},
	}
	expectEntries := map[string]any{"sent": grains(-sent), "fee": grains(-fee), "received": grains(received), "immature": grains(subsidy)}
	reply("listtransactions", entries, nil, expectEntries)
	reply("listalltransactions", entries, nil, expectEntries)
	reply("listaddresstransactions", entries[1:], nil, expectEntries)
	reply("listsinceblock", btcjson.ListSinceBlockResult{Transactions: entries, LastBlock: genesisHash}, nil, expectEntries)

	feeF := btcutil.Amount(fee).ToPRL()
	reply("gettransaction", btcjson.GetTransactionResult{
		Amount: btcutil.Amount(received).ToPRL(), Fee: feeF, Confirmations: 6, BlockHash: genesisHash, BlockTime: 1767225600,
		TxID: txid, WalletConflicts: []string{}, Time: 1767225500, TimeReceived: 1767225500, Hex: "00",
		Details: []btcjson.GetTransactionDetailsResult{
			{Category: "send", Amount: (-btcutil.Amount(sent + received + fee)).ToPRL(), Fee: &feeF},
			{Account: "default", Address: addr.EncodeAddress(), Category: "receive", Amount: btcutil.Amount(received).ToPRL(), Vout: 1},
		},
	}, nil, map[string]any{"amount": grains(received), "fee": grains(fee), "debit": grains(-(sent + received + fee))})
	reply("gettransaction-missing", nil, &jsonrpc.ErrNoTransactionInfo, nil)

	reply("sendmany", txid, nil, nil)
	reply("getreceivedbyaddress", btcutil.Amount(received).ToPRL(), nil, map[string]any{"amount": grains(received)})
	reply("listreceivedbyaddress", []btcjson.ListReceivedByAddressResult{
		{Address: addr.EncodeAddress(), Amount: btcutil.Amount(received).ToPRL(), Confirmations: 6, TxIDs: []string{txid}},
	}, nil, map[string]any{"amount": grains(received)})
	reply("getrawchangeaddress", addr.EncodeAddress(), nil, nil)
	reply("lockunspent", true, nil, nil)
	reply("listlockunspent", []btcjson.TransactionInput{{Txid: txid, Vout: 1}}, nil, nil)
	reply("null", nil, nil, nil)
	// An account named like a reply field, which a conversion by key would miss.
	reply("listaccounts", map[string]float64{
		"default": btcutil.Amount(1234567800).ToPRL(), "imported": 0, "id": btcutil.Amount(1).ToPRL(),
	}, nil, map[string]any{"default": grains(1234567800), "imported": grains(0), "id": grains(1)})
	reply("getaccount", "default", nil, nil)
	reply("getaddressesbyaccount", []string{addr.EncodeAddress()}, nil, nil)
	reply("signrawtransaction", btcjson.SignRawTransactionResult{Hex: "00", Complete: false, Errors: []btcjson.SignRawTransactionError{
		{TxID: txid, Vout: 1, ScriptSig: "", Sequence: wire.MaxTxInSequenceNum, Error: "no key for input"},
	}}, nil, nil)
	reply("validateaddress-wallet", btcjson.ValidateAddressWalletResult{
		IsValid: true, Address: addr.EncodeAddress(), IsMine: true, Account: "default", IsCompressed: true,
		PubKey: hexOf(priv.PubKey().SerializeCompressed()),
	}, nil, nil)
	reply("validateaddress-wallet-invalid", btcjson.ValidateAddressWalletResult{}, nil, nil)
	reply("getinfo-wallet", &btcjson.InfoWalletResult{
		Version: 10000, ProtocolVersion: 70016, WalletVersion: 5, Balance: btcutil.Amount(1234567800).ToPRL(), Blocks: 321,
		Connections: 3, Difficulty: 1, RelayFee: mempool.DefaultMinRelayTxFee.ToPRL(),
		PaytxFee: float64(txrules.DefaultRelayFeePerKb),
	}, nil, map[string]any{"balance": grains(1234567800), "relayFee": grains(int64(mempool.DefaultMinRelayTxFee)), "payTxFee": float64(txrules.DefaultRelayFeePerKb)})
	reply("getsyncprogress", &btcjson.GetSyncProgressResult{
		HeaderHeight: 321, FilterHeaderHeight: 320, BlockHeight: 319, BestPeerHeight: 321, Connections: 3,
	}, nil, nil)
	reply("chainsynced", true, nil, nil)
	reply("removetransaction", &btcjson.RemoveTransactionResult{Removed: []string{txid}}, nil, nil)
	reply("rebroadcasttransaction", &btcjson.RebroadcastTransactionResult{Announced: []string{txid}}, nil, nil)
	reply("getbestblock-wallet", &btcjson.GetBestBlockResult{Hash: genesisHash, Height: 319}, nil, nil)
	// What Oyster answers in SPV mode for methods that need pearld's RPC.
	reply("chain-rpc-inactive", nil, &btcjson.RPCError{Code: -1, Message: "Chain RPC is inactive"}, nil)
}

// backendFixtures is one small wallet history as pearld's address index and
// Oyster each report it, for the wallet backends and address discovery. The
// account is BIP86 account 0 of a fixed seed, so pearljs derives the same
// addresses.
//
//	a1 (6 confirmations)  pays receive/0 1.5 PRL
//	a3 (3 confirmations)  pays receive/0 0.7 PRL
//	a2 (10 confirmations) is a coinbase paying receive/2 50 PRL
//	m1 (mempool)          spends a1:0, pays change/0 1 PRL and someone else
func backendFixtures(t *testing.T, params *chaincfg.Params, s *rpcServer, reply func(string, any, error, map[string]any)) {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	seed := bytesOf(0x5e, 32)
	master, err := hdkeychain.NewMaster(seed, params)
	must(err)
	node := master
	for _, child := range []uint32{hdkeychain.HardenedKeyStart + 86, hdkeychain.HardenedKeyStart + params.HDCoinType, hdkeychain.HardenedKeyStart} {
		node, err = node.Derive(child)
		must(err)
	}
	type child struct {
		addr   btcutil.Address
		script []byte
	}
	derive := func(branch, index uint32) child {
		b, err := node.Derive(branch)
		must(err)
		k, err := b.Derive(index)
		must(err)
		pub, err := k.ECPubKey()
		must(err)
		addr, err := btcutil.NewAddressTaproot(txscript.ComputeTaprootKeyNoScript(pub).SerializeCompressed()[1:], params)
		must(err)
		script, err := txscript.PayToAddrScript(addr)
		must(err)
		return child{addr, script}
	}
	r0, r1, r2, c0 := derive(0, 0), derive(0, 1), derive(0, 2), derive(1, 0)
	other := append([]byte{txscript.OP_1, txscript.OP_DATA_32}, bytesOf(0x44, 32)...)

	const tip = int32(321)
	a1 := wire.NewMsgTx(1)
	a1.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: chainhash.Hash(bytesOf(0x21, 32)), Index: 0}, nil, [][]byte{bytesOf(0x31, 64)}))
	a1.AddTxOut(wire.NewTxOut(150000000, r0.script))
	a1.AddTxOut(wire.NewTxOut(1, other))
	a3 := wire.NewMsgTx(1)
	a3.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: chainhash.Hash(bytesOf(0x23, 32)), Index: 0}, nil, [][]byte{bytesOf(0x33, 64)}))
	a3.AddTxOut(wire.NewTxOut(70000000, r0.script))
	a2 := wire.NewMsgTx(1)
	a2.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{}, wire.MaxPrevOutIndex), []byte{0x02, 0x38, 0x01}, nil))
	a2.AddTxOut(wire.NewTxOut(5000000000, r2.script))
	m1 := wire.NewMsgTx(1)
	m1.AddTxIn(wire.NewTxIn(&wire.OutPoint{Hash: a1.TxHash(), Index: 0}, nil, [][]byte{bytesOf(0x35, 64)}))
	m1.AddTxOut(wire.NewTxOut(100000000, c0.script))
	m1.AddTxOut(wire.NewTxOut(49990000, other))

	confs := map[*wire.MsgTx]int32{a1: 6, a3: 3, a2: 10}
	blockOf := func(tx *wire.MsgTx) string { return hexOf(bytesOf(byte(0xb0+confs[tx]), 32)) }
	header := params.GenesisBlock.BlockHeader()
	search := func(txs ...*wire.MsgTx) []rpcSearchRawTransactionsResult {
		out := make([]rpcSearchRawTransactionsResult, len(txs))
		for i, mtx := range txs {
			r := &out[i]
			r.Hex, err = messageToHex(mtx)
			must(err)
			r.Txid = mtx.TxHash().String()
			r.Vin, err = createVinListPrevOut(s, mtx, params, false, nil)
			must(err)
			r.Vout = createVoutList(mtx, params, nil)
			r.Version = mtx.Version
			r.LockTime = mtx.LockTime
			if c, ok := confs[mtx]; ok {
				r.Time, r.Blocktime = header.Timestamp.Unix(), header.Timestamp.Unix()
				r.BlockHash = blockOf(mtx)
				r.Confirmations = uint64(c)
			}
		}
		return out
	}
	expect := map[string]any{
		"seed": hexOf(seed), "receive0": r0.addr.EncodeAddress(), "receive1": r1.addr.EncodeAddress(),
		"receive2": r2.addr.EncodeAddress(), "change0": c0.addr.EncodeAddress(), "tip": tip,
		"a1": a1.TxHash().String(), "a2": a2.TxHash().String(), "a3": a3.TxHash().String(), "m1": m1.TxHash().String(),
		"confirmed": grains(70000000), "unconfirmed": grains(100000000), "immature": grains(5000000000),
		"blocks": map[string]any{blockOf(a1): tip - 5, blockOf(a3): tip - 2, blockOf(a2): tip - 9},
	}
	reply("backend-search-receive0", search(a1, a3, m1), nil, expect)
	reply("backend-search-receive2", search(a2), nil, nil)
	reply("backend-search-change0", search(m1), nil, nil)
	for _, mtx := range []*wire.MsgTx{a1, a3, a2} {
		c := confs[mtx]
		reply("backend-header-"+strconv.Itoa(int(c)), btcjson.GetBlockHeaderVerboseResult{
			Hash: blockOf(mtx), Confirmations: int64(c), Height: tip - c + 1, Version: header.Version,
			VersionHex: fmt.Sprintf("%08x", header.Version), MerkleRoot: header.MerkleRoot.String(),
			PreviousHash: header.PrevBlock.String(), Time: header.Timestamp.Unix(),
			Bits: strconv.FormatInt(int64(header.Bits), 16), Difficulty: getDifficultyRatio(header.Bits, params),
			ProofCommitment: header.ProofCommitment.String(),
		}, nil, nil)
	}
	a1Raw, err := createTxRawResult(params, a1, a1.TxHash().String(), header, blockOf(a1), tip-5, tip)
	must(err)
	reply("backend-getrawtransaction-a1", a1Raw, nil, nil)
	txOut := func(mtx *wire.MsgTx, index int, coinbase bool) *rpcGetTxOutResult {
		out := mtx.TxOut[index]
		disasm, _ := txscript.DisasmString(out.PkScript)
		class, addrs, reqSigs, _ := txscript.ExtractPkScriptAddrs(out.PkScript, params)
		return &rpcGetTxOutResult{Value: rpcAmount(out.Value), GetTxOutResult: btcjson.GetTxOutResult{
			BestBlock: params.GenesisHash.String(), Confirmations: int64(confs[mtx]), Coinbase: coinbase,
			ScriptPubKey: btcjson.ScriptPubKeyResult{
				Asm: disasm, Hex: hexOf(out.PkScript), ReqSigs: int32(reqSigs), Type: class.String(),
				Address: addrs[0].EncodeAddress(), Addresses: []string{addrs[0].EncodeAddress()},
			},
		}}
	}
	// gettxout still reports a1:0, which only the mempool has spent.
	reply("backend-gettxout-a1", txOut(a1, 0, false), nil, nil)
	reply("backend-gettxout-a3", txOut(a3, 0, false), nil, nil)
	reply("backend-spending-a1", []*btcjson.GetTxSpendingPrevOutResult{{Txid: a1.TxHash().String(), Vout: 0, SpendingTxid: m1.TxHash().String()}}, nil, nil)
	reply("backend-spending-a3", []*btcjson.GetTxSpendingPrevOutResult{{Txid: a3.TxHash().String(), Vout: 0}}, nil, nil)

	// The same history from Oyster. listunspent leaves out the immature
	// coinbase output and reports no coinbase flag.
	unspent := func(mtx *wire.MsgTx, index uint32, c child, confirmations int64) *btcjson.ListUnspentResult {
		return &btcjson.ListUnspentResult{
			TxID: mtx.TxHash().String(), Vout: index, Address: c.addr.EncodeAddress(), Account: "default",
			ScriptPubKey: hexOf(c.script), Amount: btcutil.Amount(mtx.TxOut[index].Value).ToPRL(),
			Confirmations: confirmations, Spendable: true,
		}
	}
	reply("backend-listunspent", []*btcjson.ListUnspentResult{unspent(m1, 0, c0, 0), unspent(a3, 0, r0, 3)}, nil, nil)
	entry := func(mtx *wire.MsgTx, index uint32, c child, category string) btcjson.ListTransactionsResult {
		e := btcjson.ListTransactionsResult{
			Account: "default", Address: c.addr.EncodeAddress(), Amount: btcutil.Amount(mtx.TxOut[index].Value).ToPRL(),
			Category: category, Generated: category != "receive", Time: 1767225600, TimeReceived: 1767225600,
			TxID: mtx.TxHash().String(), Vout: index, WalletConflicts: []string{},
		}
		if conf, ok := confs[mtx]; ok {
			e.BlockHash, e.BlockTime, e.Confirmations = blockOf(mtx), header.Timestamp.Unix(), int64(conf)
		}
		return e
	}
	// m1 pays change back, which lists nothing, and 0.4999 PRL to someone else.
	m1Fee := btcutil.Amount(-10000).ToPRL()
	m1Send := btcjson.ListTransactionsResult{
		Amount: -btcutil.Amount(49990000).ToPRL(), Category: "send", Fee: &m1Fee, Time: 1767225600, TimeReceived: 1767225600,
		TxID: m1.TxHash().String(), Vout: 1, WalletConflicts: []string{},
	}
	all := []btcjson.ListTransactionsResult{m1Send, entry(a3, 0, r0, "receive"), entry(a1, 0, r0, "receive"), entry(a2, 0, r2, "immature")}
	reply("backend-listalltransactions", all, nil, nil)
	reply("backend-listaddresstransactions-receive0", []btcjson.ListTransactionsResult{all[2], all[1]}, nil, nil)
	reply("backend-listaddresstransactions-receive2", []btcjson.ListTransactionsResult{all[3]}, nil, nil)
	// m1 pays change/0, so Oyster selects it, and lists only the send.
	reply("backend-listaddresstransactions-change0", []btcjson.ListTransactionsResult{m1Send}, nil, nil)
	reply("backend-listaddresstransactions-none", []btcjson.ListTransactionsResult{}, nil, nil)
	reply("backend-getbestblock", &btcjson.GetBestBlockResult{Hash: params.GenesisHash.String(), Height: tip}, nil, nil)
}

// laterFixtures holds the methods typed after the first rounds, built from
// btcjson types as structFixtures does. They come last so the reply ids of
// the fixtures before them stay as they were.
func laterFixtures(t *testing.T, params *chaincfg.Params, reply func(string, any, error, map[string]any), priv *btcec.PrivateKey) {
	t.Helper()
	addr, err := btcutil.NewAddressTaproot(txscript.ComputeTaprootKeyNoScript(priv.PubKey()).SerializeCompressed()[1:], params)
	if err != nil {
		t.Fatal(err)
	}
	txid := hexOf(bytesOf(0xab, 32))
	const received = int64(70000000)

	// Oyster.
	reply("getaccountaddress", addr.EncodeAddress(), nil, nil)
	reply("getreceivedbyaccount", btcutil.Amount(received).ToPRL(), nil, map[string]any{"amount": grains(received)})
	reply("listreceivedbyaccount", []btcjson.ListReceivedByAccountResult{
		{Account: "default", Amount: btcutil.Amount(received).ToPRL(), Confirmations: 6},
		{Account: "imported", Amount: 0, Confirmations: 0},
	}, nil, map[string]any{"amount": grains(received)})
	reply("sendfrom", txid, nil, nil)
	// settxfee in Oyster checks the sign of the amount and changes nothing.
	reply("settxfee", true, nil, nil)
	reply("keypoolrefill", nil, nil, nil)

	// pearld methods whose handlers need the peer-to-peer side.
	const sentBytes, recvBytes = uint64(9007199254740993), uint64(5678)
	reply("getnettotals", &btcjson.GetNetTotalsResult{TotalBytesRecv: recvBytes, TotalBytesSent: sentBytes, TimeMillis: 1767225600123},
		nil, map[string]any{"sent": strconv.FormatUint(sentBytes, 10), "received": strconv.FormatUint(recvBytes, 10)})
	reply("uptime", int64(86400), nil, nil)
	reply("getnodeaddresses", []*btcjson.GetNodeAddressesResult{
		{Time: 1767225600, Services: uint64(wire.SFNodeNetwork | wire.SFNodeWitness), Address: "203.0.113.7", Port: 44108},
	}, nil, map[string]any{"services": strconv.FormatUint(uint64(wire.SFNodeNetwork|wire.SFNodeWitness), 10)})
	connected := true
	reply("getaddednodeinfo-dns", []*btcjson.GetAddedNodeInfoResult{{
		AddedNode: "node.example:44108", Connected: &connected,
		Addresses: &[]btcjson.GetAddedNodeInfoResultAddr{{Address: "203.0.113.7:44108", Connected: "outbound"}},
	}}, nil, nil)
	reply("ping", nil, nil, nil)
}

// handlerTables lists every method pearld and Oyster dispatch, so pearljs can
// check its typed methods against them: pearld's HTTP and websocket tables
// and the limited user's allowlist from this package, and Oyster's table read
// from the source of wallet/rpc/jsonrpc, whose map is unexported. Oyster
// methods whose handler is `unimplemented` or `unsupported` are listed apart.
func handlerTables(t *testing.T) map[string]any {
	t.Helper()
	keys := func(m map[string]struct{}) []string {
		out := make([]string, 0, len(m))
		for k := range m {
			out = append(out, k)
		}
		sort.Strings(out)
		return out
	}
	pearld := map[string]struct{}{}
	for k := range rpcHandlers {
		pearld[k] = struct{}{}
	}
	websocket := map[string]struct{}{}
	for k := range wsHandlers {
		websocket[k] = struct{}{}
	}

	file, err := parser.ParseFile(token.NewFileSet(), "../wallet/rpc/jsonrpc/methods.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	oyster, refused := map[string]struct{}{}, map[string]struct{}{}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok || len(spec.Names) != 1 || spec.Names[0].Name != "rpcHandlers" {
			return true
		}
		for _, elt := range spec.Values[0].(*ast.CompositeLit).Elts {
			kv := elt.(*ast.KeyValueExpr)
			name, err := strconv.Unquote(kv.Key.(*ast.BasicLit).Value)
			if err != nil {
				t.Fatal(err)
			}
			target := oyster
			for _, field := range kv.Value.(*ast.CompositeLit).Elts {
				if f, ok := field.(*ast.KeyValueExpr); ok {
					if id, ok := f.Value.(*ast.Ident); ok && (id.Name == "unimplemented" || id.Name == "unsupported") {
						target = refused
					}
				}
			}
			target[name] = struct{}{}
		}
		return false
	})
	if len(oyster) == 0 {
		t.Fatal("found no Oyster handlers")
	}
	return map[string]any{
		"pearld": keys(pearld), "websocket": keys(websocket), "limited": keys(rpcLimited),
		"unimplemented": keys(rpcUnimplemented), "oyster": keys(oyster), "oysterRefused": keys(refused),
	}
}

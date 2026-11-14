// Websocket frame fixtures for pearljs's websocket client. Like
// rpcfixtures_test.go, the file joins pearld's package main through a build
// overlay, so notifications come from pearld's own notification manager and
// btcjson types, not from hand-written JSON. From a Pearl source checkout:
//
//	echo '{"Replace":{"/path/to/pearl/node/pearljs_wsfixtures_test.go":"/path/to/pearljs/vectors/wsfixtures_test.go"}}' > /tmp/overlay.json
//	PEARLJS_BLOCKS=/path/to/pearljs/vectors/pearl-go.json \
//	PEARLJS_WS_FIXTURES=/path/to/pearljs/test/fixtures/ws-frames.json \
//	  go -C /path/to/pearl/node test -overlay /tmp/overlay.json -run TestPearljsWSFixtures -count=1 .
//
// Each fixture is the exact frame pearld writes, plus the values the
// TypeScript side must decode from it.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/pearl-research-labs/pearl/node/btcjson"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/mempool"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

type wsFixture struct {
	Frame  string         `json:"frame"`
	Expect map[string]any `json:"expect,omitempty"`
}

// noSpends stands in for the mempool, which notifyreceived consults for
// outputs already spent there.
type noSpends struct{ mempool.TxMempool }

func (noSpends) CheckSpend(wire.OutPoint) *btcutil.Tx { return nil }

func TestPearljsWSFixtures(t *testing.T) {
	out := os.Getenv("PEARLJS_WS_FIXTURES")
	if out == "" {
		t.Skip("PEARLJS_WS_FIXTURES not set")
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	params := &chaincfg.RegressionNetParams
	server := &rpcServer{cfg: rpcserverConfig{ChainParams: params, TxMemPool: noSpends{}}}
	mgr := &wsNotificationManager{server: server}

	var source struct {
		Blocks []struct {
			Name string `json:"name"`
			Hex  string `json:"hex"`
		} `json:"blocks"`
	}
	raw, err := os.ReadFile(os.Getenv("PEARLJS_BLOCKS"))
	must(err)
	must(json.Unmarshal(raw, &source))
	var msgBlock wire.MsgBlock
	for _, b := range source.Blocks {
		if b.Name == "v3-four-spends" {
			data, err := hex.DecodeString(b.Hex)
			must(err)
			must(msgBlock.Deserialize(bytes.NewReader(data)))
		}
	}
	block := btcutil.NewBlock(&msgBlock)
	block.SetHeight(321)
	header := msgBlock.BlockHeader()
	spend := block.Transactions()[1]
	_, addrs, _, err := txscript.ExtractPkScriptAddrs(spend.MsgTx().TxOut[0].PkScript, params)
	must(err)
	watched := addrs[0].EncodeAddress()

	newClient := func(filter *wsClientFilter) *wsClient {
		return &wsClient{
			server: server, ntfnChan: make(chan []byte, 64), quit: make(chan struct{}),
			addrRequests: map[string]struct{}{}, spentRequests: map[wire.OutPoint]struct{}{},
			filterData: filter,
		}
	}
	one := func(c *wsClient) map[chan struct{}]*wsClient { return map[chan struct{}]*wsClient{c.quit: c} }
	frames := func(c *wsClient) []string {
		var got []string
		for {
			select {
			case f := <-c.ntfnChan:
				got = append(got, string(f))
			default:
				return got
			}
		}
	}
	only := func(c *wsClient) string {
		t.Helper()
		got := frames(c)
		if len(got) != 1 {
			t.Fatalf("expected one frame, got %d", len(got))
		}
		return got[0]
	}

	fixtures := map[string]wsFixture{}
	txids := func(hexes []string) []string {
		ids := []string{}
		for _, h := range hexes {
			data, err := hex.DecodeString(h)
			must(err)
			var tx wire.MsgTx
			must(tx.Deserialize(bytes.NewReader(data)))
			ids = append(ids, tx.TxHash().String())
		}
		return ids
	}
	headerExpect := map[string]any{
		"version":         header.Version,
		"prevBlock":       hex.EncodeToString(header.PrevBlock[:]),
		"merkleRoot":      hex.EncodeToString(header.MerkleRoot[:]),
		"timestamp":       header.Timestamp.Unix(),
		"bits":            header.Bits,
		"proofCommitment": hex.EncodeToString(header.ProofCommitment[:]),
	}
	blockExpect := map[string]any{"hash": block.Hash().String(), "height": block.Height(), "time": header.Timestamp.Unix()}

	plain := newClient(nil)
	mgr.notifyBlockConnected(one(plain), block)
	fixtures["blockconnected"] = wsFixture{only(plain), blockExpect}
	mgr.notifyBlockDisconnected(one(plain), block)
	fixtures["blockdisconnected"] = wsFixture{only(plain), blockExpect}

	// A client with a loaded filter gets the transactions paying its address.
	filtered := newClient(newWSClientFilter([]string{watched}, nil, params))
	mgr.notifyFilteredBlockConnected(one(filtered), block)
	frame := only(filtered)
	var parsed struct {
		Params []json.RawMessage `json:"params"`
	}
	must(json.Unmarshal([]byte(frame), &parsed))
	var subscribed []string
	must(json.Unmarshal(parsed.Params[2], &subscribed))
	fixtures["filteredblockconnected"] = wsFixture{frame, map[string]any{
		"height": block.Height(), "hash": block.Hash().String(), "header": headerExpect, "txids": txids(subscribed),
	}}
	mgr.notifyFilteredBlockConnected(one(plain), block)
	fixtures["filteredblockconnected-empty"] = wsFixture{only(plain), map[string]any{"height": block.Height(), "txids": []string{}}}
	mgr.notifyFilteredBlockDisconnected(one(plain), block)
	fixtures["filteredblockdisconnected"] = wsFixture{only(plain), map[string]any{
		"height": block.Height(), "hash": block.Hash().String(), "header": headerExpect,
	}}

	// txaccepted carries the sum of the outputs as a float PRL amount.
	var total int64
	for _, o := range spend.MsgTx().TxOut {
		total += o.Value
	}
	values := []string{}
	for _, o := range spend.MsgTx().TxOut {
		values = append(values, strconv.FormatInt(o.Value, 10))
	}
	verbose := newClient(nil)
	verbose.verboseTxUpdates = true
	mgr.notifyForNewTx(one(plain), spend)
	fixtures["txaccepted"] = wsFixture{only(plain), map[string]any{"txid": spend.Hash().String(), "amount": strconv.FormatInt(total, 10)}}
	mgr.notifyForNewTx(one(verbose), spend)
	fixtures["txacceptedverbose"] = wsFixture{only(verbose), map[string]any{
		"txid": spend.Hash().String(), "values": values, "amount": strconv.FormatInt(total, 10),
	}}
	// A large exact amount, to show it survives the float in txaccepted.
	big := wire.NewMsgTx(2)
	big.AddTxIn(spend.MsgTx().TxIn[0])
	big.AddTxOut(wire.NewTxOut(2099999999999999, spend.MsgTx().TxOut[0].PkScript))
	big.AddTxOut(wire.NewTxOut(1, spend.MsgTx().TxOut[0].PkScript))
	mgr.notifyForNewTx(one(plain), btcutil.NewTx(big))
	fixtures["txaccepted-large"] = wsFixture{only(plain), map[string]any{"txid": big.TxHash().String(), "amount": "2100000000000000"}}

	mgr.notifyRelevantTxAccepted(spend, one(filtered))
	fixtures["relevanttxaccepted"] = wsFixture{only(filtered), map[string]any{"txid": spend.Hash().String()}}

	receiver := newClient(nil)
	ops := map[wire.OutPoint]map[chan struct{}]*wsClient{}
	mgr.notifyForTxOuts(ops, map[string]map[chan struct{}]*wsClient{watched: one(receiver)}, spend, block)
	fixtures["recvtx"] = wsFixture{only(receiver), map[string]any{
		"txid": spend.Hash().String(), "block": map[string]any{"hash": block.Hash().String(), "height": block.Height(), "index": spend.Index(), "time": header.Timestamp.Unix()},
	}}
	mgr.notifyForTxOuts(ops, map[string]map[chan struct{}]*wsClient{watched: one(receiver)}, spend, nil)
	fixtures["recvtx-mempool"] = wsFixture{only(receiver), map[string]any{"txid": spend.Hash().String()}}

	spender := newClient(nil)
	spentOps := map[wire.OutPoint]map[chan struct{}]*wsClient{spend.MsgTx().TxIn[0].PreviousOutPoint: one(spender)}
	mgr.notifyForTxIns(spentOps, spend, nil)
	fixtures["redeemingtx"] = wsFixture{only(spender), map[string]any{"txid": spend.Hash().String()}}

	for name, ntfn := range map[string]any{
		"rescanprogress": btcjson.NewRescanProgressNtfn(block.Hash().String(), block.Height(), header.Timestamp.Unix()),
		"rescanfinished": btcjson.NewRescanFinishedNtfn(block.Hash().String(), block.Height(), header.Timestamp.Unix()),
	} {
		f, err := btcjson.MarshalCmd(btcjson.RpcVersion1, nil, ntfn)
		must(err)
		fixtures[name] = wsFixture{string(f), blockExpect}
	}

	// Replies, as runCommand and authorizeRequest write them.
	reply := func(name string, id any, result any, rerr error, expect map[string]any) {
		body, err := createMarshalledReply(btcjson.RpcVersion1, id, result, rerr)
		must(err)
		fixtures[name] = wsFixture{string(body), expect}
	}
	reply("reply-authenticate", 1, nil, nil, nil)
	session, err := handleSession(&wsClient{sessionID: 18446744073709551557}, nil)
	must(err)
	reply("reply-session", 2, session, nil, map[string]any{"sessionId": "18446744073709551557"})
	rescanned := []btcjson.RescannedBlock{{Hash: block.Hash().String(), Transactions: []string{txHexString(spend.MsgTx())}}}
	reply("reply-rescanblocks", 3, &rescanned, nil, map[string]any{"hash": block.Hash().String(), "txid": spend.Hash().String()})
	reply("reply-limited", 4, nil, &btcjson.RPCError{
		Code: btcjson.ErrRPCInvalidParams.Code, Message: "limited user not authorized for this method",
	}, map[string]any{"code": btcjson.ErrRPCInvalidParams.Code})
	reply("reply-parse-error", nil, nil, &btcjson.RPCError{Code: btcjson.ErrRPCParse.Code, Message: "Failed to parse request: unexpected end of JSON input"}, nil)

	data, err := json.MarshalIndent(fixtures, "", "  ")
	must(err)
	must(os.WriteFile(out, append(data, '\n'), 0o644))
}

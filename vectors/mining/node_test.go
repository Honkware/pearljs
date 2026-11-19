// Mining vectors from pearld's own code: the coinbase its block templates
// carry (standardCoinbaseScript, createCoinbaseTx, AddWitnessCommitment), the
// merkle root over it, the height read back by ExtractCoinbaseHeight, and the
// rank-penalty rule through zkpow.CheckRankPenalty and CheckCertificateRules.
// The file joins package mining through a build overlay, since the coinbase
// helpers are unexported, and needs the zk-pow Go bindings built for the
// zkpow tag. From a Pearl source checkout:
//
//	echo '{"Replace":{"/path/to/pearl/node/mining/pearljs_mining_test.go":"/path/to/pearljs/vectors/mining/node_test.go"}}' > /tmp/overlay.json
//	PEARLJS_MINING_ZKPOW=/path/to/pearljs/vectors/mining/zkpow.json \
//	PEARLJS_MINING_OUT=/path/to/pearljs/vectors/mining/node.json PEARL_COMMIT=<sha> \
//	  go -C /path/to/pearl/node test -tags zkpow -overlay /tmp/overlay.json -run TestPearljsMiningVectors -count=1 ./mining
//
// zkpow.json comes first: its public data is what the rank-penalty rule is run on.
package mining

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"testing"

	"github.com/pearl-research-labs/pearl/node/blockchain"
	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
)

type pearljsCoinbase struct {
	Network           string   `json:"network"`
	Height            int32    `json:"height"`
	ExtraNonce        uint64   `json:"extraNonce,string"`
	PayTo             string   `json:"payTo"`
	Fees              int64    `json:"fees"`
	Transactions      []string `json:"transactions"`
	Script            string   `json:"script"`
	Coinbase          string   `json:"coinbase"`
	CoinbaseTxid      string   `json:"coinbaseTxid"`
	Value             int64    `json:"value"`
	WitnessCommitment string   `json:"witnessCommitment"`
	MerkleRoot        string   `json:"merkleRoot"`
	ExtractedHeight   int32    `json:"extractedHeight"`
}

type pearljsRankCase struct {
	Bits       uint32  `json:"bits"`
	PublicData string  `json:"publicData"`
	Error      *string `json:"error"`
}

type pearljsRuleCase struct {
	Network    string  `json:"network"`
	Height     int32   `json:"height"`
	Bits       uint32  `json:"bits"`
	PublicData string  `json:"publicData"`
	Error      *string `json:"error"`
}

func pearljsBytes(seed byte, n int) []byte {
	out := make([]byte, n)
	state := uint32(seed)*2654435761 + 1
	for i := range out {
		state ^= state << 13
		state ^= state >> 17
		state ^= state << 5
		out[i] = byte(state >> 24)
	}
	return out
}

// pearljsTx is an ordinary spend, with a witness when witness is set.
func pearljsTx(seed byte, witness bool) *btcutil.Tx {
	tx := wire.NewMsgTx(2)
	var prev chainhash.Hash
	copy(prev[:], pearljsBytes(seed, 32))
	in := wire.NewTxIn(wire.NewOutPoint(&prev, uint32(seed)), nil, nil)
	if witness {
		in.SetWitness(wire.TxWitness{pearljsBytes(seed+1, 64)})
	}
	tx.AddTxIn(in)
	tx.AddTxOut(wire.NewTxOut(int64(seed)*1000, append([]byte{0x51, 0x20}, pearljsBytes(seed+2, 32)...)))
	return btcutil.NewTx(tx)
}

func pearljsHex(tx *wire.MsgTx) string {
	var buf []byte
	w := &pearljsWriter{&buf}
	if err := tx.Serialize(w); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf)
}

type pearljsWriter struct{ buf *[]byte }

func (w *pearljsWriter) Write(p []byte) (int, error) {
	*w.buf = append(*w.buf, p...)
	return len(p), nil
}

func pearljsErr(err error) *string {
	if err == nil {
		return nil
	}
	s := err.Error()
	return &s
}

func TestPearljsMiningVectors(t *testing.T) {
	out := map[string]any{
		"source": "github.com/pearl-research-labs/pearl node (master)",
		"commit": os.Getenv("PEARL_COMMIT"),
	}
	flags, err := txscript.NewScriptBuilder().AddData([]byte(CoinbaseFlags)).Script()
	if err != nil {
		t.Fatal(err)
	}
	out["coinbaseFlags"] = CoinbaseFlags
	out["coinbaseAuxFlags"] = hex.EncodeToString(flags)

	nets := map[string]*chaincfg.Params{"mainnet": &chaincfg.MainNetParams, "regtest": &chaincfg.RegressionNetParams}
	priv, _ := btcec.PrivKeyFromBytes(pearljsBytes(9, 32))
	key := txscript.ComputeTaprootKeyNoScript(priv.PubKey()).SerializeCompressed()[1:]

	txSets := [][]*btcutil.Tx{
		nil,
		{pearljsTx(10, false)},
		{pearljsTx(20, true), pearljsTx(30, false)},
		{pearljsTx(40, true), pearljsTx(50, true), pearljsTx(60, false), pearljsTx(70, true)},
	}
	var coinbases []pearljsCoinbase
	cases := []struct {
		net        string
		height     int32
		extraNonce uint64
		pay        bool
		txs        int
		fees       int64
	}{
		{"regtest", 1, 0, true, 0, 0},
		{"regtest", 16, 0, true, 1, 1234},
		{"regtest", 17, 1, true, 2, 99999},
		{"regtest", 127, 16, true, 3, 5},
		{"mainnet", 128, 17, true, 0, 0},
		{"mainnet", 255, 255, true, 1, 1},
		{"mainnet", 256, 256, false, 2, 77},
		{"mainnet", 32767, 1 << 32, true, 3, 123456789},
		{"mainnet", 32768, 1<<63 - 1, true, 1, 0},
		{"mainnet", 65535, 0, true, 0, 0},
		{"mainnet", 8388607, 0, true, 2, 0},
		{"mainnet", 8388608, 7, true, 1, 0},
		{"mainnet", 2147483647, 0, false, 0, 0},
	}
	for _, c := range cases {
		params := nets[c.net]
		var addr btcutil.Address
		payTo := ""
		if c.pay {
			addr, err = btcutil.NewAddressTaproot(key, params)
			if err != nil {
				t.Fatal(err)
			}
			payTo = addr.EncodeAddress()
		}
		script, err := standardCoinbaseScript(c.height, c.extraNonce)
		if err != nil {
			t.Fatal(err)
		}
		coinbase, err := createCoinbaseTx(params, script, c.height, addr)
		if err != nil {
			t.Fatal(err)
		}
		coinbase.MsgTx().TxOut[0].Value += c.fees
		txs := append([]*btcutil.Tx{coinbase}, txSets[c.txs]...)
		commitment := AddWitnessCommitment(coinbase, txs)
		// AddWitnessCommitment changes the coinbase, so its hashes are taken afresh.
		cb := btcutil.NewTx(coinbase.MsgTx())
		txs[0] = cb
		root := blockchain.CalcMerkleRoot(txs, false)
		height, err := blockchain.ExtractCoinbaseHeight(cb)
		if err != nil {
			t.Fatal(err)
		}
		var others []string
		for _, tx := range txSets[c.txs] {
			others = append(others, pearljsHex(tx.MsgTx()))
		}
		coinbases = append(coinbases, pearljsCoinbase{
			Network: c.net, Height: c.height, ExtraNonce: c.extraNonce, PayTo: payTo, Fees: c.fees,
			Transactions: others, Script: hex.EncodeToString(script), Coinbase: pearljsHex(cb.MsgTx()),
			CoinbaseTxid: cb.Hash().String(), Value: cb.MsgTx().TxOut[0].Value,
			WitnessCommitment: hex.EncodeToString(commitment), MerkleRoot: root.String(), ExtractedHeight: height,
		})
	}
	out["coinbases"] = coinbases

	// The rank-penalty rule on zk-pow's public data vectors.
	raw, err := os.ReadFile(os.Getenv("PEARLJS_MINING_ZKPOW"))
	if err != nil {
		t.Fatal(err)
	}
	var zk struct {
		PublicData []struct {
			Hex string `json:"hex"`
		} `json:"publicData"`
		RankPenalty []struct {
			Jackpot string `json:"jackpot"`
		} `json:"rankPenalty"`
	}
	if err := json.Unmarshal(raw, &zk); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	var blobs [][]byte
	for _, p := range zk.PublicData {
		if !seen[p.Hex] {
			seen[p.Hex] = true
			b, _ := hex.DecodeString(p.Hex)
			blobs = append(blobs, b)
		}
	}
	// The first blob with its jackpot replaced, from zero to all ones.
	for _, fill := range []byte{0x00, 0x01, 0x80, 0xff} {
		b := append([]byte(nil), blobs[0]...)
		for i := 116; i < 148; i++ {
			b[i] = fill
		}
		blobs = append(blobs, b)
	}
	blobs = append(blobs, []byte{0x01}, make([]byte, 165), make([]byte, 198), make([]byte, 199))
	var rank []pearljsRankCase
	for _, bits := range []uint32{0x1d00ffff, 0x1e01ffff, 0x207fffff, 0x1c0ffff0} {
		for _, b := range blobs {
			rank = append(rank, pearljsRankCase{bits, hex.EncodeToString(b), pearljsErr(zkpow.CheckRankPenalty(bits, b))})
		}
	}
	out["rankPenalty"] = rank

	// CheckCertificateRules around each network's rank-penalty fork, PoW checks on.
	var rules []pearljsRuleCase
	for _, name := range []string{"mainnet", "regtest"} {
		params := nets[name]
		for _, height := range []int32{params.RankPenaltyForkHeight - 1, params.RankPenaltyForkHeight, params.RankPenaltyForkHeight + 1} {
			version := params.RequiredCertVersion(height)
			if height < 1 || (version != wire.CertificateVersionV2 && version != wire.CertificateVersionV3) {
				continue
			}
			for _, b := range blobs[len(blobs)-8 : len(blobs)-4] {
				v2 := wire.CertificateV2{PublicDataLen: uint32(len(b)), ProofData: []byte{1}}
				copy(v2.PublicData[:], b)
				var cert wire.BlockCertificate = &v2
				if version == wire.CertificateVersionV3 {
					cert = &wire.CertificateV3{CertificateV2: v2}
				}
				header := &wire.BlockHeader{Bits: 0x1d00ffff}
				err := blockchain.CheckCertificateRules(header, cert, height, params, blockchain.BFNone)
				rules = append(rules, pearljsRuleCase{name, height, header.Bits, hex.EncodeToString(b), pearljsErr(err)})
			}
		}
	}
	out["certificateRules"] = rules

	data, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("PEARLJS_MINING_OUT"), append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

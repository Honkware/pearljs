// FP8 vectors from Pearl's fp8-scheme branch, kept apart from pearl-go.json,
// which stays generated from master. Run with an fp8-scheme checkout whose
// XMSS library and zk-pow Go bindings are built (`make -C xmss`, then
// `cargo build --release` in zk-pow/bindings/go after build_cache), so the
// real V4 verifier judges the certificates:
//
//	CGO_ENABLED=1 CGO_LDFLAGS_ALLOW='.*zk_pow_ffi.*' go -C /path/to/pearl/node run -tags xmss,zkpow \
//	  /path/to/pearljs/vectors/fp8/generate.go -commit <sha> -out /path/to/pearljs/vectors/fp8.json
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"time"

	"github.com/pearl-research-labs/pearl/node/blockchain"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
	"github.com/pearl-research-labs/pearl/version"
)

type Limits struct {
	CertificateMaxSize     int    `json:"certificateMaxSize"`
	CertificateVersionSize int    `json:"certificateVersionSize"`
	MaxZKProofSize         int    `json:"maxZKProofSize"`
	PublicDataMaxSizeV2    int    `json:"publicDataMaxSizeV2"`
	PublicDataMaxSizeV4    int    `json:"publicDataMaxSizeV4"`
	MaxAncestorHeaders     int    `json:"maxAncestorHeaders"`
	ProtocolVersion        uint32 `json:"protocolVersion"`
}

type CertRuleVector struct {
	Height        int32  `json:"height"`
	Version       uint32 `json:"version"`
	PublicDataLen int    `json:"publicDataLen"`
	Required      uint32 `json:"required"`
	Error         string `json:"error"`
}

type NetworkVector struct {
	Name                  string           `json:"name"`
	MoEForkHeight         int32            `json:"moeForkHeight"`
	DenseOnlyForkHeight   int32            `json:"denseOnlyForkHeight"`
	RankPenaltyForkHeight int32            `json:"rankPenaltyForkHeight"`
	SaltedSeedForkHeight  int32            `json:"saltedSeedForkHeight"`
	Fp8ForkHeight         int32            `json:"fp8ForkHeight"`
	CertRules             []CertRuleVector `json:"certRules"`
}

// BlockVector is what Pearl computes for a block. VerifyError is
// zkpow.VerifyCertificate's verdict, empty when the proof verifies.
type BlockVector struct {
	Name                   string   `json:"name"`
	Hex                    string   `json:"hex"`
	Hash                   string   `json:"hash"`
	CertificateVersion     uint32   `json:"certificateVersion"`
	CertificateHex         string   `json:"certificateHex"`
	CertificateSize        int      `json:"certificateSize"`
	ProofCommitment        string   `json:"proofCommitment"`
	IsMoE                  bool     `json:"isMoE"`
	AncestorCount          int      `json:"ancestorCount"`
	AncestorHeader         string   `json:"ancestorHeader"`
	CertificateHashMatches bool     `json:"certificateHashMatches"`
	CommitmentMatches      bool     `json:"commitmentMatches"`
	MerkleRootMatches      bool     `json:"merkleRootMatches"`
	VerifyError            string   `json:"verifyError"`
	TxIDs                  []string `json:"txids"`
	MerkleRoot             string   `json:"merkleRoot"`
	WitnessMerkleRoot      string   `json:"witnessMerkleRoot"`
	WitnessError           string   `json:"witnessError"`
	Size                   int      `json:"size"`
	StrippedSize           int      `json:"strippedSize"`
	NoWitnessSize          int      `json:"noWitnessSize"`
	Vsize                  int64    `json:"vsize"`
}

type BadBlockVector struct {
	Name  string `json:"name"`
	Hex   string `json:"hex"`
	Error string `json:"error"`
}

// EncodeErrorVector is a certificate of Version with zero-filled fields of
// the given lengths that MsgCertificate refuses to encode.
type EncodeErrorVector struct {
	Name          string `json:"name"`
	Version       uint32 `json:"version"`
	PublicDataLen int    `json:"publicDataLen"`
	ProofLen      int    `json:"proofLen"`
	Ancestors     int    `json:"ancestors"`
	Error         string `json:"error"`
}

type Vectors struct {
	Source       string              `json:"source"`
	Commit       string              `json:"commit"`
	PearlVersion string              `json:"pearlVersion"`
	Limits       Limits              `json:"limits"`
	Networks     []NetworkVector     `json:"networks"`
	Blocks       []BlockVector       `json:"blocks"`
	BadBlocks    []BadBlockVector    `json:"badBlocks"`
	EncodeErrors []EncodeErrorVector `json:"encodeErrors"`
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}

func patternBytes(n int, seed byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = seed + byte(i)
	}
	return out
}

func headerBytes(h *wire.BlockHeader) []byte {
	var buf bytes.Buffer
	check(h.Serialize(&buf))
	return buf.Bytes()
}

func serializeBlock(block *wire.MsgBlock) []byte {
	var buf bytes.Buffer
	check(block.Serialize(&buf))
	return buf.Bytes()
}

// fixture is Pearl's mined FP8 proof: header(76) | u32 public_data_len |
// public_data | u8 chain_len | chain(108 each) | proof_data, as
// zkpow/fp8_test.go reads it.
type fixture struct {
	header    wire.BlockHeader
	public    []byte
	ancestors []wire.BlockHeader
	proof     []byte
}

func loadFixture(device string) fixture {
	raw, err := os.ReadFile("zkpow/testdata/fp8_zk_proof_" + device + ".bin")
	check(err)
	publicLen := binary.LittleEndian.Uint32(raw[76:80])
	rest := bytes.NewReader(raw[80+publicLen:])
	chainLen, err := rest.ReadByte()
	check(err)
	f := fixture{public: raw[80 : 80+publicLen], ancestors: make([]wire.BlockHeader, chainLen)}
	for i := range f.ancestors {
		check(f.ancestors[i].Deserialize(rest))
	}
	f.proof = raw[len(raw)-rest.Len():]
	check(f.header.Deserialize(bytes.NewReader(append(append([]byte{}, raw[:76]...), make([]byte, 32)...))))
	return f
}

func coinbaseTx(height int64, withNonce bool) *wire.MsgTx {
	tx := wire.NewMsgTx(wire.TxVersion)
	sigScript, err := txscript.NewScriptBuilder().AddInt64(height).AddData([]byte("pearljs fp8")).Script()
	check(err)
	in := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{}, wire.MaxPrevOutIndex), sigScript, nil)
	if withNonce {
		in.SetWitness(wire.TxWitness{make([]byte, blockchain.CoinbaseWitnessDataLen)})
	}
	tx.AddTxIn(in)
	tx.AddTxOut(wire.NewTxOut(5_000_000_000, append([]byte{txscript.OP_1, txscript.OP_DATA_32}, patternBytes(32, 0x51)...)))
	return tx
}

// witnessSpend is a structurally valid spend with a witness; nothing checks its scripts.
func witnessSpend(seed byte) *wire.MsgTx {
	tx := wire.NewMsgTx(2)
	in := wire.NewTxIn(wire.NewOutPoint((*chainhash.Hash)(patternBytes(32, seed)), uint32(seed)), nil, wire.TxWitness{patternBytes(64, seed)})
	tx.AddTxIn(in)
	tx.AddTxOut(wire.NewTxOut(int64(seed)*1000, append([]byte{txscript.OP_2, txscript.OP_DATA_32}, patternBytes(32, seed+1)...)))
	return tx
}

func addWitnessCommitment(block *wire.MsgBlock) {
	coinbase := block.Transactions[0]
	nonce := coinbase.TxIn[0].DecodeWitness()[0]
	root := blockchain.CalcMerkleRoot(btcutil.NewBlock(block).Transactions(), true)
	commitment := chainhash.DoubleHashB(append(root[:], nonce...))
	coinbase.AddTxOut(wire.NewTxOut(0, append(append([]byte{}, blockchain.WitnessMagicBytes...), commitment...)))
}

// sealBlock binds header and certificate the way Pearl's miner does.
func sealBlock(block *wire.MsgBlock, cert wire.BlockCertificate) {
	header := block.BlockHeader()
	header.MerkleRoot = blockchain.CalcMerkleRoot(btcutil.NewBlock(block).Transactions(), false)
	header.ProofCommitment = cert.ProofCommitment()
	hash := header.BlockHash()
	switch c := cert.(type) {
	case *wire.CertificateV1:
		c.Hash = hash
	case *wire.CertificateV2:
		c.Hash = hash
	case *wire.CertificateV3:
		c.Hash = hash
	case *wire.CertificateV4:
		c.Hash = hash
	}
	block.MsgHeader.MsgCertificate.Certificate = cert
}

func verifyText(header *wire.BlockHeader, cert wire.BlockCertificate) string {
	if err := zkpow.VerifyCertificate(header, cert); err != nil {
		return err.Error()
	}
	return ""
}

func makeBlockVector(name string, block *wire.MsgBlock) BlockVector {
	raw := serializeBlock(block)
	var decoded wire.MsgBlock
	check(decoded.Deserialize(bytes.NewReader(raw)))
	if !bytes.Equal(serializeBlock(&decoded), raw) {
		panic(name + ": block does not round-trip")
	}
	utilBlock := btcutil.NewBlock(block)
	header := block.BlockHeader()
	cert := block.BlockCertificate()
	var certBuf bytes.Buffer
	check(block.MsgHeader.MsgCertificate.PrlEncode(&certBuf, 0))
	blockHash, commitment, certHash := header.BlockHash(), cert.ProofCommitment(), cert.BlockHash()
	vector := BlockVector{
		Name: name, Hex: hex.EncodeToString(raw), Hash: blockHash.String(),
		CertificateVersion: uint32(cert.Version()), CertificateHex: hex.EncodeToString(certBuf.Bytes()),
		CertificateSize: block.MsgHeader.MsgCertificate.SerializeSize(),
		ProofCommitment: hex.EncodeToString(commitment[:]), IsMoE: cert.IsMoE(),
		CertificateHashMatches: certHash == blockHash, CommitmentMatches: header.ProofCommitment == commitment,
		VerifyError:       verifyText(header, cert),
		MerkleRoot:        blockchain.CalcMerkleRoot(utilBlock.Transactions(), false).String(),
		MerkleRootMatches: blockchain.CalcMerkleRoot(utilBlock.Transactions(), false) == header.MerkleRoot,
		WitnessMerkleRoot: blockchain.CalcMerkleRoot(utilBlock.Transactions(), true).String(),
		Size:              block.SerializeSize(), StrippedSize: block.SerializeSizeStripped(),
		NoWitnessSize: block.SerializeSizeNoWitness(), Vsize: blockchain.GetBlockVsize(utilBlock),
	}
	if v4, ok := cert.(*wire.CertificateV4); ok {
		vector.AncestorCount = len(v4.AncestorHeaders)
		if len(v4.PublicData) >= wire.MaxBlockHeaderPayload {
			vector.AncestorHeader = hex.EncodeToString(v4.PublicData[:wire.MaxBlockHeaderPayload])
		}
	}
	for _, tx := range block.Transactions {
		vector.TxIDs = append(vector.TxIDs, tx.TxID())
	}
	if err := blockchain.ValidateWitnessCommitment(utilBlock); err != nil {
		vector.WitnessError = err.Error()
	}
	return vector
}

func main() {
	out := flag.String("out", "vectors/fp8.json", "output JSON path")
	commit := flag.String("commit", "", "the fp8-scheme commit this tree was taken from")
	flag.Parse()
	if *commit == "" {
		panic("-commit is required")
	}

	vectors := Vectors{
		Source: "github.com/pearl-research-labs/pearl fp8-scheme", Commit: *commit, PearlVersion: version.Version(),
		Limits: Limits{
			CertificateMaxSize: wire.CertificateMaxSize, CertificateVersionSize: wire.CertificateVersionSize,
			MaxZKProofSize: wire.MaxZKProofSize, PublicDataMaxSizeV2: wire.PublicDataMaxSizeV2,
			PublicDataMaxSizeV4: wire.PublicDataMaxSizeV4, MaxAncestorHeaders: wire.MaxCertificateV4AncestorHeaders,
			ProtocolVersion: wire.ProtocolVersion,
		},
	}

	// CheckCertificateRules (BFNoPoWCheck, so no rank penalty) around every
	// fork height of every network, for each version at a dense and a longer
	// public data length.
	for _, net := range []*chaincfg.Params{
		&chaincfg.MainNetParams, &chaincfg.TestNetParams, &chaincfg.TestNet2Params,
		&chaincfg.RegressionNetParams, &chaincfg.SimNetParams,
	} {
		v := NetworkVector{
			Name: net.Name, MoEForkHeight: net.MoEForkHeight, DenseOnlyForkHeight: net.DenseOnlyForkHeight,
			RankPenaltyForkHeight: net.RankPenaltyForkHeight, SaltedSeedForkHeight: net.SaltedSeedForkHeight,
			Fp8ForkHeight: net.Fp8ForkHeight,
		}
		heights := map[int32]bool{0: true, 1: true, 2: true, 1000: true, 1 << 30: true}
		for _, fork := range []int32{net.MoEForkHeight, net.DenseOnlyForkHeight, net.RankPenaltyForkHeight,
			net.SaltedSeedForkHeight, net.Fp8ForkHeight} {
			if fork > 0 {
				heights[fork-1], heights[fork], heights[fork+1] = true, true, true
			}
		}
		var sorted []int32
		for h := range heights {
			sorted = append(sorted, h)
		}
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		header := &wire.BlockHeader{}
		for _, height := range sorted {
			for _, cert := range []struct {
				version uint32
				size    int
			}{{1, wire.PublicDataSizeV1}, {2, wire.PublicDataSizeDenseV2}, {2, wire.PublicDataSizeDenseV2 + 1},
				{3, wire.PublicDataSizeDenseV2}, {3, wire.PublicDataSizeDenseV2 + 1}, {4, 240}, {4, 400}} {
				var c wire.BlockCertificate
				switch cert.version {
				case 1:
					c = &wire.CertificateV1{}
				case 2:
					c = &wire.CertificateV2{PublicDataLen: uint32(cert.size)}
				case 3:
					c = &wire.CertificateV3{CertificateV2: wire.CertificateV2{PublicDataLen: uint32(cert.size)}}
				default:
					c = &wire.CertificateV4{PublicData: make([]byte, cert.size)}
				}
				errText := ""
				if err := blockchain.CheckCertificateRules(header, c, height, net, blockchain.BFNoPoWCheck); err != nil {
					errText = err.Error()
				}
				v.CertRules = append(v.CertRules, CertRuleVector{
					Height: height, Version: cert.version, PublicDataLen: cert.size,
					Required: uint32(net.RequiredCertVersion(height)), Error: errText,
				})
			}
		}
		vectors.Networks = append(vectors.Networks, v)
	}

	// Pearl's own mined certificates, in a block carrying the fixture header.
	// Its merkle root is the fixture's, so these blocks hold no transactions
	// that match it; they exist for the certificate.
	for _, device := range []string{"h100", "b200"} {
		f := loadFixture(device)
		build := func(edit func(header *wire.BlockHeader, cert *wire.CertificateV4)) *wire.MsgBlock {
			header := f.header
			cert := &wire.CertificateV4{
				PublicData: append([]byte{}, f.public...), ProofData: append([]byte{}, f.proof...),
				AncestorHeaders: append([]wire.BlockHeader{}, f.ancestors...),
			}
			if edit != nil {
				edit(&header, cert)
			}
			header.ProofCommitment = cert.ProofCommitment()
			cert.Hash = header.BlockHash()
			block := &wire.MsgBlock{}
			block.MsgHeader.BlockHeader = header
			block.MsgHeader.MsgCertificate.Certificate = cert
			block.AddTransaction(coinbaseTx(1, false))
			return block
		}
		for _, item := range []struct {
			name string
			edit func(header *wire.BlockHeader, cert *wire.CertificateV4)
		}{
			{"mined", nil},
			{"mined-without-its-parent", func(_ *wire.BlockHeader, c *wire.CertificateV4) { c.AncestorHeaders = nil }},
			{"mined-parent-altered", func(_ *wire.BlockHeader, c *wire.CertificateV4) {
				c.AncestorHeaders[0].Timestamp = c.AncestorHeaders[0].Timestamp.Add(time.Second)
			}},
			{"mined-extra-ancestor", func(_ *wire.BlockHeader, c *wire.CertificateV4) {
				c.AncestorHeaders = append(c.AncestorHeaders, c.AncestorHeaders[0])
			}},
			{"mined-statement-ancestor-altered", func(_ *wire.BlockHeader, c *wire.CertificateV4) { c.PublicData[0] ^= 1 }},
			{"mined-header-prev-altered", func(h *wire.BlockHeader, _ *wire.CertificateV4) { h.PrevBlock[0] ^= 1 }},
			{"mined-header-time-altered", func(h *wire.BlockHeader, _ *wire.CertificateV4) { h.Timestamp = h.Timestamp.Add(time.Second) }},
			{"mined-proof-altered", func(_ *wire.BlockHeader, c *wire.CertificateV4) { c.ProofData[len(c.ProofData)/2] ^= 1 }},
			{"mined-public-data-short", func(_ *wire.BlockHeader, c *wire.CertificateV4) { c.PublicData = c.PublicData[:239] }},
		} {
			vectors.Blocks = append(vectors.Blocks, makeBlockVector("fixture-"+device+"-"+item.name, build(item.edit)))
		}
	}

	// Synthetic blocks: a chain of headers the V4 certificates key their
	// proofs by at every depth, with the mined fixture's statement after the
	// ancestor header so Pearl's verifier gets past decoding it.
	statement := loadFixture("h100")
	chain := make([]wire.BlockHeader, 5)
	chain[4] = wire.BlockHeader{Version: 1, PrevBlock: chainhash.Hash(patternBytes(32, 0x90)), MerkleRoot: chainhash.Hash(patternBytes(32, 0x91)),
		Timestamp: time.Unix(1_763_400_000, 0), Bits: statement.header.Bits, ProofCommitment: chainhash.Hash(patternBytes(32, 0x92))}
	for i := 3; i >= 1; i-- {
		chain[i] = chain[i+1]
		chain[i].PrevBlock = chain[i+1].BlockHash()
		chain[i].Timestamp = chain[i+1].Timestamp.Add(209 * time.Second)
		chain[i].ProofCommitment = chainhash.Hash(patternBytes(32, byte(0xa0+i)))
	}
	keyed := func(depth, size int) []byte {
		public := append(headerBytes(&chain[depth]), statement.public[wire.MaxBlockHeaderPayload:]...)
		if size > len(public) {
			public = append(public, patternBytes(size-len(public), byte(depth))...)
		}
		return public
	}
	for i, item := range []struct {
		name   string
		cert   wire.BlockCertificate
		spends int
	}{
		{"v4-keyed-by-parent", &wire.CertificateV4{PublicData: keyed(1, 0), ProofData: patternBytes(97, 0x11)}, 0},
		{"v4-keyed-by-grandparent", &wire.CertificateV4{PublicData: keyed(2, 0), ProofData: patternBytes(150, 0x12), AncestorHeaders: chain[1:2]}, 1},
		{"v4-keyed-at-depth-four", &wire.CertificateV4{PublicData: keyed(4, 0), ProofData: patternBytes(300, 0x13), AncestorHeaders: chain[1:4]}, 3},
		{"v4-longest-public-data", &wire.CertificateV4{PublicData: keyed(3, wire.PublicDataMaxSizeV4), ProofData: patternBytes(80, 0x14), AncestorHeaders: chain[1:3]}, 2},
		{"v4-largest-proof", &wire.CertificateV4{PublicData: keyed(1, 0), ProofData: patternBytes(wire.MaxZKProofSize, 0x15)}, 1},
		{"v4-broken-chain", &wire.CertificateV4{PublicData: keyed(3, 0), ProofData: patternBytes(90, 0x16), AncestorHeaders: []wire.BlockHeader{chain[1], chain[3]}}, 1},
		{"v4-empty-public-data", &wire.CertificateV4{ProofData: patternBytes(90, 0x17)}, 0},
		{"v4-empty-proof", &wire.CertificateV4{PublicData: keyed(1, 0)}, 0},
		{"v2-proof-past-legacy-limit", &wire.CertificateV2{PublicDataLen: 164, ProofData: patternBytes(zkLegacyLimit+1, 0x18)}, 1},
		{"v3-largest-wire-proof", &wire.CertificateV3{CertificateV2: wire.CertificateV2{PublicDataLen: 300, ProofData: patternBytes(wire.MaxZKProofSize, 0x19)}}, 0},
		{"v1-proof-past-legacy-limit", &wire.CertificateV1{ProofData: patternBytes(zkLegacyLimit+1, 0x1a)}, 0},
	} {
		block := &wire.MsgBlock{}
		block.MsgHeader.BlockHeader = wire.BlockHeader{
			Version: 0x20000000, PrevBlock: chain[1].BlockHash(),
			Timestamp: time.Unix(int64(1_763_401_000+i*209), 0), Bits: statement.header.Bits,
		}
		block.AddTransaction(coinbaseTx(int64(67415+i), item.spends > 0))
		for s := range item.spends {
			block.AddTransaction(witnessSpend(byte(0x30 + 16*i + s)))
		}
		if item.spends > 0 {
			addWitnessCommitment(block)
		}
		sealBlock(block, item.cert)
		vectors.Blocks = append(vectors.Blocks, makeBlockVector(item.name, block))
	}

	// Encodings Pearl's decoder refuses, built by editing v4-keyed-by-grandparent.
	var base []byte
	for _, b := range vectors.Blocks {
		if b.Name == "v4-keyed-by-grandparent" {
			base, _ = hex.DecodeString(b.Hex)
		}
	}
	publicLen := int(binary.LittleEndian.Uint32(base[36:]))
	proofAt := 40 + publicLen
	proofLen := int(binary.LittleEndian.Uint32(base[proofAt:]))
	countAt := proofAt + 4 + proofLen
	edit := func(f func(b []byte) []byte) []byte { return f(append([]byte{}, base...)) }
	splice := func(at, drop int, insert ...byte) []byte {
		return append(append(append([]byte{}, base[:at]...), insert...), base[at+drop:]...)
	}
	// A V2 certificate in place of the V4 one, written by hand since Pearl's
	// encoder refuses the lengths these carry.
	tail := base[countAt+1+wire.MaxBlockHeaderPayload:]
	v2Over := func(publicLen, proofLen int) []byte {
		var buf bytes.Buffer
		check(binary.Write(&buf, binary.LittleEndian, uint32(2)))
		buf.Write(make([]byte, 32))
		check(binary.Write(&buf, binary.LittleEndian, uint32(publicLen)))
		buf.Write(make([]byte, min(publicLen, wire.PublicDataMaxSizeV2)))
		check(binary.Write(&buf, binary.LittleEndian, uint32(proofLen)))
		buf.Write(make([]byte, min(proofLen, wire.MaxZKProofSize)))
		return append(buf.Bytes(), tail...)
	}
	for _, item := range []struct {
		name string
		raw  []byte
	}{
		{"unknown-certificate-version", edit(func(b []byte) []byte { b[0] = 5; return b })},
		{"v4-public-data-over-limit", edit(func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[36:], wire.PublicDataMaxSizeV4+1)
			return b
		})},
		{"v4-proof-over-limit", edit(func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[proofAt:], wire.MaxZKProofSize+1)
			return b
		})},
		{"v4-four-ancestors", edit(func(b []byte) []byte { b[countAt] = 4; return b })},
		{"v4-ancestor-count-huge", splice(countAt, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)},
		{"v4-ancestor-count-non-canonical", splice(countAt, 1, 0xfd, 0x01, 0x00)},
		{"v4-truncated-ancestor", base[:countAt+1+50]},
		{"v4-missing-ancestor-count", base[:countAt]},
		{"v2-proof-over-limit", v2Over(164, wire.MaxZKProofSize+1)},
		{"v2-public-data-over-limit", v2Over(wire.PublicDataMaxSizeV2+1, 10)},
		{"v2-body-past-certificate-limit", v2Over(wire.PublicDataMaxSizeV2, wire.CertificateMaxSize-wire.CertificateVersionSize-32-4-wire.PublicDataMaxSizeV2-4+1)},
	} {
		var block wire.MsgBlock
		err := block.Deserialize(bytes.NewReader(item.raw))
		if err == nil {
			panic(item.name + ": Pearl accepted a bad block")
		}
		vectors.BadBlocks = append(vectors.BadBlocks, BadBlockVector{Name: item.name, Hex: hex.EncodeToString(item.raw), Error: err.Error()})
	}

	for _, item := range []EncodeErrorVector{
		{Name: "v4-four-ancestors", Version: 4, PublicDataLen: 240, ProofLen: 10, Ancestors: 4},
		{Name: "v4-public-data-over-limit", Version: 4, PublicDataLen: wire.PublicDataMaxSizeV4 + 1, ProofLen: 10},
		{Name: "v4-proof-over-limit", Version: 4, PublicDataLen: 240, ProofLen: wire.MaxZKProofSize + 1},
		{Name: "v4-too-large", Version: 4, PublicDataLen: 240, ProofLen: wire.CertificateMaxSize},
		{Name: "v1-proof-over-limit", Version: 1, PublicDataLen: wire.PublicDataSizeV1, ProofLen: wire.MaxZKProofSize + 1},
		{Name: "v2-proof-over-limit", Version: 2, PublicDataLen: 164, ProofLen: wire.MaxZKProofSize + 1},
		{Name: "v3-too-large", Version: 3, PublicDataLen: wire.PublicDataMaxSizeV2, ProofLen: wire.MaxZKProofSize},
	} {
		var cert wire.BlockCertificate
		switch item.Version {
		case 1:
			cert = &wire.CertificateV1{ProofData: make([]byte, item.ProofLen)}
		case 2:
			cert = &wire.CertificateV2{PublicDataLen: uint32(item.PublicDataLen), ProofData: make([]byte, item.ProofLen)}
		case 3:
			cert = &wire.CertificateV3{CertificateV2: wire.CertificateV2{PublicDataLen: uint32(item.PublicDataLen), ProofData: make([]byte, item.ProofLen)}}
		default:
			cert = &wire.CertificateV4{PublicData: make([]byte, item.PublicDataLen), ProofData: make([]byte, item.ProofLen),
				AncestorHeaders: make([]wire.BlockHeader, item.Ancestors)}
		}
		msg := wire.MsgCertificate{Certificate: cert}
		err := msg.PrlEncode(&bytes.Buffer{}, 0)
		if err == nil {
			panic(item.Name + ": Pearl encoded a bad certificate")
		}
		item.Error = err.Error()
		vectors.EncodeErrors = append(vectors.EncodeErrors, item)
	}

	raw, err := json.MarshalIndent(vectors, "", "  ")
	check(err)
	check(os.WriteFile(*out, append(raw, '\n'), 0o644))
	fmt.Println("wrote", *out)
}

// zkpow's legacyMaxZKProofSize is unexported: the V1 to V3 proof limit before FP8.
const zkLegacyLimit = 60000

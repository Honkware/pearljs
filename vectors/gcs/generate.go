// Compact filter vectors for pearljs, written by Pearl's own gcs and
// gcs/builder packages. Run from a Pearl source checkout:
//
//	go -C /path/to/pearl/node run /path/to/pearljs/vectors/gcs/generate.go \
//	  -blocks /path/to/pearljs/vectors/pearl-go.json -out /path/to/pearljs/vectors/gcs.json
//
// Block filters are built over the blocks already in pearl-go.json plus one
// block with edge-case outputs, with prevout scripts chosen here. Synthetic
// filters cover other parameters, empty and single-entry sets, and the inputs
// at which Pearl's matchers report false positives. Items are named by a rule
// both sides share, item(tag, i), so large sets need not be written out.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/aead/siphash"
	"github.com/pearl-research-labs/pearl/node/btcutil/gcs"
	"github.com/pearl-research-labs/pearl/node/btcutil/gcs/builder"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

type Params struct {
	P uint8  `json:"p"`
	M uint64 `json:"m"`
}

type BlockFilter struct {
	Name           string   `json:"name"`
	BlockHex       string   `json:"blockHex"`
	BlockHash      string   `json:"blockHash"`
	Key            string   `json:"key"`
	PrevOutScripts []string `json:"prevOutScripts"`
	Entries        []string `json:"entries"`
	N              uint32   `json:"n"`
	Filter         string   `json:"filter"`
	FilterHash     string   `json:"filterHash"`
	PrevHeader     string   `json:"prevHeader"`
	Header         string   `json:"header"`
	Matches        []Match  `json:"matches"`
	MatchAny       []Any    `json:"matchAny"`
}

type Match struct {
	Item  string `json:"item"`
	Match bool   `json:"match"`
}

// Any is one MatchAny query. Queries are the explicit items plus
// item(Tag, i) for i in [From, From+Count).
type Any struct {
	Items    []string `json:"items"`
	Tag      string   `json:"tag,omitempty"`
	From     int      `json:"from,omitempty"`
	Count    int      `json:"count,omitempty"`
	MatchAny bool     `json:"matchAny"`
	Zip      bool     `json:"zip"`
	Hash     bool     `json:"hash"`
}

type Synthetic struct {
	Name    string  `json:"name"`
	Params  Params  `json:"params"`
	Key     string  `json:"key"`
	Tag     string  `json:"tag"`
	Count   int     `json:"count"`
	Filter  string  `json:"filter"`
	Matches []Match `json:"matches"`
	Any     []Any   `json:"matchAny"`
	Note    string  `json:"note,omitempty"`
}

type SipVector struct {
	Key  string `json:"key"`
	Data string `json:"data"`
	Hash string `json:"hash"`
}

type Vectors struct {
	Source    string        `json:"source"`
	Defaults  Params        `json:"defaults"`
	SipHash   []SipVector   `json:"siphash"`
	Blocks    []BlockFilter `json:"blocks"`
	Synthetic []Synthetic   `json:"synthetic"`
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}

// item is the rule both sides use for synthetic data: sha256(tag || be32(i)),
// cut to 8 + i%25 bytes so entry lengths vary.
func item(tag string, i int) []byte {
	var n [4]byte
	binary.BigEndian.PutUint32(n[:], uint32(i))
	sum := sha256.Sum256(append([]byte(tag), n[:]...))
	return sum[:8+i%25]
}

// key16 is the first 16 bytes of sha256(tag).
func key16(tag string) [gcs.KeySize]byte {
	var key [gcs.KeySize]byte
	sum := sha256.Sum256([]byte(tag))
	copy(key[:], sum[:])
	return key
}

func items(tag string, from, count int) [][]byte {
	out := make([][]byte, count)
	for i := range out {
		out[i] = item(tag, from+i)
	}
	return out
}

func hexAll(data [][]byte) []string {
	out := make([]string, len(data))
	for i, d := range data {
		out[i] = hex.EncodeToString(d)
	}
	return out
}

func nbytes(f *gcs.Filter) []byte {
	b, err := f.NBytes()
	check(err)
	return b
}

func anyQuery(f *gcs.Filter, key [gcs.KeySize]byte, explicit [][]byte, tag string, from, count int) Any {
	queries := append(append([][]byte{}, explicit...), items(tag, from, count)...)
	m, err := f.MatchAny(key, queries)
	check(err)
	z, err := f.ZipMatchAny(key, queries)
	check(err)
	h, err := f.HashMatchAny(key, queries)
	check(err)
	return Any{Items: hexAll(explicit), Tag: tag, From: from, Count: count, MatchAny: m, Zip: z, Hash: h}
}

func matches(f *gcs.Filter, key [gcs.KeySize]byte, queries [][]byte) []Match {
	out := make([]Match, len(queries))
	for i, q := range queries {
		ok, err := f.Match(key, q)
		check(err)
		out[i] = Match{Item: hex.EncodeToString(q), Match: ok}
	}
	return out
}

// search returns the first item(tag, i) for which hit reports true, testing
// batches at a time and narrowing a hit down to one item.
func search(tag string, start, batch int, hit func([][]byte) bool) (int, []byte) {
	for from := start; from < 1<<26; from += batch {
		if !hit(items(tag, from, batch)) {
			continue
		}
		lo, hi := from, from+batch
		for hi-lo > 1 {
			mid := (lo + hi) / 2
			if hit(items(tag, lo, mid-lo)) {
				hi = mid
			} else {
				lo = mid
			}
		}
		return lo, item(tag, lo)
	}
	panic("no hit for " + tag)
}

func p2tr(seed string) []byte {
	sum := sha256.Sum256([]byte(seed))
	return append([]byte{txscript.OP_1, txscript.OP_DATA_32}, sum[:]...)
}

func edgeBlock() *wire.MsgBlock {
	block := &wire.MsgBlock{}
	block.MsgHeader.BlockHeader = wire.BlockHeader{
		Version: 1, PrevBlock: chainhash.Hash{0x77},
		Timestamp: time.Unix(1_760_100_000, 0), Bits: 0x1d00ffff,
	}
	coinbase := wire.NewMsgTx(wire.TxVersion)
	coinbase.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{}, wire.MaxPrevOutIndex), []byte{0x01, 0x07}, nil))
	coinbase.AddTxOut(wire.NewTxOut(1, p2tr("edge-a")))
	coinbase.AddTxOut(wire.NewTxOut(1, nil))                                                // empty: left out
	coinbase.AddTxOut(wire.NewTxOut(0, []byte{txscript.OP_RETURN, 0x01, 0x2a}))             // OP_RETURN: left out
	coinbase.AddTxOut(wire.NewTxOut(1, []byte{txscript.OP_RETURN}))                         // bare OP_RETURN: left out
	coinbase.AddTxOut(wire.NewTxOut(1, p2tr("edge-a")))                                     // duplicate: counted once
	coinbase.AddTxOut(wire.NewTxOut(1, append([]byte{0x52, 0x20}, p2tr("edge-mr")[2:]...))) // P2MR
	coinbase.AddTxOut(wire.NewTxOut(1, []byte{txscript.OP_TRUE}))
	block.AddTransaction(coinbase)
	spend := wire.NewMsgTx(2)
	spend.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x01}, 0), nil, [][]byte{{0x01}}))
	spend.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x02}, 3), nil, [][]byte{{0x02}}))
	spend.AddTxOut(wire.NewTxOut(1000, p2tr("edge-b")))
	block.AddTransaction(spend)
	return block
}

func main() {
	blocksPath := flag.String("blocks", "", "pearl-go.json with the block vectors")
	out := flag.String("out", "", "output path")
	flag.Parse()
	if *blocksPath == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}

	var source struct {
		Blocks []struct {
			Name string `json:"name"`
			Hex  string `json:"hex"`
		} `json:"blocks"`
	}
	raw, err := os.ReadFile(*blocksPath)
	check(err)
	check(json.Unmarshal(raw, &source))

	vectors := Vectors{
		Source:   "github.com/pearl-research-labs/pearl/node/btcutil/gcs and gcs/builder",
		Defaults: Params{P: builder.DefaultP, M: builder.DefaultM},
	}

	type namedBlock struct {
		name  string
		block *wire.MsgBlock
	}
	var blocks []namedBlock
	for _, b := range source.Blocks {
		data, err := hex.DecodeString(b.Hex)
		check(err)
		var block wire.MsgBlock
		check(block.Deserialize(bytes.NewReader(data)))
		blocks = append(blocks, namedBlock{b.Name, &block})
	}
	blocks = append(blocks, namedBlock{"edge-outputs", edgeBlock()})

	// The filter-header chain runs through the blocks in this order, from a
	// zero previous header, as cfindex starts at genesis.
	var prevHeader chainhash.Hash
	for _, nb := range blocks {
		block := nb.block
		var prevScripts [][]byte
		spent := 0
		for _, tx := range block.Transactions[1:] {
			for range tx.TxIn {
				prevScripts = append(prevScripts, p2tr(fmt.Sprintf("%s-prev-%d", nb.name, spent)))
				spent++
			}
		}
		if nb.name == "edge-outputs" {
			// BuildBasicFilter drops empty prevout scripts but keeps an
			// OP_RETURN one, and a prevout script equal to an output once.
			prevScripts = append(prevScripts, nil, []byte{txscript.OP_RETURN, 0x00}, p2tr("edge-a"))
		}
		f, err := builder.BuildBasicFilter(block, prevScripts)
		check(err)
		hash := block.BlockHash()
		key := builder.DeriveKey(&hash)
		filterHash, err := builder.GetFilterHash(f)
		check(err)
		header, err := builder.MakeHeaderForFilter(f, prevHeader)
		check(err)

		var entries [][]byte
		for _, tx := range block.Transactions {
			for _, out := range tx.TxOut {
				entries = append(entries, out.PkScript)
			}
		}
		entries = append(entries, prevScripts...)
		queries := append(append([][]byte{}, entries...), p2tr(nb.name+"-absent"), []byte{})

		var buf bytes.Buffer
		check(block.Serialize(&buf))
		var outScripts [][]byte
		for _, tx := range block.Transactions {
			for _, out := range tx.TxOut {
				if len(out.PkScript) > 0 && out.PkScript[0] != txscript.OP_RETURN {
					outScripts = append(outScripts, out.PkScript)
				}
			}
		}
		vectors.Blocks = append(vectors.Blocks, BlockFilter{
			Name:           nb.name,
			BlockHex:       hex.EncodeToString(buf.Bytes()),
			BlockHash:      hash.String(),
			Key:            hex.EncodeToString(key[:]),
			PrevOutScripts: hexAll(prevScripts),
			Entries:        hexAll(entries),
			N:              f.N(),
			Filter:         hex.EncodeToString(nbytes(f)),
			FilterHash:     filterHash.String(),
			PrevHeader:     prevHeader.String(),
			Header:         header.String(),
			Matches:        matches(f, key, queries),
			MatchAny: []Any{
				anyQuery(f, key, outScripts[:min(1, len(outScripts))], "absent-"+nb.name, 0, 3),
				anyQuery(f, key, nil, "absent-"+nb.name, 0, 8),
				anyQuery(f, key, nil, "", 0, 0),
			},
		})
		prevHeader = header
	}

	// Lengths 0 to 32 cross every tail length of SipHash's 8-byte blocks.
	for i := 0; i <= 11; i++ {
		key := key16(fmt.Sprintf("siphash-%d", i))
		sum := sha256.Sum256(item("siphash-data", i))
		data := sum[:min(i*3, 32)]
		vectors.SipHash = append(vectors.SipHash, SipVector{
			Key:  hex.EncodeToString(key[:]),
			Data: hex.EncodeToString(data),
			Hash: fmt.Sprintf("%016x", siphash.Sum64(data, &key)),
		})
	}

	synth := func(name string, p uint8, m uint64, tag string, count int, note string) (*gcs.Filter, [gcs.KeySize]byte, *Synthetic) {
		key := key16("key-" + name)
		f, err := gcs.BuildGCSFilter(p, m, key, items(tag, 0, count))
		check(err)
		s := &Synthetic{
			Name: name, Params: Params{P: p, M: m}, Key: hex.EncodeToString(key[:]),
			Tag: tag, Count: count, Filter: hex.EncodeToString(nbytes(f)), Note: note,
		}
		return f, key, s
	}

	{
		f, key, s := synth("empty", builder.DefaultP, builder.DefaultM, "empty", 0, "")
		s.Matches = matches(f, key, items("probe", 0, 4))
		s.Any = []Any{anyQuery(f, key, nil, "probe", 0, 4)}
		vectors.Synthetic = append(vectors.Synthetic, *s)
	}
	{
		f, key, s := synth("single", builder.DefaultP, builder.DefaultM, "single", 1, "")
		s.Matches = matches(f, key, append(items("single", 0, 1), items("probe", 0, 4)...))
		s.Any = []Any{anyQuery(f, key, nil, "single", 0, 1), anyQuery(f, key, nil, "probe", 0, 4)}
		vectors.Synthetic = append(vectors.Synthetic, *s)
	}
	{
		// P=2, M=4: so few values that most non-members match.
		f, key, s := synth("coarse", 2, 4, "coarse", 50, "most non-members match at P=2, M=4")
		s.Matches = matches(f, key, append(items("coarse", 0, 10), items("probe", 0, 60)...))
		s.Any = []Any{
			anyQuery(f, key, nil, "probe", 0, 3),
			anyQuery(f, key, nil, "probe", 100, 30),
		}
		vectors.Synthetic = append(vectors.Synthetic, *s)
	}
	{
		f, key, s := synth("p10", 10, 1<<10, "p10", 300, "")
		s.Matches = matches(f, key, append(items("p10", 0, 20), items("probe", 0, 200)...))
		s.Any = []Any{anyQuery(f, key, nil, "probe", 0, 100), anyQuery(f, key, nil, "probe", 0, 200)}
		vectors.Synthetic = append(vectors.Synthetic, *s)
	}
	{
		// At the default parameters a non-member matches with probability
		// 1/M. Find one, so the false positive is pinned exactly.
		f, key, s := synth("default-fp", builder.DefaultP, builder.DefaultM, "member", 2000, "item(fp, i) is a false positive found by search")
		i, fp := search("fp", 0, 900, func(q [][]byte) bool {
			ok, err := f.ZipMatchAny(key, q)
			check(err)
			return ok
		})
		s.Matches = matches(f, key, append(append(items("member", 0, 5), fp), items("fp", i+1, 20)...))
		s.Any = []Any{anyQuery(f, key, [][]byte{fp}, "fp", i+1, 20)}
		vectors.Synthetic = append(vectors.Synthetic, *s)
	}
	{
		// With N*M at or above 2^32, HashMatchAny compares only the low 32
		// bits of each value, so it matches items Match and ZipMatchAny do
		// not. MatchAny takes that path once there are N/2 queries.
		f, key, s := synth("wide", builder.DefaultP, builder.DefaultM, "wide", 6000, "item(trunc, i) matches only through HashMatchAny")
		var i int
		var trunc []byte
		for start := 0; ; start = i + 1 {
			i, trunc = search("trunc", start, 20000, func(q [][]byte) bool {
				ok, err := f.HashMatchAny(key, q)
				check(err)
				return ok
			})
			// A hit may also be an ordinary false positive; skip those.
			zip, err := f.ZipMatchAny(key, [][]byte{trunc})
			check(err)
			if !zip {
				break
			}
		}
		s.Matches = matches(f, key, append(append(items("wide", 0, 5), trunc), items("trunc", i+1, 5)...))
		s.Any = []Any{
			anyQuery(f, key, [][]byte{trunc}, "trunc", i+1, 2998),
			anyQuery(f, key, [][]byte{trunc}, "trunc", i+1, 2999),
			anyQuery(f, key, nil, "wide", 10, 3),
		}
		vectors.Synthetic = append(vectors.Synthetic, *s)
	}

	data, err := json.MarshalIndent(vectors, "", "  ")
	check(err)
	check(os.WriteFile(*out, append(data, '\n'), 0o644))
}

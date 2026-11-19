// Difficulty vectors for pearljs's nextBlockBits. The file joins package
// blockchain through a build overlay, so it can call the unexported
// calcNextRequiredDifficulty with headers of its own. From a Pearl source
// checkout (master or fp8-scheme; difficulty.go is the same on both):
//
//	echo '{"Replace":{"/path/to/pearl/node/blockchain/pearljs_difficulty_test.go":"/path/to/pearljs/vectors/difficulty_test.go"}}' > /tmp/overlay.json
//	PEARLJS_DIFFICULTY_VECTORS=/path/to/pearljs/vectors/difficulty.json \
//	  go -C /path/to/pearl/node test -overlay /tmp/overlay.json -run TestPearljsDifficultyVectors -count=1 ./blockchain
package blockchain

import (
	"encoding/json"
	"math/big"
	"os"
	"testing"
	"time"

	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
)

type pearljsHeader struct {
	bits   uint32
	time   int64
	parent *pearljsHeader
}

func (h *pearljsHeader) Hash() chainhash.Hash { return chainhash.Hash{} }
func (h *pearljsHeader) Height() int32        { return 1 }
func (h *pearljsHeader) Bits() uint32         { return h.bits }
func (h *pearljsHeader) Timestamp() int64     { return h.time }
func (h *pearljsHeader) Parent() chaincfg.HeaderCtx {
	// A nil *pearljsHeader inside the interface would not compare equal to nil.
	if h.parent == nil {
		return nil
	}
	return h.parent
}
func (h *pearljsHeader) RelativeAncestorCtx(int32) chaincfg.HeaderCtx { return nil }

type pearljsChain struct{ params *chaincfg.Params }

func (c pearljsChain) ChainParams() *chaincfg.Params                     { return c.params }
func (c pearljsChain) VerifyCheckpoint(int32, *chainhash.Hash) bool      { return true }
func (c pearljsChain) FindPreviousCheckpoint() (chaincfg.HeaderCtx, error) { return nil, nil }

type pearljsLast struct {
	Bits            uint32 `json:"bits"`
	Timestamp       int64  `json:"timestamp"`
	ParentTimestamp *int64 `json:"parentTimestamp"`
}

type pearljsDifficultyCase struct {
	Name string       `json:"name"`
	Last *pearljsLast `json:"last"`
	Time int64        `json:"time"`
	Bits uint32       `json:"bits"`
}

type pearljsDifficultyNetwork struct {
	Name                 string                  `json:"name"`
	PowNoRetargeting     bool                    `json:"powNoRetargeting"`
	ReduceMinDifficulty  bool                    `json:"reduceMinDifficulty"`
	MinDiffReductionTime int64                   `json:"minDiffReductionTime"`
	Cases                []pearljsDifficultyCase `json:"cases"`
}

func TestPearljsDifficultyVectors(t *testing.T) {
	out := os.Getenv("PEARLJS_DIFFICULTY_VECTORS")
	if out == "" {
		t.Skip("PEARLJS_DIFFICULTY_VECTORS is not set")
	}
	nets := []*chaincfg.Params{
		&chaincfg.MainNetParams, &chaincfg.TestNetParams, &chaincfg.TestNet2Params,
		&chaincfg.RegressionNetParams, &chaincfg.SimNetParams,
	}
	const start = int64(1_795_000_000)
	var result []pearljsDifficultyNetwork
	for _, params := range nets {
		spacing := int64(params.TargetTimePerBlock / time.Second)
		halfLife := int64(params.WTEMAHalfLife / time.Second)
		reduction := int64(params.MinDiffReductionTime / time.Second)
		limitBits := BigToCompact(params.PowLimit)
		net := pearljsDifficultyNetwork{
			Name:                 params.Name,
			PowNoRetargeting:     params.PoWNoRetargeting,
			ReduceMinDifficulty:  params.ReduceMinDifficulty,
			MinDiffReductionTime: reduction,
		}
		add := func(name string, last *pearljsHeader, newTime int64) {
			var lastCtx chaincfg.HeaderCtx
			var lastJSON *pearljsLast
			if last != nil {
				lastCtx = last
				lastJSON = &pearljsLast{Bits: last.bits, Timestamp: last.time}
				if last.parent != nil {
					parentTime := last.parent.time
					lastJSON.ParentTimestamp = &parentTime
				}
			}
			bits, err := calcNextRequiredDifficulty(lastCtx, time.Unix(newTime, 0), pearljsChain{params})
			if err != nil {
				t.Fatal(err)
			}
			net.Cases = append(net.Cases, pearljsDifficultyCase{Name: name, Last: lastJSON, Time: newTime, Bits: bits})
		}
		spaced := func(bits uint32, gap int64) *pearljsHeader {
			return &pearljsHeader{bits: bits, time: start + gap, parent: &pearljsHeader{bits: bits, time: start}}
		}
		// The bits mainnet carried at 145479, and a target small enough to reach the floor of 1.
		const mainnetBits = uint32(0x17445b25)
		tiny := BigToCompact(big.NewInt(300))

		add("empty chain", nil, start)
		add("first block after genesis", &pearljsHeader{bits: limitBits, time: start}, start+spacing)
		add("first block after genesis at other bits", &pearljsHeader{bits: mainnetBits, time: start}, start+spacing)
		for _, gap := range []int64{spacing, 0, 1, spacing - 1, spacing + 1, 2 * spacing, 600, 3600, -3600, -spacing} {
			add("mainnet bits, last block "+itoa(gap)+" s after its parent", spaced(mainnetBits, gap), start+gap+1)
		}
		add("limit bits after a slow block, held at the limit", spaced(limitBits, 10*spacing), start+10*spacing+1)
		add("target past the limit after a week-long block", spaced(BigToCompact(new(big.Int).Rsh(params.PowLimit, 1)), halfLife+spacing), start+halfLife+spacing+1)
		add("tiny target after a negative gap of a half-life, floored at 1", spaced(tiny, -halfLife), start-halfLife+1)
		add("tiny target, rounding a negative adjustment down", spaced(tiny, spacing-7), start+spacing)
		add("negative compact target", spaced(0x04812345, spacing+5), start+spacing+6)
		if reduction > 0 {
			last := spaced(mainnetBits, spacing)
			add("new block exactly the reduction time after the last", last, last.time+reduction)
			add("new block one second past the reduction time", last, last.time+reduction+1)
		}
		result = append(result, net)
	}
	body, err := json.MarshalIndent(map[string]any{
		"source":   "calcNextRequiredDifficulty (node/blockchain/difficulty.go) with each network's chaincfg.Params, run by vectors/difficulty_test.go",
		"networks": result,
	}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(out, append(body, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func itoa(n int64) string { return big.NewInt(n).String() }

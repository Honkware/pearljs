// Differential vectors for the pearljs script interpreter: thousands of
// spends, each with the verdict of Pearl's own script engine.
//
// Every case is a transaction, an input index and the outputs it spends. The
// generator runs txscript.NewEngine(...).Execute() over it and records the
// engine's ErrorCode name and message, or nothing when the engine accepts.
// It also runs the debug engine and records a digest of the stack and alt
// stack after every step, so the interpreter has to agree on every
// intermediate state and not only on the verdict.
//
// Run with a Pearl source checkout, after building its XMSS library with
// `make -C /path/to/pearl/xmss`:
// go -C /path/to/pearl run -tags xmss /path/to/pearljs/vectors/interpreter/generate.go -out /path/to/pearljs/vectors/interpreter/vectors.json.gz
//
// The output is a pure function of -seed and -random, gzipped when -out ends
// in .gz. sweep.sh runs a larger
// -random under another seed and checks the interpreter against it.
package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strings"

	secp "github.com/decred/dcrd/dcrec/secp256k1/v4"
	dcrschnorr "github.com/decred/dcrd/dcrec/secp256k1/v4/schnorr"
	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcec/schnorr"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/xmss"
)

type Case struct {
	Name string `json:"name"`
	Tx   string `json:"tx"`
	// Index is the input the engine ran.
	Index int `json:"index,omitempty"`
	// Prevouts are "value:script" for every input, in order.
	Prevouts []string `json:"prevouts"`
	// Code is the engine's ErrorCode name, empty when it accepted. Errors
	// the engine passes through from the signature library carry that
	// library's error kind.
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
	// Trace is the first 8 bytes of SHA-256 over the stack and alt stack
	// after every step of the debug engine.
	Trace string `json:"trace"`
}

type File struct {
	Source        string   `json:"source"`
	Seed          int64    `json:"seed"`
	RandomScripts int      `json:"randomScripts"`
	ErrorCodes    []string `json:"errorCodes"`
	Cases         []Case   `json:"cases"`
}

var (
	rng      *rand.Rand
	cases    []Case
	counts   = map[string]int{}
	keys     []*btcec.PrivateKey
	pubs     [][]byte
	outpoint uint32
)

func check(err error) {
	if err != nil {
		panic(err)
	}
}

func verdict(err error) (string, string) {
	if err == nil {
		return "", ""
	}
	var scriptErr txscript.Error
	if errors.As(err, &scriptErr) {
		return scriptErr.ErrorCode.String(), scriptErr.Description
	}
	var keyErr secp.Error
	if errors.As(err, &keyErr) {
		return fmt.Sprint(keyErr.Err), keyErr.Description
	}
	var sigErr dcrschnorr.Error
	if errors.As(err, &sigErr) {
		return fmt.Sprint(sigErr.Err), sigErr.Description
	}
	return "unclassified", err.Error()
}

type result struct {
	code, message, trace string
	stack                [][]byte
}

// execute is the oracle: the plain engine for the verdict, the debug engine
// for the trace. The two must agree.
func execute(tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut) result {
	fetcher := txscript.NewMultiPrevOutFetcher(nil)
	for i, in := range tx.TxIn {
		fetcher.AddPrevOut(in.PreviousOutPoint, prevOuts[i])
	}
	hashes := txscript.NewTxSigHashes(tx, fetcher)
	run := func(callback func(*txscript.StepInfo) error) (err error) {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("panic: %v", r)
			}
		}()
		var vm *txscript.Engine
		if callback == nil {
			vm, err = txscript.NewEngine(prevOuts[idx].PkScript, tx, idx, txscript.StandardVerifyFlags,
				nil, hashes, prevOuts[idx].Value, fetcher)
		} else {
			vm, err = txscript.NewDebugEngine(prevOuts[idx].PkScript, tx, idx, txscript.StandardVerifyFlags,
				nil, hashes, prevOuts[idx].Value, fetcher, callback)
		}
		if err != nil {
			return err
		}
		return vm.Execute()
	}
	var res result
	res.code, res.message = verdict(run(nil))

	digest := sha256.New()
	writeStack := func(stack [][]byte) {
		var n [4]byte
		binary.LittleEndian.PutUint32(n[:], uint32(len(stack)))
		digest.Write(n[:])
		for _, item := range stack {
			binary.LittleEndian.PutUint32(n[:], uint32(len(item)))
			digest.Write(n[:])
			digest.Write(item)
		}
	}
	first := true
	code, message := verdict(run(func(info *txscript.StepInfo) error {
		// The first call is the state before any step: two empty stacks.
		if first {
			first = false
			return nil
		}
		writeStack(info.Stack)
		writeStack(info.AltStack)
		res.stack = info.Stack
		return nil
	}))
	if code != res.code || message != res.message {
		panic(fmt.Sprintf("debug engine disagrees: %s %q vs %s %q", code, message, res.code, res.message))
	}
	res.trace = hex.EncodeToString(digest.Sum(nil)[:8])
	return res
}

func add(name string, tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut) result {
	res := execute(tx, idx, prevOuts)
	var buf bytes.Buffer
	check(tx.Serialize(&buf))
	prev := make([]string, len(prevOuts))
	for i, out := range prevOuts {
		prev[i] = fmt.Sprintf("%d:%x", out.Value, out.PkScript)
	}
	cases = append(cases, Case{
		Name: name, Tx: hex.EncodeToString(buf.Bytes()), Index: idx, Prevouts: prev,
		Code: res.code, Message: res.message, Trace: res.trace,
	})
	counts[strings.SplitN(name, "/", 2)[0]]++
	return res
}

func mustPass(name string, tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut) {
	if res := add(name, tx, idx, prevOuts); res.code != "" {
		panic(fmt.Sprintf("%s: expected the engine to accept, got %s %q", name, res.code, res.message))
	}
}

func mustFail(name string, tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut, code string) {
	if res := add(name, tx, idx, prevOuts); res.code != code {
		panic(fmt.Sprintf("%s: expected %s, got %q %q", name, code, res.code, res.message))
	}
}

// Script assembly, byte by byte: the builder in txscript refuses what these
// cases need.

func push(data []byte) []byte {
	n := len(data)
	switch {
	case n == 0:
		return []byte{txscript.OP_0}
	case n == 1 && data[0] >= 1 && data[0] <= 16:
		return []byte{txscript.OP_1 + data[0] - 1}
	case n == 1 && data[0] == 0x81:
		return []byte{txscript.OP_1NEGATE}
	case n <= 75:
		return append([]byte{byte(n)}, data...)
	case n <= 255:
		return append([]byte{txscript.OP_PUSHDATA1, byte(n)}, data...)
	default:
		return append([]byte{txscript.OP_PUSHDATA2, byte(n), byte(n >> 8)}, data...)
	}
}

func num(v int64) []byte {
	if v == 0 {
		return nil
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var out []byte
	for v > 0 {
		out = append(out, byte(v))
		v >>= 8
	}
	if out[len(out)-1]&0x80 != 0 {
		if neg {
			out = append(out, 0x80)
		} else {
			out = append(out, 0)
		}
	} else if neg {
		out[len(out)-1] |= 0x80
	}
	return out
}

func cat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func ops(codes ...byte) []byte { return codes }

func repeat(part []byte, n int) []byte { return bytes.Repeat(part, n) }

func filled(n int, b byte) []byte { return bytes.Repeat([]byte{b}, n) }

func randBytes(n int) []byte {
	out := make([]byte, n)
	rng.Read(out)
	return out
}

func clone(b []byte) []byte { return append([]byte{}, b...) }

// Spends.

type spend struct {
	tx       *wire.MsgTx
	prevOuts []*wire.TxOut
	idx      int
	script   []byte
	control  []byte
	annex    []byte
}

type opts struct {
	p2tr     bool
	version  int32
	lockTime uint32
	sequence uint32
	annex    []byte
	siblings int
	leafPos  int
	value    int64
	outputs  int
}

func defaults() opts {
	return opts{version: 2, sequence: 0xfffffffd, value: 100000, outputs: 1}
}

func nextOutPoint() *wire.OutPoint {
	outpoint++
	var hash chainhash.Hash
	binary.LittleEndian.PutUint32(hash[:], outpoint)
	hash[31] = 0x70
	return wire.NewOutPoint(&hash, outpoint%3)
}

func newTx(o opts) *wire.MsgTx {
	tx := wire.NewMsgTx(o.version)
	tx.LockTime = o.lockTime
	for i := 0; i < o.outputs; i++ {
		tx.AddTxOut(wire.NewTxOut(int64(1000+i), []byte{txscript.OP_1}))
	}
	return tx
}

func addInput(tx *wire.MsgTx, sequence uint32) int {
	in := wire.NewTxIn(nextOutPoint(), nil, nil)
	in.Sequence = sequence
	tx.AddTxIn(in)
	return len(tx.TxIn) - 1
}

// leafOutput commits script as one leaf of a tree and returns the output
// script and the control block that opens it.
func leafOutput(script []byte, p2tr bool, siblings, leafPos int) ([]byte, []byte) {
	leaves := make([]txscript.TapLeaf, 0, siblings+1)
	for i := 0; i <= siblings; i++ {
		if i == leafPos {
			leaves = append(leaves, txscript.NewBaseTapLeaf(script))
		} else {
			leaves = append(leaves, txscript.NewBaseTapLeaf(cat(push(filled(8, byte(i))), ops(txscript.OP_DROP, txscript.OP_1))))
		}
	}
	tree := txscript.AssembleTaprootScriptTree(leaves...)
	root := tree.RootNode.TapHash()
	proof := tree.LeafMerkleProofs[leafPos]
	if p2tr {
		internal := keys[0].PubKey()
		block := proof.ToControlBlock(internal)
		control, err := block.ToBytes()
		check(err)
		outputKey := txscript.ComputeTaprootOutputKey(internal, root[:])
		return cat(ops(txscript.OP_1, 32), schnorr.SerializePubKey(outputKey)), control
	}
	return cat(ops(txscript.OP_2, 32), root[:]), cat([]byte{byte(txscript.BaseLeafVersion) | 1}, proof.InclusionProof)
}

func newLeafSpend(script []byte, o opts) *spend {
	tx := newTx(o)
	idx := addInput(tx, o.sequence)
	pkScript, control := leafOutput(script, o.p2tr, o.siblings, o.leafPos)
	s := &spend{
		tx: tx, idx: idx, script: script, control: control, annex: o.annex,
		prevOuts: []*wire.TxOut{wire.NewTxOut(o.value, pkScript)},
	}
	s.setStack()
	return s
}

func (s *spend) setStack(items ...[]byte) {
	witness := wire.TxWitness{}
	witness = append(witness, items...)
	witness = append(witness, s.script, s.control)
	if s.annex != nil {
		witness = append(witness, s.annex)
	}
	s.tx.TxIn[s.idx].SetWitness(witness)
}

const noCodeSep = 0xffffffff

// maxGrain is the largest value an output can hold, btcutil.MaxGrain.
const maxGrain = 2100000000000000000

// sigMsg assembles Pearl's Taproot signature message from the midstate of
// txscript.NewTxSigHashes. leafHash is nil for a key path. The engine is the
// judge of whether this is right: every spend meant to be valid goes through
// mustPass.
func sigMsg(tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut, hashType byte, annex, leafHash []byte, codeSep uint32) []byte {
	fetcher := txscript.NewMultiPrevOutFetcher(nil)
	for i, in := range tx.TxIn {
		fetcher.AddPrevOut(in.PreviousOutPoint, prevOuts[i])
	}
	hashes := txscript.NewTxSigHashes(tx, fetcher)
	var b bytes.Buffer
	b.WriteByte(0)
	b.WriteByte(hashType)
	check(binary.Write(&b, binary.LittleEndian, tx.Version))
	check(binary.Write(&b, binary.LittleEndian, tx.LockTime))
	in := tx.TxIn[idx]
	if hashType&0x80 == 0 {
		b.Write(hashes.HashPrevOutsV1[:])
		b.Write(hashes.HashInputAmountsV1[:])
		b.Write(hashes.HashInputScriptsV1[:])
		b.Write(hashes.HashSequenceV1[:])
	}
	if hashType&3 != 2 && hashType&3 != 3 {
		b.Write(hashes.HashOutputsV1[:])
	}
	spendType := byte(0)
	if leafHash != nil {
		spendType = 2
	}
	if annex != nil {
		spendType++
	}
	b.WriteByte(spendType)
	if hashType&0x80 != 0 {
		check(wire.WriteOutPoint(&b, 0, 0, &in.PreviousOutPoint))
		check(wire.WriteTxOut(&b, 0, 0, prevOuts[idx]))
		check(binary.Write(&b, binary.LittleEndian, in.Sequence))
	} else {
		check(binary.Write(&b, binary.LittleEndian, uint32(idx)))
	}
	if annex != nil {
		var ab bytes.Buffer
		check(wire.WriteVarBytes(&ab, 0, annex))
		sum := sha256.Sum256(ab.Bytes())
		b.Write(sum[:])
	}
	if hashType&3 == 3 && idx < len(tx.TxOut) {
		var ob bytes.Buffer
		check(wire.WriteTxOut(&ob, 0, 0, tx.TxOut[idx]))
		sum := sha256.Sum256(ob.Bytes())
		b.Write(sum[:])
	}
	if leafHash != nil {
		b.Write(leafHash)
		b.WriteByte(0)
		check(binary.Write(&b, binary.LittleEndian, codeSep))
	}
	return chainhash.TaggedHash(chainhash.TagTapSighash, b.Bytes())[:]
}

func schnorrSign(key *btcec.PrivateKey, msg []byte, hashType byte) []byte {
	sig, err := schnorr.Sign(key, msg)
	check(err)
	if hashType == 0 {
		return sig.Serialize()
	}
	return append(sig.Serialize(), hashType)
}

func (s *spend) msg(hashType byte, codeSep uint32) []byte {
	leafHash := txscript.NewBaseTapLeaf(s.script).TapHash()
	return sigMsg(s.tx, s.idx, s.prevOuts, hashType, s.annex, leafHash[:], codeSep)
}

func (s *spend) sign(key int, hashType byte, codeSep uint32) []byte {
	return schnorrSign(keys[key], s.msg(hashType, codeSep), hashType)
}

func keyPathOutput(key int) []byte {
	return cat(ops(txscript.OP_1, 32), schnorr.SerializePubKey(txscript.ComputeTaprootKeyNoScript(keys[key].PubKey())))
}

func keyPathSign(tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut, key int, hashType byte, annex []byte) []byte {
	tweaked := txscript.TweakTaprootPrivKey(*keys[key], []byte{})
	return schnorrSign(tweaked, sigMsg(tx, idx, prevOuts, hashType, annex, nil, 0), hashType)
}

func checksigLeaf(key int) []byte {
	return cat(push(pubs[key]), ops(txscript.OP_CHECKSIG))
}

// XMSS.

type xmssKey struct {
	pk [xmss.PKLen]byte
	sk [xmss.SKLen]byte
}

var xmssKeys []*xmssKey

func xmssSign(key *xmssKey, uid uint32, msg []byte) [][]byte {
	var m [xmss.MsgLen]byte
	copy(m[:], msg)
	sig, err := xmss.Sign(uid, key.sk, m)
	check(err)
	chunk := xmss.SignatureLen / 5
	out := make([][]byte, 5)
	for i := range out {
		out[i] = clone(sig[i*chunk : (i+1)*chunk])
	}
	return out
}

func xmssLeaf(key *xmssKey) []byte {
	return cat(push(key.pk[:]), ops(txscript.OP_CHECKXMSSSIG))
}

var hashTypes = []byte{0x00, 0x01, 0x02, 0x03, 0x81, 0x82, 0x83}

var annexA = []byte{0x50, 0xaa, 0xbb}

// A base is a spend the engine accepts, rebuilt from scratch on each call so
// a mutation never leaks into the next.
type base struct {
	name  string
	heavy bool
	make  func() (*wire.MsgTx, int, []*wire.TxOut)
}

var bases []base

func validSpends() {
	// Key path: every sighash type, with and without an annex, on the
	// second of two inputs so SIGHASH_SINGLE has an output to pair with.
	for _, hashType := range hashTypes {
		for _, annex := range [][]byte{nil, annexA} {
			hashType, annex := hashType, annex
			mk := func() (*wire.MsgTx, int, []*wire.TxOut) {
				o := defaults()
				o.outputs = 2
				tx := newTx(o)
				addInput(tx, 0xfffffffd)
				addInput(tx, 5)
				prevOuts := []*wire.TxOut{wire.NewTxOut(7000, keyPathOutput(1)), wire.NewTxOut(9000, keyPathOutput(2))}
				for i, key := range []int{1, 2} {
					witness := wire.TxWitness{keyPathSign(tx, i, prevOuts, key, hashType, annex)}
					if annex != nil {
						witness = append(witness, annex)
					}
					tx.TxIn[i].SetWitness(witness)
				}
				return tx, 1, prevOuts
			}
			name := fmt.Sprintf("valid/keypath/sighash=%02x/annex=%t", hashType, annex != nil)
			tx, idx, prevOuts := mk()
			mustPass(name, tx, idx, prevOuts)
			mustPass(name+"/input0", tx, 0, prevOuts)
			if (hashType == 0x00 && annex == nil) || (hashType == 0x83 && annex != nil) {
				bases = append(bases, base{name: fmt.Sprintf("keypath-%02x-annex=%t", hashType, annex != nil), make: mk})
			}
		}
	}

	// Script path: P2TR and P2MR, trees of several shapes, every sighash type.
	for _, p2tr := range []bool{true, false} {
		for _, shape := range [][2]int{{0, 0}, {1, 0}, {1, 1}, {2, 2}, {4, 1}, {4, 4}, {7, 3}} {
			for _, hashType := range hashTypes {
				for _, annex := range [][]byte{nil, annexA} {
					if (shape[0] > 1 || annex != nil) && hashType != 0x00 && hashType != 0x82 {
						continue
					}
					p2tr, shape, hashType, annex := p2tr, shape, hashType, annex
					mk := func() (*wire.MsgTx, int, []*wire.TxOut) {
						o := defaults()
						o.p2tr, o.siblings, o.leafPos, o.annex = p2tr, shape[0], shape[1], annex
						s := newLeafSpend(checksigLeaf(3), o)
						s.setStack(s.sign(3, hashType, noCodeSep))
						return s.tx, s.idx, s.prevOuts
					}
					kind := map[bool]string{true: "p2tr", false: "p2mr"}[p2tr]
					name := fmt.Sprintf("valid/%s/leaves=%d/leaf=%d/sighash=%02x/annex=%t", kind, shape[0]+1, shape[1], hashType, annex != nil)
					tx, idx, prevOuts := mk()
					mustPass(name, tx, idx, prevOuts)
					single, deep := shape == [2]int{0, 0}, shape == [2]int{4, 1}
					if (single && annex == nil && hashType == 0x00) || (deep && !p2tr && annex != nil && hashType == 0x00) {
						bases = append(bases, base{name: fmt.Sprintf("%s-leaves=%d-%02x-annex=%t", kind, shape[0]+1, hashType, annex != nil), make: mk})
					}
				}
			}
		}
	}

	// multi_a: k-of-n with OP_CHECKSIGADD, empty signatures for the keys that
	// do not sign.
	for _, item := range []struct {
		n, k    int
		signers []int
		p2tr    bool
	}{
		{3, 2, []int{0, 2}, false}, {3, 2, []int{0, 1}, true}, {3, 3, []int{0, 1, 2}, false},
		{1, 1, []int{0}, false}, {5, 1, []int{4}, true}, {18, 17, []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17}, false},
		{3, 2, []int{0, 1, 2}, false}, {3, 2, []int{1}, false}, {3, 0, nil, false},
	} {
		item := item
		mk := func() (*wire.MsgTx, int, []*wire.TxOut) {
			script := cat(push(pubs[4]), ops(txscript.OP_CHECKSIG))
			for i := 1; i < item.n; i++ {
				script = cat(script, push(pubs[4+i]), ops(txscript.OP_CHECKSIGADD))
			}
			script = cat(script, push(num(int64(item.k))), ops(txscript.OP_NUMEQUAL))
			o := defaults()
			o.p2tr = item.p2tr
			s := newLeafSpend(script, o)
			signs := map[int]bool{}
			for _, signer := range item.signers {
				signs[signer] = true
			}
			var stack [][]byte
			for i := item.n - 1; i >= 0; i-- {
				if signs[i] {
					stack = append(stack, s.sign(4+i, 0, noCodeSep))
				} else {
					stack = append(stack, nil)
				}
			}
			s.setStack(stack...)
			return s.tx, s.idx, s.prevOuts
		}
		name := fmt.Sprintf("valid/multi_a/%d-of-%d/signers=%d/p2tr=%t", item.k, item.n, len(item.signers), item.p2tr)
		tx, idx, prevOuts := mk()
		if len(item.signers) == item.k {
			mustPass(name, tx, idx, prevOuts)
		} else {
			mustFail(name, tx, idx, prevOuts, "ErrEvalFalse")
		}
		if item.n == 3 && item.k == 2 && len(item.signers) == 2 && !item.p2tr {
			bases = append(bases, base{name: fmt.Sprintf("multi_a-p2tr=%t", item.p2tr), make: mk})
		}
	}

	// XMSS leaves.
	for _, item := range []struct {
		key      int
		uid      uint32
		p2tr     bool
		annex    []byte
		siblings int
	}{
		{0, 0, false, nil, 0}, {0, 30, false, nil, 0}, {0, 31, false, nil, 0}, {1, 7, true, nil, 0}, {1, 1, false, annexA, 0}, {0, 16, false, nil, 2},
	} {
		item := item
		mk := func() (*wire.MsgTx, int, []*wire.TxOut) {
			o := defaults()
			o.p2tr, o.annex, o.siblings = item.p2tr, item.annex, item.siblings
			s := newLeafSpend(xmssLeaf(xmssKeys[item.key]), o)
			s.setStack(xmssSign(xmssKeys[item.key], item.uid, s.msg(0, noCodeSep))...)
			return s.tx, s.idx, s.prevOuts
		}
		name := fmt.Sprintf("valid/xmss/key=%d/uid=%d/p2tr=%t/annex=%t/leaves=%d", item.key, item.uid, item.p2tr, item.annex != nil, item.siblings+1)
		tx, idx, prevOuts := mk()
		if item.uid == 31 {
			// xmss.Sign returns a signature for index 31 that xmss.Verify refuses.
			mustFail(name, tx, idx, prevOuts, "ErrNullFail")
		} else {
			mustPass(name, tx, idx, prevOuts)
		}
		if item.uid == 0 {
			bases = append(bases, base{name: fmt.Sprintf("xmss-uid=%d-annex=%t", item.uid, item.annex != nil), heavy: true, make: mk})
		}
	}

	// OP_CODESEPARATOR: each signature commits to the opcode position of the
	// last separator executed before its check.
	{
		mk := func() (*wire.MsgTx, int, []*wire.TxOut) {
			script := cat(
				push(pubs[1]), ops(txscript.OP_CHECKSIGVERIFY, txscript.OP_CODESEPARATOR),
				push(pubs[2]), ops(txscript.OP_CHECKSIGVERIFY),
				ops(txscript.OP_0, txscript.OP_IF, txscript.OP_CODESEPARATOR, txscript.OP_ENDIF, txscript.OP_CODESEPARATOR, txscript.OP_CODESEPARATOR),
				push(pubs[3]), ops(txscript.OP_CHECKSIG),
			)
			o := defaults()
			s := newLeafSpend(script, o)
			s.setStack(s.sign(3, 0x81, 10), s.sign(2, 0, 2), s.sign(1, 0x03, noCodeSep))
			return s.tx, s.idx, s.prevOuts
		}
		tx, idx, prevOuts := mk()
		mustPass("valid/codeseparator/three-signatures", tx, idx, prevOuts)
		bases = append(bases, base{name: "codeseparator", make: mk})

		for _, wrong := range []uint32{noCodeSep, 0, 1, 3, 7, 8, 10} {
			script := cat(ops(txscript.OP_NOP, txscript.OP_CODESEPARATOR), push(pubs[1]), ops(txscript.OP_CHECKSIG))
			s := newLeafSpend(script, defaults())
			s.setStack(s.sign(1, 0, wrong))
			add(fmt.Sprintf("valid/codeseparator/signed-for-position=%d", wrong), s.tx, s.idx, s.prevOuts)
		}
		xscript := cat(ops(txscript.OP_CODESEPARATOR), xmssLeaf(xmssKeys[0]))
		for _, pos := range []uint32{0, noCodeSep} {
			s := newLeafSpend(xscript, defaults())
			s.setStack(xmssSign(xmssKeys[0], 3, s.msg(0, pos))...)
			add(fmt.Sprintf("valid/codeseparator/xmss-signed-for-position=%d", pos), s.tx, s.idx, s.prevOuts)
		}
	}

	// Transactions that mix output types. The signature message commits to
	// the amounts and scripts of all inputs only when the midstate has them,
	// so these pin which transactions that is.
	type inputKind int
	const (
		keyIn inputKind = iota
		p2trLeafIn
		p2mrLeafIn
		nullP2trIn
		xmssIn
	)
	mixes := map[string][]inputKind{
		"p2mr+p2mr":           {p2mrLeafIn, p2mrLeafIn},
		"p2mr+keypath":        {p2mrLeafIn, keyIn},
		"keypath+p2mr":        {keyIn, p2mrLeafIn},
		"p2mr+p2tr-leaf":      {p2mrLeafIn, p2trLeafIn},
		"p2mr+p2mr+p2mr":      {p2mrLeafIn, p2mrLeafIn, p2mrLeafIn},
		"p2mr+null-outpoint":  {p2mrLeafIn, nullP2trIn},
		"null-outpoint+p2mr":  {nullP2trIn, p2mrLeafIn},
		"p2mr+null+keypath":   {p2mrLeafIn, nullP2trIn, keyIn},
		"xmss+p2mr":           {xmssIn, p2mrLeafIn},
		"xmss+keypath":        {xmssIn, keyIn},
		"keypath+keypath":     {keyIn, keyIn},
		"p2tr-leaf+p2tr-leaf": {p2trLeafIn, p2trLeafIn},
	}
	mixNames := []string{
		"p2mr+p2mr", "p2mr+keypath", "keypath+p2mr", "p2mr+p2tr-leaf", "p2mr+p2mr+p2mr", "p2mr+null-outpoint",
		"null-outpoint+p2mr", "p2mr+null+keypath", "xmss+p2mr", "xmss+keypath", "keypath+keypath", "p2tr-leaf+p2tr-leaf",
	}
	for _, mixName := range mixNames {
		for _, hashType := range []byte{0x00, 0x03, 0x81} {
			mixName, hashType := mixName, hashType
			kinds := mixes[mixName]
			mk := func() (*wire.MsgTx, int, []*wire.TxOut) {
				o := defaults()
				o.outputs = len(kinds)
				tx := newTx(o)
				prevOuts := make([]*wire.TxOut, len(kinds))
				scripts := make([][]byte, len(kinds))
				controls := make([][]byte, len(kinds))
				for i, kind := range kinds {
					addInput(tx, uint32(i))
					var pkScript []byte
					switch kind {
					case keyIn:
						pkScript = keyPathOutput(1 + i)
					case nullP2trIn:
						tx.TxIn[i].PreviousOutPoint = *wire.NewOutPoint(&chainhash.Hash{}, 0xffffffff)
						pkScript = keyPathOutput(1 + i)
					case xmssIn:
						scripts[i] = xmssLeaf(xmssKeys[1])
						pkScript, controls[i] = leafOutput(scripts[i], false, 0, 0)
					default:
						scripts[i] = checksigLeaf(1 + i)
						pkScript, controls[i] = leafOutput(scripts[i], kind == p2trLeafIn, 1, i%2)
					}
					prevOuts[i] = wire.NewTxOut(int64(50000+i), pkScript)
				}
				for i, kind := range kinds {
					switch kind {
					case keyIn, nullP2trIn:
						tx.TxIn[i].SetWitness(wire.TxWitness{keyPathSign(tx, i, prevOuts, 1+i, hashType, nil)})
					case xmssIn:
						leafHash := txscript.NewBaseTapLeaf(scripts[i]).TapHash()
						sig := xmssSign(xmssKeys[1], uint32(4+i), sigMsg(tx, i, prevOuts, 0, nil, leafHash[:], noCodeSep))
						tx.TxIn[i].SetWitness(append(sig, scripts[i], controls[i]))
					default:
						leafHash := txscript.NewBaseTapLeaf(scripts[i]).TapHash()
						sig := schnorrSign(keys[1+i], sigMsg(tx, i, prevOuts, hashType, nil, leafHash[:], noCodeSep), hashType)
						tx.TxIn[i].SetWitness(wire.TxWitness{sig, scripts[i], controls[i]})
					}
				}
				return tx, 0, prevOuts
			}
			tx, _, prevOuts := mk()
			for i := range kinds {
				mustPass(fmt.Sprintf("valid/mixed/%s/sighash=%02x/input=%d", mixName, hashType, i), tx, i, prevOuts)
			}
			mutate := map[string]bool{"p2mr+p2mr": true, "p2mr+keypath": true, "keypath+p2mr": true, "p2mr+p2tr-leaf": true,
				"p2mr+null-outpoint": true, "null-outpoint+p2mr": true, "xmss+p2mr": true}[mixName]
			if mutate && (hashType == 0x00 || (hashType == 0x81 && mixName == "p2mr+p2mr")) {
				bases = append(bases, base{name: fmt.Sprintf("mixed-%s-%02x", mixName, hashType), heavy: strings.Contains(mixName, "xmss"), make: mk})
			}
		}
	}
}

// mutations takes every base spend and changes one thing at a time: a
// witness item, a field of the transaction, a spent output.
func mutations() {
	for _, b := range bases {
		emit := func(what string, change func(tx *wire.MsgTx, idx int, prevOuts []*wire.TxOut)) {
			tx, idx, prevOuts := b.make()
			change(tx, idx, prevOuts)
			for i := range tx.TxIn {
				if i != idx && (b.heavy || len(tx.TxIn) > 2) {
					continue
				}
				add(fmt.Sprintf("mutated/%s/%s/input=%d", b.name, what, i), tx, i, prevOuts)
			}
		}
		witnessChange := func(what string, change func(witness wire.TxWitness) wire.TxWitness) {
			tx, idx, prevOuts := b.make()
			var witness wire.TxWitness
			for _, item := range tx.TxIn[idx].DecodeWitness() {
				witness = append(witness, clone(item))
			}
			tx.TxIn[idx].SetWitness(change(witness))
			add(fmt.Sprintf("mutated/%s/witness/%s", b.name, what), tx, idx, prevOuts)
		}
		tx, idx, _ := b.make()
		items := len(tx.TxIn[idx].DecodeWitness())
		for i := 0; i < items; i++ {
			i := i
			size := len(tx.TxIn[idx].DecodeWitness()[i])
			positions := []int{0}
			if !b.heavy && size > 2 {
				positions = []int{0, size - 1}
			}
			for _, pos := range positions {
				for _, bit := range []byte{0x01, 0x80} {
					if size == 0 || (bit == 0x80 && (b.heavy || pos != 0)) {
						continue
					}
					pos, bit := pos, bit
					witnessChange(fmt.Sprintf("item=%d/flip=%d.%02x", i, pos, bit), func(w wire.TxWitness) wire.TxWitness {
						w[i][pos] ^= bit
						return w
					})
				}
			}
			if size > 0 {
				witnessChange(fmt.Sprintf("item=%d/truncate", i), func(w wire.TxWitness) wire.TxWitness {
					w[i] = w[i][:len(w[i])-1]
					return w
				})
			}
			if b.heavy {
				continue
			}
			for _, extra := range []byte{0x00, 0x01} {
				extra := extra
				witnessChange(fmt.Sprintf("item=%d/append=%02x", i, extra), func(w wire.TxWitness) wire.TxWitness {
					w[i] = append(w[i], extra)
					return w
				})
			}
			witnessChange(fmt.Sprintf("item=%d/empty", i), func(w wire.TxWitness) wire.TxWitness {
				w[i] = nil
				return w
			})
			witnessChange(fmt.Sprintf("item=%d/remove", i), func(w wire.TxWitness) wire.TxWitness {
				return append(w[:i:i], w[i+1:]...)
			})
			witnessChange(fmt.Sprintf("item=%d/duplicate", i), func(w wire.TxWitness) wire.TxWitness {
				out := append(wire.TxWitness{}, w[:i+1]...)
				return append(out, w[i:]...)
			})
		}
		witnessChange("append-annex", func(w wire.TxWitness) wire.TxWitness { return append(w, []byte{0x50}) })
		witnessChange("append-item", func(w wire.TxWitness) wire.TxWitness { return append(w, []byte{0x51}) })
		witnessChange("prepend-item", func(w wire.TxWitness) wire.TxWitness { return append(wire.TxWitness{{0x01}}, w...) })
		witnessChange("none", func(w wire.TxWitness) wire.TxWitness { return wire.TxWitness{} })

		emit("tx/version", func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.Version ^= 3 })
		emit("tx/locktime", func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.LockTime++ })
		emit("tx/output-value", func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.TxOut[len(tx.TxOut)-1].Value++ })
		emit("tx/output-0-script", func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.TxOut[0].PkScript = []byte{txscript.OP_2} })
		emit("tx/add-output", func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.AddTxOut(wire.NewTxOut(1, []byte{0x6a})) })
		emit("tx/remove-outputs", func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.TxOut = nil })
		for i := range tx.TxIn {
			i := i
			if b.heavy && i != idx {
				continue
			}
			emit(fmt.Sprintf("tx/sequence-%d", i), func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.TxIn[i].Sequence ^= 1 })
			emit(fmt.Sprintf("tx/outpoint-index-%d", i), func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.TxIn[i].PreviousOutPoint.Index ^= 1 })
			emit(fmt.Sprintf("tx/outpoint-hash-%d", i), func(tx *wire.MsgTx, _ int, _ []*wire.TxOut) { tx.TxIn[i].PreviousOutPoint.Hash[5] ^= 1 })
			emit(fmt.Sprintf("prevout/value-%d", i), func(_ *wire.MsgTx, _ int, prevOuts []*wire.TxOut) { prevOuts[i].Value++ })
			emit(fmt.Sprintf("prevout/value-%d-max", i), func(_ *wire.MsgTx, _ int, prevOuts []*wire.TxOut) { prevOuts[i].Value = maxGrain })
		}
		if len(tx.TxIn) > 1 {
			// Changing what another input spends changes the scripts
			// every signature may commit to, and which inputs are P2TR.
			for i := range tx.TxIn {
				i := i
				if i == idx {
					continue
				}
				emit(fmt.Sprintf("prevout/script-%d-to-p2mr", i), func(_ *wire.MsgTx, _ int, prevOuts []*wire.TxOut) {
					prevOuts[i].PkScript = cat(ops(txscript.OP_2, 32), filled(32, 0x11))
				})
				emit(fmt.Sprintf("prevout/script-%d-to-p2tr", i), func(_ *wire.MsgTx, _ int, prevOuts []*wire.TxOut) {
					prevOuts[i].PkScript = keyPathOutput(9)
				})
			}
		}
	}
}

// run adds a case that executes script as the only leaf of a P2MR output.
func run(name string, script []byte, stack ...[]byte) result {
	s := newLeafSpend(script, defaults())
	s.setStack(stack...)
	return add(name, s.tx, s.idx, s.prevOuts)
}

func runWith(name string, o opts, script []byte, stack ...[]byte) result {
	s := newLeafSpend(script, o)
	s.setStack(stack...)
	return add(name, s.tx, s.idx, s.prevOuts)
}

var opNames = func() map[byte]string {
	names := map[byte]string{}
	for name, op := range txscript.OpcodeByName {
		if name != "OP_FALSE" && name != "OP_TRUE" && name != "OP_NOP2" && name != "OP_NOP3" {
			names[op] = name
		}
	}
	return names
}()

func opName(op byte) string { return opNames[op] }

func withOperand(op byte) []byte {
	switch {
	case op >= 1 && op <= 75:
		return append([]byte{op}, filled(int(op), 0x2a)...)
	case op == txscript.OP_PUSHDATA1:
		return append([]byte{op, 76}, filled(76, 0x2a)...)
	case op == txscript.OP_PUSHDATA2:
		return append([]byte{op, 0x00, 0x01}, filled(256, 0x2a)...)
	case op == txscript.OP_PUSHDATA4:
		return append([]byte{op, 0x00, 0x01, 0x00, 0x00}, filled(256, 0x2a)...)
	}
	return []byte{op}
}

var boundaryNumbers = [][]byte{
	nil, {0x01}, {0x81}, {0x02}, {0x10}, {0x11}, {0x7f}, {0xff}, {0x80, 0x00}, {0x80, 0x80}, {0xff, 0x00},
	{0xff, 0x7f}, {0x00, 0x80, 0x00}, {0xff, 0xff, 0xff, 0x7f}, {0xff, 0xff, 0xff, 0xff}, {0x00, 0x00, 0x00, 0x80, 0x00},
	{0x00, 0x00, 0x00, 0x80, 0x80}, {0x00}, {0x80}, {0x01, 0x00}, {0x00, 0x80}, {0x01, 0x00, 0x00, 0x00, 0x00}, {0xff, 0xff, 0xff, 0xff, 0x7f},
	{0x01, 0x02, 0x03, 0x04, 0x05, 0x06},
}

var pairNumbers = [][]byte{
	nil, {0x01}, {0x81}, {0xff, 0xff, 0xff, 0x7f}, {0xff, 0xff, 0xff, 0xff}, {0x00, 0x00, 0x00, 0x80, 0x00}, {0x05, 0x00},
}

func opcodeCases() {
	one := []byte{0x01}
	// Every opcode on its own, over stacks of every small depth, then in a
	// branch that does not execute, then in one that does.
	for code := 0; code < 256; code++ {
		op := byte(code)
		script := withOperand(op)
		depths := 5
		if op <= txscript.OP_16 || op >= 0xbb && op != txscript.OP_CHECKXMSSSIG {
			depths = 2
		}
		for depth := 0; depth < depths; depth++ {
			stack := make([][]byte, depth)
			for i := range stack {
				stack[i] = one
			}
			run(fmt.Sprintf("opcode/%s/alone/depth=%d", opName(op), depth), script, stack...)
		}
		run(fmt.Sprintf("opcode/%s/then-1", opName(op)), cat(script, ops(txscript.OP_1)))
		run(fmt.Sprintf("opcode/%s/unexecuted", opName(op)), cat(ops(txscript.OP_0, txscript.OP_IF), script, ops(txscript.OP_ENDIF, txscript.OP_1)))
		run(fmt.Sprintf("opcode/%s/unexecuted-else", opName(op)), cat(ops(txscript.OP_1, txscript.OP_IF, txscript.OP_1, txscript.OP_ELSE), script, ops(txscript.OP_ENDIF)))
		run(fmt.Sprintf("opcode/%s/executed-branch", opName(op)), cat(ops(txscript.OP_1, txscript.OP_IF), script, ops(txscript.OP_ENDIF)), one, one, one)
	}

	// Numeric opcodes at the edges of the 4-byte range and with encodings
	// that are not minimal.
	unary := []byte{
		txscript.OP_1ADD, txscript.OP_1SUB, txscript.OP_NEGATE, txscript.OP_ABS, txscript.OP_NOT, txscript.OP_0NOTEQUAL,
		txscript.OP_IF, txscript.OP_NOTIF, txscript.OP_VERIFY, txscript.OP_IFDUP, txscript.OP_SIZE, txscript.OP_PICK, txscript.OP_ROLL,
		txscript.OP_CHECKLOCKTIMEVERIFY, txscript.OP_CHECKSEQUENCEVERIFY, txscript.OP_DUP, txscript.OP_SHA256,
	}
	for _, op := range unary {
		for _, n := range boundaryNumbers {
			script := []byte{op}
			if op == txscript.OP_IF || op == txscript.OP_NOTIF {
				script = ops(op, txscript.OP_2, txscript.OP_ELSE, txscript.OP_3, txscript.OP_ENDIF)
			}
			run(fmt.Sprintf("number/%s/%x", opName(op), n), script, one, one, n)
		}
	}
	binary := []byte{
		txscript.OP_ADD, txscript.OP_SUB, txscript.OP_BOOLAND, txscript.OP_BOOLOR, txscript.OP_NUMEQUAL, txscript.OP_NUMEQUALVERIFY,
		txscript.OP_NUMNOTEQUAL, txscript.OP_LESSTHAN, txscript.OP_GREATERTHAN, txscript.OP_LESSTHANOREQUAL,
		txscript.OP_GREATERTHANOREQUAL, txscript.OP_MIN, txscript.OP_MAX, txscript.OP_EQUAL, txscript.OP_EQUALVERIFY,
	}
	for _, op := range binary {
		for _, a := range pairNumbers {
			for _, b := range pairNumbers {
				run(fmt.Sprintf("number/%s/%x,%x", opName(op), a, b), []byte{op}, one, a, b)
			}
		}
	}
	within := [][]byte{nil, {0x01}, {0x81}, {0x02}, {0x00}}
	for _, x := range within {
		for _, lo := range within {
			for _, hi := range within {
				run(fmt.Sprintf("number/OP_WITHIN/%x,%x,%x", x, lo, hi), ops(txscript.OP_WITHIN), x, lo, hi)
			}
		}
	}

	// Stack opcodes over distinct items; the trace pins the resulting order.
	stackOps := []byte{
		txscript.OP_TOALTSTACK, txscript.OP_FROMALTSTACK, txscript.OP_2DROP, txscript.OP_2DUP, txscript.OP_3DUP, txscript.OP_2OVER,
		txscript.OP_2ROT, txscript.OP_2SWAP, txscript.OP_IFDUP, txscript.OP_DEPTH, txscript.OP_DROP, txscript.OP_DUP, txscript.OP_NIP,
		txscript.OP_OVER, txscript.OP_ROT, txscript.OP_SWAP, txscript.OP_TUCK, txscript.OP_SIZE,
	}
	for depth := 0; depth <= 7; depth++ {
		stack := make([][]byte, depth)
		for i := range stack {
			stack[i] = filled(i%3+1, byte(0xa0+i))
		}
		for _, op := range stackOps {
			run(fmt.Sprintf("stack/%s/depth=%d", opName(op), depth), []byte{op}, stack...)
			run(fmt.Sprintf("stack/%s/twice/depth=%d", opName(op), depth), []byte{op, op}, stack...)
		}
		run(fmt.Sprintf("stack/altstack-round-trip/depth=%d", depth),
			ops(txscript.OP_TOALTSTACK, txscript.OP_TOALTSTACK, txscript.OP_FROMALTSTACK, txscript.OP_DUP, txscript.OP_FROMALTSTACK), stack...)
		for n := int64(-2); n <= int64(depth)+1; n++ {
			for _, op := range []byte{txscript.OP_PICK, txscript.OP_ROLL} {
				run(fmt.Sprintf("stack/%s/depth=%d/n=%d", opName(op), depth, n), cat(push(num(n)), []byte{op}), stack...)
			}
		}
	}
	run("stack/altstack-does-not-reach-the-end", ops(txscript.OP_1, txscript.OP_TOALTSTACK, txscript.OP_1))
	run("stack/altstack-empty", ops(txscript.OP_1, txscript.OP_FROMALTSTACK))

	// Pushes: every direct push, minimal encoding, sizes around the limits,
	// and every way a push can run past the end of the script.
	for n := 1; n <= 75; n++ {
		run(fmt.Sprintf("push/direct/%d", n), cat([]byte{byte(n)}, filled(n, 0x33)))
	}
	for _, b := range []byte{0x00, 0x01, 0x02, 0x10, 0x11, 0x7f, 0x80, 0x81, 0xff} {
		run(fmt.Sprintf("push/one-byte/%02x", b), []byte{0x01, b})
		run(fmt.Sprintf("push/one-byte/%02x/unexecuted", b), cat(ops(txscript.OP_0, txscript.OP_IF, 0x01, b), ops(txscript.OP_ENDIF, txscript.OP_1)))
		run(fmt.Sprintf("push/pushdata1-one-byte/%02x", b), []byte{txscript.OP_PUSHDATA1, 0x01, b})
	}
	for _, n := range []int{0, 1, 2, 75, 76, 255} {
		run(fmt.Sprintf("push/pushdata1/%d", n), cat([]byte{txscript.OP_PUSHDATA1, byte(n)}, filled(n, 0x44)))
	}
	for _, n := range []int{0, 1, 75, 76, 255, 256, 519, 520, 521, 600} {
		data := cat([]byte{byte(n), byte(n >> 8)}, filled(n, 0x55))
		run(fmt.Sprintf("push/pushdata2/%d", n), cat([]byte{txscript.OP_PUSHDATA2}, data))
		run(fmt.Sprintf("push/pushdata2/%d/unexecuted", n), cat(ops(txscript.OP_0, txscript.OP_IF, txscript.OP_PUSHDATA2), data, ops(txscript.OP_ENDIF, txscript.OP_1)))
		run(fmt.Sprintf("push/pushdata4/%d", n), cat([]byte{txscript.OP_PUSHDATA4, byte(n), byte(n >> 8), 0, 0}, filled(n, 0x55)))
	}
	for _, length := range [][]byte{{0xff, 0xff, 0xff, 0x7f}, {0x00, 0x00, 0x00, 0x80}, {0xff, 0xff, 0xff, 0xff}, {0x01, 0x00, 0x00, 0x80}} {
		run(fmt.Sprintf("push/pushdata4-length/%x", length), cat([]byte{txscript.OP_PUSHDATA4}, length, filled(3, 0x66)))
	}
	for _, truncated := range [][]byte{
		{0x01}, {0x02, 0x00}, {0x4b}, cat([]byte{0x4b}, filled(74, 1)), {txscript.OP_PUSHDATA1}, {txscript.OP_PUSHDATA1, 0x01},
		{txscript.OP_PUSHDATA1, 0xff, 0x00}, {txscript.OP_PUSHDATA2}, {txscript.OP_PUSHDATA2, 0x01}, {txscript.OP_PUSHDATA2, 0x01, 0x00},
		{txscript.OP_PUSHDATA2, 0xff, 0xff, 0x00}, {txscript.OP_PUSHDATA4}, {txscript.OP_PUSHDATA4, 0x01, 0x00, 0x00},
		{txscript.OP_PUSHDATA4, 0x01, 0x00, 0x00, 0x00}, {txscript.OP_PUSHDATA4, 0x02, 0x00, 0x00, 0x00, 0x00},
	} {
		run(fmt.Sprintf("push/truncated/%x", truncated), truncated)
		run(fmt.Sprintf("push/truncated-after-success/%x", truncated), cat(ops(txscript.OP_1, txscript.OP_RETURN), truncated))
		run(fmt.Sprintf("push/truncated-unexecuted/%x", truncated), cat(ops(txscript.OP_0, txscript.OP_IF), truncated))
	}

	// OP_CAT sizes and its charge against the signature operation budget.
	for _, sizes := range [][2]int{{0, 0}, {0, 1}, {1, 0}, {1, 1}, {63, 1}, {64, 0}, {64, 1}, {260, 260}, {260, 261}, {261, 260}, {520, 0}, {0, 520}, {520, 1}, {1, 520}, {520, 520}} {
		run(fmt.Sprintf("cat/%d+%d", sizes[0], sizes[1]), ops(txscript.OP_CAT, txscript.OP_SIZE, txscript.OP_SWAP, txscript.OP_DROP),
			filled(sizes[0], 0x61), filled(sizes[1], 0x62))
	}
	run("cat/order", ops(txscript.OP_CAT), []byte{1, 2}, []byte{3})
	run("cat/one-item", ops(txscript.OP_CAT), one)
	run("cat/no-items", ops(txscript.OP_CAT))
	for rounds := 1; rounds <= 9; rounds++ {
		// Each round appends 64 bytes, up to the element size limit.
		script := repeat(ops(txscript.OP_DUP, txscript.OP_ROT, txscript.OP_SWAP, txscript.OP_CAT, txscript.OP_SWAP), rounds)
		run(fmt.Sprintf("cat/grow/rounds=%d", rounds), cat(script, ops(txscript.OP_DROP)), nil, filled(64, 0x63))
	}
	for _, rounds := range []int{60, 80, 90, 94, 95, 96, 97, 98, 99, 100, 101, 102, 110, 130} {
		// Each round builds 520 bytes and costs 9 against a budget that
		// gains 3 from the bytes of the round itself.
		script := cat(repeat(ops(txscript.OP_2DUP, txscript.OP_CAT, txscript.OP_DROP), rounds), ops(txscript.OP_2DROP, txscript.OP_1))
		run(fmt.Sprintf("cat/budget/rounds=%d", rounds), script, filled(260, 0x61), filled(260, 0x62))
		o := defaults()
		o.annex = cat([]byte{0x50}, filled(20, 0))
		runWith(fmt.Sprintf("cat/budget/rounds=%d/annex", rounds), o, script, filled(260, 0x61), filled(260, 0x62))
	}

	// Hash opcodes: the trace pins each digest.
	for _, op := range []byte{txscript.OP_RIPEMD160, txscript.OP_SHA1, txscript.OP_SHA256, txscript.OP_HASH160, txscript.OP_HASH256} {
		for _, n := range []int{0, 1, 55, 56, 64, 65, 520} {
			run(fmt.Sprintf("hash/%s/%d", opName(op), n), []byte{op}, filled(n, byte(n)))
		}
	}

	// Conditionals: every sequence of up to three of these, then a sample of
	// longer ones.
	alphabet := []byte{txscript.OP_0, txscript.OP_1, txscript.OP_IF, txscript.OP_NOTIF, txscript.OP_ELSE, txscript.OP_ENDIF}
	names := []string{"0", "1", "IF", "NOTIF", "ELSE", "ENDIF"}
	var walk func(script []byte, name string, left int)
	walk = func(script []byte, name string, left int) {
		if len(script) > 0 {
			run("conditional/"+name, script)
		}
		if left == 0 {
			return
		}
		for i, op := range alphabet {
			walk(append(clone(script), op), strings.TrimPrefix(name+" "+names[i], " "), left-1)
		}
	}
	walk(nil, "", 3)
	for i := 0; i < 300; i++ {
		length := 4 + rng.Intn(7)
		script := make([]byte, length)
		parts := make([]string, length)
		for j := range script {
			k := rng.Intn(len(alphabet))
			script[j], parts[j] = alphabet[k], names[k]
		}
		run(fmt.Sprintf("conditional/sample-%d/%s", i, strings.Join(parts, " ")), script)
	}
	for _, item := range [][]byte{nil, {0x01}, {0x00}, {0x02}, {0x80}, {0x01, 0x00}, {0x00, 0x00}, {0x01, 0x01}, {0x81}} {
		for _, op := range []byte{txscript.OP_IF, txscript.OP_NOTIF} {
			run(fmt.Sprintf("conditional/minimal-if/%s/%x", opName(op), item), ops(op, txscript.OP_1, txscript.OP_ELSE, txscript.OP_1, txscript.OP_ENDIF), item)
			run(fmt.Sprintf("conditional/minimal-if/%s/%x/unexecuted", opName(op), item),
				ops(txscript.OP_0, txscript.OP_IF, op, txscript.OP_ENDIF, txscript.OP_ENDIF, txscript.OP_DROP, txscript.OP_1), item)
		}
	}
}

func signatureCases() {
	type sigCase struct {
		name string
		sig  func(s *spend) []byte
	}
	fieldPrime, _ := hex.DecodeString("fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f")
	groupOrder, _ := hex.DecodeString("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")
	replace := func(sig []byte, offset int, with []byte) []byte {
		out := clone(sig)
		copy(out[offset:], with)
		return out
	}
	minusOne := func(v []byte) []byte {
		out := clone(v)
		out[31]--
		return out
	}
	sigCases := []sigCase{
		{"valid", func(s *spend) []byte { return s.sign(1, 0, noCodeSep) }},
		{"empty", func(s *spend) []byte { return nil }},
		{"one-byte", func(s *spend) []byte { return []byte{0x01} }},
		{"63-bytes", func(s *spend) []byte { return s.sign(1, 0, noCodeSep)[:63] }},
		{"65-bytes-type-00", func(s *spend) []byte { return append(s.sign(1, 0, noCodeSep), 0x00) }},
		{"66-bytes", func(s *spend) []byte { return append(s.sign(1, 1, noCodeSep), 0x01) }},
		{"64-zero-bytes", func(s *spend) []byte { return make([]byte, 64) }},
		{"r-is-field-prime", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 0, fieldPrime) }},
		{"r-is-field-prime-minus-1", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 0, minusOne(fieldPrime)) }},
		{"r-is-group-order", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 0, groupOrder) }},
		{"r-is-all-ones", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 0, filled(32, 0xff)) }},
		{"s-is-group-order", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 32, groupOrder) }},
		{"s-is-group-order-minus-1", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 32, minusOne(groupOrder)) }},
		{"s-is-all-ones", func(s *spend) []byte { return replace(s.sign(1, 0, noCodeSep), 32, filled(32, 0xff)) }},
		{"r-and-s-too-big", func(s *spend) []byte { return filled(64, 0xff) }},
		{"wrong-key", func(s *spend) []byte { return s.sign(2, 0, noCodeSep) }},
		{"signed-as-key-path", func(s *spend) []byte {
			return schnorrSign(keys[1], sigMsg(s.tx, s.idx, s.prevOuts, 0, s.annex, nil, 0), 0)
		}},
		{"signed-without-annex-flag", func(s *spend) []byte {
			leafHash := txscript.NewBaseTapLeaf(s.script).TapHash()
			return schnorrSign(keys[1], sigMsg(s.tx, s.idx, s.prevOuts, 0, annexA, leafHash[:], noCodeSep), 0)
		}},
	}
	for _, hashType := range []int{0x01, 0x02, 0x03, 0x04, 0x05, 0x40, 0x41, 0x80, 0x81, 0x82, 0x83, 0x84, 0xc1, 0xff} {
		hashType := byte(hashType)
		sigCases = append(sigCases,
			sigCase{fmt.Sprintf("signed-for-type-%02x", hashType), func(s *spend) []byte { return s.sign(1, hashType, noCodeSep) }},
			sigCase{fmt.Sprintf("default-signature-with-type-%02x", hashType), func(s *spend) []byte { return append(s.sign(1, 0, noCodeSep), hashType) }},
		)
	}
	leaves := []struct {
		name   string
		script []byte
	}{
		{"checksig", cat(push(pubs[1]), ops(txscript.OP_CHECKSIG))},
		{"checksigverify", cat(push(pubs[1]), ops(txscript.OP_CHECKSIGVERIFY, txscript.OP_1))},
		{"checksigadd", cat(ops(txscript.OP_0), push(pubs[1]), ops(txscript.OP_CHECKSIGADD))},
		{"checksig-not", cat(push(pubs[1]), ops(txscript.OP_CHECKSIG, txscript.OP_NOT))},
	}
	for _, leaf := range leaves {
		for _, c := range sigCases {
			s := newLeafSpend(leaf.script, defaults())
			s.setStack(c.sig(s))
			add(fmt.Sprintf("signature/%s/%s", leaf.name, c.name), s.tx, s.idx, s.prevOuts)
		}
	}
	// SIGHASH_SINGLE on an input with no output at its index.
	for _, hashType := range []byte{0x03, 0x83} {
		o := defaults()
		o.outputs = 0
		s := newLeafSpend(checksigLeaf(1), o)
		s.setStack(s.sign(1, hashType, noCodeSep))
		add(fmt.Sprintf("signature/single-without-output/%02x", hashType), s.tx, s.idx, s.prevOuts)
		tx := newTx(o)
		addInput(tx, 1)
		prevOuts := []*wire.TxOut{wire.NewTxOut(5, keyPathOutput(1))}
		tx.TxIn[0].SetWitness(wire.TxWitness{keyPathSign(tx, 0, prevOuts, 1, hashType, nil)})
		add(fmt.Sprintf("signature/keypath-single-without-output/%02x", hashType), tx, 0, prevOuts)
	}

	// Public keys of every kind, with an empty and a non-empty signature.
	notOnCurve := filled(32, 0)
	notOnCurve[31] = 5
	keyCases := []struct {
		name string
		key  []byte
	}{
		{"valid", pubs[1]}, {"empty", nil}, {"1-byte", []byte{0x02}}, {"31-bytes", pubs[1][:31]}, {"33-bytes", keys[1].PubKey().SerializeCompressed()},
		{"64-bytes", filled(64, 0x02)}, {"65-bytes", keys[1].PubKey().SerializeUncompressed()}, {"zero", filled(32, 0)},
		{"not-on-curve", notOnCurve}, {"field-prime", fieldPrime}, {"all-ones", filled(32, 0xff)}, {"field-prime-minus-1", minusOne(fieldPrime)},
	}
	for _, k := range keyCases {
		for _, leaf := range []struct {
			name   string
			script []byte
		}{
			{"checksig", cat(pushRaw(k.key), ops(txscript.OP_CHECKSIG))},
			{"checksigadd", cat(ops(txscript.OP_0), pushRaw(k.key), ops(txscript.OP_CHECKSIGADD))},
		} {
			for _, sigName := range []string{"empty", "64-bytes", "65-bytes", "10-bytes"} {
				s := newLeafSpend(leaf.script, defaults())
				switch sigName {
				case "empty":
					s.setStack(nil)
				case "64-bytes":
					s.setStack(s.sign(1, 0, noCodeSep))
				case "65-bytes":
					s.setStack(s.sign(1, 1, noCodeSep))
				default:
					s.setStack(filled(10, 7))
				}
				add(fmt.Sprintf("pubkey/%s/%s/signature=%s", leaf.name, k.name, sigName), s.tx, s.idx, s.prevOuts)
			}
		}
		// The same keys as the output key of a key path.
		if len(k.key) == 32 {
			o := defaults()
			tx := newTx(o)
			addInput(tx, 1)
			prevOuts := []*wire.TxOut{wire.NewTxOut(5, cat(ops(txscript.OP_1, 32), k.key))}
			tx.TxIn[0].SetWitness(wire.TxWitness{filled(64, 1)})
			add(fmt.Sprintf("pubkey/keypath/%s", k.name), tx, 0, prevOuts)
		}
	}
	// OP_CHECKSIGADD's counter.
	for _, n := range boundaryNumbers {
		for _, signed := range []bool{false, true} {
			s := newLeafSpend(cat(push(pubs[1]), ops(txscript.OP_CHECKSIGADD)), defaults())
			sig := []byte(nil)
			if signed {
				sig = s.sign(1, 0, noCodeSep)
			}
			s.setStack(sig, n)
			add(fmt.Sprintf("signature/checksigadd-counter/%x/signed=%t", n, signed), s.tx, s.idx, s.prevOuts)
		}
	}
}

// pushRaw pushes data with the push opcode for its length and nothing
// smarter, for keys that would otherwise turn into number opcodes.
func pushRaw(data []byte) []byte {
	if len(data) == 0 {
		return []byte{txscript.OP_0}
	}
	if len(data) == 1 {
		return push(data)
	}
	return append([]byte{byte(len(data))}, data...)
}

func xmssCases() {
	key := xmssKeys[0]
	leaf := xmssLeaf(key)
	build := func(o opts, script []byte, uid uint32, change func(stack [][]byte, s *spend) [][]byte) (*spend, [][]byte) {
		s := newLeafSpend(script, o)
		stack := xmssSign(key, uid, s.msg(0, noCodeSep))
		if change != nil {
			stack = change(stack, s)
		}
		s.setStack(stack...)
		return s, stack
	}
	emit := func(name string, o opts, script []byte, change func(stack [][]byte, s *spend) [][]byte) {
		s, _ := build(o, script, 2, change)
		add("xmss/"+name, s.tx, s.idx, s.prevOuts)
	}
	d := defaults()
	emit("index-field-32", d, leaf, func(stack [][]byte, _ *spend) [][]byte { stack[0][3] = 32; return stack })
	emit("index-field-max", d, leaf, func(stack [][]byte, _ *spend) [][]byte { copy(stack[0], filled(4, 0xff)); return stack })
	emit("index-field-other", d, leaf, func(stack [][]byte, _ *spend) [][]byte { stack[0][3] ^= 1; return stack })
	emit("chunks-swapped", d, leaf, func(stack [][]byte, _ *spend) [][]byte { stack[1], stack[2] = stack[2], stack[1]; return stack })
	emit("chunks-reversed", d, leaf, func(stack [][]byte, _ *spend) [][]byte {
		return [][]byte{stack[4], stack[3], stack[2], stack[1], stack[0]}
	})
	emit("four-chunks", d, leaf, func(stack [][]byte, _ *spend) [][]byte { return stack[1:] })
	emit("six-chunks", d, leaf, func(stack [][]byte, _ *spend) [][]byte { return append([][]byte{stack[0]}, stack...) })
	emit("no-chunks", d, leaf, func(stack [][]byte, _ *spend) [][]byte { return nil })
	emit("empty-chunks", d, leaf, func(stack [][]byte, _ *spend) [][]byte { return make([][]byte, 5) })
	emit("zero-chunks", d, leaf, func(stack [][]byte, _ *spend) [][]byte {
		return [][]byte{make([]byte, 468), make([]byte, 468), make([]byte, 468), make([]byte, 468), make([]byte, 468)}
	})
	for _, i := range []int{0, 2, 4} {
		i := i
		emit(fmt.Sprintf("chunk-%d-467-bytes", i), d, leaf, func(stack [][]byte, _ *spend) [][]byte { stack[i] = stack[i][:467]; return stack })
		emit(fmt.Sprintf("chunk-%d-469-bytes", i), d, leaf, func(stack [][]byte, _ *spend) [][]byte { stack[i] = append(stack[i], 0); return stack })
		emit(fmt.Sprintf("chunk-%d-last-bit", i), d, leaf, func(stack [][]byte, _ *spend) [][]byte { stack[i][467] ^= 1; return stack })
	}
	emit("signed-by-other-key", d, leaf, func(_ [][]byte, s *spend) [][]byte { return xmssSign(xmssKeys[1], 2, s.msg(0, noCodeSep)) })
	emit("signed-other-message", d, leaf, func(_ [][]byte, s *spend) [][]byte { return xmssSign(key, 2, filled(32, 9)) })
	emit("signed-sighash-all", d, leaf, func(_ [][]byte, s *spend) [][]byte { return xmssSign(key, 2, s.msg(1, noCodeSep)) })
	emit("signed-as-key-path", d, leaf, func(_ [][]byte, s *spend) [][]byte {
		return xmssSign(key, 2, sigMsg(s.tx, s.idx, s.prevOuts, 0, nil, nil, 0))
	})
	for _, n := range []int{0, 1, 32, 63, 65} {
		script := cat(pushRaw(filled(n, 0x07)), ops(txscript.OP_CHECKXMSSSIG))
		emit(fmt.Sprintf("key-%d-bytes", n), d, script, nil)
	}
	wrongKey := clone(key.pk[:])
	wrongKey[0] ^= 1
	emit("key-root-changed", d, cat(push(wrongKey), ops(txscript.OP_CHECKXMSSSIG)), nil)
	wrongSeed := clone(key.pk[:])
	wrongSeed[63] ^= 1
	emit("key-seed-changed", d, cat(push(wrongSeed), ops(txscript.OP_CHECKXMSSSIG)), nil)
	emit("verify-after", d, cat(leaf, ops(txscript.OP_VERIFY, txscript.OP_1)), nil)
	emit("unexecuted", d, cat(ops(txscript.OP_0, txscript.OP_IF, txscript.OP_CHECKXMSSSIG, txscript.OP_ENDIF), leaf), nil)

	// The budget: each check costs 1000 against 50 plus the witness size.
	six := repeat(ops(txscript.OP_5, txscript.OP_PICK), 6)
	for checks := 1; checks <= 4; checks++ {
		script := push(key.pk[:])
		for i := 1; i < checks; i++ {
			script = cat(script, six, ops(txscript.OP_CHECKXMSSSIG, txscript.OP_VERIFY))
		}
		script = cat(script, ops(txscript.OP_CHECKXMSSSIG))
		for _, pad := range []int{0, 500, 520} {
			o := defaults()
			name := fmt.Sprintf("budget/checks=%d/annex=%d", checks, pad)
			if pad > 0 {
				o.annex = cat([]byte{0x50}, filled(pad, 0))
			}
			emit(name, o, script, nil)
		}
	}
}

func controlBlockCases() {
	leaf := checksigLeaf(1)
	type change struct {
		name string
		edit func(control []byte) []byte
	}
	changes := []change{
		{"empty", func(c []byte) []byte { return nil }},
		{"one-byte", func(c []byte) []byte { return c[:1] }},
		{"parity-flipped", func(c []byte) []byte { c[0] ^= 1; return c }},
		{"leaf-version-c2", func(c []byte) []byte { c[0] = c[0]&1 | 0xc2; return c }},
		{"leaf-version-00", func(c []byte) []byte { c[0] &= 1; return c }},
		{"leaf-version-50", func(c []byte) []byte { c[0] = c[0]&1 | 0x50; return c }},
		{"truncated", func(c []byte) []byte { return c[:len(c)-1] }},
		{"extended", func(c []byte) []byte { return append(c, 0) }},
		{"extra-node", func(c []byte) []byte { return append(c, filled(32, 3)...) }},
		{"last-byte-flipped", func(c []byte) []byte { c[len(c)-1] ^= 1; return c }},
		{"byte-1-flipped", func(c []byte) []byte {
			if len(c) > 1 {
				c[1] ^= 1
			}
			return c
		}},
		{"32-bytes", func(c []byte) []byte { return filled(32, 0xc1) }},
		{"33-bytes", func(c []byte) []byte { return append([]byte{0xc1}, pubs[2]...) }},
		{"34-bytes", func(c []byte) []byte { return append([]byte{0xc1}, filled(33, 2)...) }},
		{"key-not-on-curve", func(c []byte) []byte {
			if len(c) >= 33 {
				copy(c[1:33], filled(32, 0))
				c[32] = 5
			}
			return c
		}},
		{"key-above-field-prime", func(c []byte) []byte {
			if len(c) >= 33 {
				copy(c[1:33], filled(32, 0xff))
			}
			return c
		}},
	}
	for _, p2tr := range []bool{true, false} {
		for _, siblings := range []int{0, 3} {
			for _, c := range changes {
				o := defaults()
				o.p2tr, o.siblings, o.leafPos = p2tr, siblings, siblings/2
				s := newLeafSpend(leaf, o)
				s.control = c.edit(clone(s.control))
				s.setStack(s.sign(1, 0, noCodeSep))
				add(fmt.Sprintf("control-block/p2tr=%t/leaves=%d/%s", p2tr, siblings+1, c.name), s.tx, s.idx, s.prevOuts)
			}
		}
	}
	// The longest proof the engine reads, and one node more.
	for _, p2tr := range []bool{true, false} {
		for _, nodes := range []int{128, 129} {
			o := defaults()
			o.p2tr = p2tr
			s := newLeafSpend(leaf, o)
			s.control = cat(s.control, filled(32*nodes, 4))
			s.setStack(s.sign(1, 0, noCodeSep))
			add(fmt.Sprintf("control-block/p2tr=%t/%d-nodes", p2tr, nodes), s.tx, s.idx, s.prevOuts)
		}
	}
	// A leaf committed under another leaf version: the commitment holds and
	// the version is what the engine refuses.
	for _, version := range []byte{0xc2, 0x00, 0x02, 0xfe, 0x50, 0x66} {
		for _, p2tr := range []bool{true, false} {
			root := txscript.NewTapLeaf(txscript.TapscriptLeafVersion(version), leaf).TapHash()
			var pkScript, control []byte
			if p2tr {
				outputKey := txscript.ComputeTaprootOutputKey(keys[0].PubKey(), root[:])
				parity := outputKey.SerializeCompressed()[0] & 1
				pkScript = cat(ops(txscript.OP_1, 32), schnorr.SerializePubKey(outputKey))
				control = cat([]byte{version | parity}, pubs[0])
			} else {
				pkScript = cat(ops(txscript.OP_2, 32), root[:])
				control = []byte{version | 1}
			}
			tx := newTx(defaults())
			addInput(tx, 1)
			tx.TxIn[0].SetWitness(wire.TxWitness{{0x01}, leaf, control})
			add(fmt.Sprintf("control-block/committed-leaf-version=%02x/p2tr=%t", version, p2tr), tx, 0, []*wire.TxOut{wire.NewTxOut(1, pkScript)})
		}
	}
}

// engineCases are the checks NewEngine and the witness program dispatch make
// before any leaf runs, and scripts that are not witness programs.
func engineCases() {
	one := []byte{0x01}
	emit := func(name string, pkScript, sigScript []byte, witness wire.TxWitness) {
		tx := newTx(defaults())
		addInput(tx, 1)
		tx.TxIn[0].SignatureScript = sigScript
		if witness != nil {
			tx.TxIn[0].SetWitness(witness)
		}
		add("engine/"+name, tx, 0, []*wire.TxOut{wire.NewTxOut(1, pkScript)})
	}
	for version := 0; version <= 16; version++ {
		op := byte(txscript.OP_0)
		if version > 0 {
			op = byte(txscript.OP_1 + version - 1)
		}
		sizes := []int{2, 32, 40}
		if version == 1 || version == 2 {
			sizes = []int{1, 2, 20, 31, 32, 33, 40, 41}
		}
		for _, size := range sizes {
			pkScript := cat([]byte{op, byte(size)}, filled(size, 0x21))
			emit(fmt.Sprintf("witness-version=%d/program=%d/witness", version, size), pkScript, nil, wire.TxWitness{one})
			emit(fmt.Sprintf("witness-version=%d/program=%d/no-witness", version, size), pkScript, nil, nil)
		}
	}
	p2tr := keyPathOutput(1)
	p2mr := cat(ops(txscript.OP_2, 32), filled(32, 0x31))
	for _, kind := range []struct {
		name     string
		pkScript []byte
	}{{"p2tr", p2tr}, {"p2mr", p2mr}} {
		name, pkScript := kind.name, kind.pkScript
		emit(name+"/empty-witness", pkScript, nil, wire.TxWitness{})
		emit(name+"/one-empty-item", pkScript, nil, wire.TxWitness{nil})
		emit(name+"/one-item", pkScript, nil, wire.TxWitness{filled(64, 1)})
		emit(name+"/annex-only", pkScript, nil, wire.TxWitness{{0x50}})
		emit(name+"/item-and-annex", pkScript, nil, wire.TxWitness{filled(64, 1), {0x50, 0x01}})
		emit(name+"/two-annexes", pkScript, nil, wire.TxWitness{{0x50}, {0x50}})
		emit(name+"/three-annexes", pkScript, nil, wire.TxWitness{{0x50}, {0x50}, {0x50}})
		emit(name+"/two-items", pkScript, nil, wire.TxWitness{one, one})
		emit(name+"/script-and-empty-control", pkScript, nil, wire.TxWitness{one, nil})
		emit(name+"/signature-script", pkScript, []byte{txscript.OP_1}, wire.TxWitness{one})
		emit(name+"/signature-script-not-push-only", pkScript, []byte{txscript.OP_NOP}, wire.TxWitness{one})
		emit(name+"/signature-script-malformed", pkScript, []byte{0x02, 0x01}, wire.TxWitness{one})
		emit(name+"/pushdata1-program", cat([]byte{pkScript[0], txscript.OP_PUSHDATA1, 32}, pkScript[2:]), nil, nil)
		emit(name+"/pushdata1-program/witness", cat([]byte{pkScript[0], txscript.OP_PUSHDATA1, 32}, pkScript[2:]), nil, wire.TxWitness{one})
		emit(name+"/trailing-opcode", cat(pkScript, ops(txscript.OP_NOP)), nil, nil)
		emit(name+"/trailing-opcode/witness", cat(pkScript, ops(txscript.OP_NOP)), nil, wire.TxWitness{one})
	}

	// Scripts that are not witness programs still run, under the rules for
	// scripts outside a leaf.
	bare := map[string][2][]byte{
		"empty-both":              {nil, nil},
		"empty-output-script":     {nil, {txscript.OP_1}},
		"op-1":                    {{txscript.OP_1}, nil},
		"op-0":                    {{txscript.OP_0}, nil},
		"op-return":               {{txscript.OP_RETURN}, nil},
		"op-return-data":          {cat(ops(txscript.OP_RETURN), push(filled(20, 1))), nil},
		"two-items-left":          {{txscript.OP_1, txscript.OP_1}, nil},
		"signature-script-pushes": {{txscript.OP_ADD, txscript.OP_3, txscript.OP_EQUAL}, {txscript.OP_1, txscript.OP_2}},
		"signature-script-opcode": {{txscript.OP_1}, {txscript.OP_1, txscript.OP_DUP}},
		"signature-script-bad":    {{txscript.OP_1}, {0x05, 0x01}},
		"output-script-bad":       {{txscript.OP_1, 0x05, 0x01}, nil},
		"checksig":                {cat(push(pubs[1]), ops(txscript.OP_CHECKSIG)), push(filled(64, 1))},
		"checksig-empty-stack":    {ops(txscript.OP_CHECKSIG), nil},
		"p2pkh":                   {cat(ops(txscript.OP_DUP, txscript.OP_HASH160), push(btcec160(keys[1])), ops(txscript.OP_EQUALVERIFY, txscript.OP_CHECKSIG)), cat(push(filled(71, 0x30)), push(keys[1].PubKey().SerializeCompressed()))},
		"hash-lock":               {cat(ops(txscript.OP_SHA256), push(sha(one)), ops(txscript.OP_EQUAL)), push(one)},
		"altstack-across-scripts": {{txscript.OP_FROMALTSTACK}, {txscript.OP_1}},
		"conditional-across":      {{txscript.OP_ENDIF, txscript.OP_1}, {txscript.OP_1}},
		"element-521":             {cat([]byte{txscript.OP_PUSHDATA2, 0x09, 0x02}, filled(521, 1)), nil},
		"element-520":             {cat([]byte{txscript.OP_PUSHDATA2, 0x08, 0x02}, filled(520, 1)), nil},
		"201-operations":          {cat(repeat(ops(txscript.OP_NOP), 201), ops(txscript.OP_1)), nil},
		"202-operations":          {cat(repeat(ops(txscript.OP_NOP), 202), ops(txscript.OP_1)), nil},
		"201-skipped-operations":  {cat(ops(txscript.OP_0, txscript.OP_IF), repeat(ops(txscript.OP_NOP), 199), ops(txscript.OP_ENDIF, txscript.OP_1)), nil},
		"202-skipped-operations":  {cat(ops(txscript.OP_0, txscript.OP_IF), repeat(ops(txscript.OP_NOP), 200), ops(txscript.OP_ENDIF, txscript.OP_1)), nil},
		"202-pushes":              {cat(repeat(ops(txscript.OP_1, txscript.OP_DROP), 100), ops(txscript.OP_1, txscript.OP_1, txscript.OP_1)), nil},
		"script-10000":            {cat(repeat(ops(txscript.OP_1, txscript.OP_DROP), 100), repeat(push(filled(75, 1)), 128), repeat(ops(txscript.OP_1), 72)), nil},
		"script-10001":            {cat(repeat(push(filled(75, 1)), 131), repeat(ops(txscript.OP_1), 45)), nil},
		"signature-script-10001":  {{txscript.OP_1}, cat(repeat(push(filled(75, 1)), 131), repeat(ops(txscript.OP_1), 45))},
		"1001-items":              {repeat(ops(txscript.OP_1), 1001), nil},
		"1000-items":              {repeat(ops(txscript.OP_1), 1000), nil},
	}
	names := make([]string, 0, len(bare))
	for name := range bare {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		emit("bare/"+name, bare[name][0], bare[name][1], nil)
		emit("bare/"+name+"/witness", bare[name][0], bare[name][1], wire.TxWitness{one})
	}
	// Every opcode as an output script, with three items from the signature script.
	for code := 0; code < 256; code++ {
		emit(fmt.Sprintf("bare-opcode/%s", opName(byte(code))), withOperand(byte(code)), ops(txscript.OP_1, txscript.OP_1, txscript.OP_1), nil)
	}
	emit("bare-opcode/OP_CAT/unexecuted", cat(ops(txscript.OP_0, txscript.OP_IF, txscript.OP_CAT, txscript.OP_ENDIF, txscript.OP_1)), nil, nil)
}

func sha(data []byte) []byte {
	sum := sha256.Sum256(data)
	return sum[:]
}

func btcec160(key *btcec.PrivateKey) []byte {
	// Any 20 bytes do: the engine fails at OP_CHECKSIG either way.
	return sha(key.PubKey().SerializeCompressed())[:20]
}

func timelockCases() {
	lockTimes := []uint32{0, 1, 499999999, 500000000, 500000001, 0xffffffff}
	operands := [][]byte{
		nil, num(1), num(499999999), num(500000000), num(500000001), num(1<<31 - 1), num(1 << 31), num(1<<32 - 1), num(1 << 32),
		num(1<<39 - 1), num(-1), {0x00, 0x00, 0x00, 0x00, 0x00, 0x01}, {0x00}, {0x01, 0x00},
	}
	for _, lockTime := range lockTimes {
		for _, operand := range operands {
			for _, sequence := range []uint32{0xffffffff, 0xfffffffe} {
				o := defaults()
				o.lockTime, o.sequence = lockTime, sequence
				runWith(fmt.Sprintf("timelock/cltv/locktime=%d/sequence=%x/operand=%x", lockTime, sequence, operand), o,
					ops(txscript.OP_CHECKLOCKTIMEVERIFY, txscript.OP_DROP, txscript.OP_1), operand)
			}
		}
	}
	sequences := []uint32{0, 1, 0xffff, 0x10001, 0x400000, 0x400001, 0x80000000, 0x80400001, 0xffffffff}
	csvOperands := [][]byte{
		nil, num(1), num(0xffff), num(0x10000), num(0x10001), num(0x400000), num(0x400001), num(0x80000000), num(0x80000001),
		num(1<<32 + 1), num(1<<39 - 1), num(-1), {0x00, 0x00, 0x00, 0x00, 0x00, 0x01}, {0x00},
	}
	for _, version := range []int32{1, 2, 3, 0, -1} {
		if version == -1 {
			sequences = []uint32{1, 0x400001, 0x80000000}
		}
		for _, sequence := range sequences {
			for _, operand := range csvOperands {
				if (version == 3 || version == 0) && sequence != 1 && sequence != 0x400001 {
					continue
				}
				o := defaults()
				o.version, o.sequence = version, sequence
				runWith(fmt.Sprintf("timelock/csv/version=%d/sequence=%x/operand=%x", version, sequence, operand), o,
					ops(txscript.OP_CHECKSEQUENCEVERIFY, txscript.OP_DROP, txscript.OP_1), operand)
			}
		}
	}
	// Timelock leaves with a signature, as wallets build them.
	for _, item := range []struct {
		name     string
		op       byte
		operand  int64
		lockTime uint32
		sequence uint32
	}{
		{"cltv-height", txscript.OP_CHECKLOCKTIMEVERIFY, 500, 500, 0xfffffffe},
		{"cltv-height-early", txscript.OP_CHECKLOCKTIMEVERIFY, 500, 499, 0xfffffffe},
		{"cltv-time", txscript.OP_CHECKLOCKTIMEVERIFY, 1700000000, 1700000001, 0},
		{"csv-blocks", txscript.OP_CHECKSEQUENCEVERIFY, 144, 0, 144},
		{"csv-blocks-early", txscript.OP_CHECKSEQUENCEVERIFY, 144, 0, 143},
		{"csv-seconds", txscript.OP_CHECKSEQUENCEVERIFY, 0x400010, 0, 0x400011},
	} {
		for _, p2tr := range []bool{true, false} {
			o := defaults()
			o.p2tr, o.lockTime, o.sequence = p2tr, item.lockTime, item.sequence
			s := newLeafSpend(cat(push(num(item.operand)), ops(item.op, txscript.OP_DROP), checksigLeaf(2)), o)
			s.setStack(s.sign(2, 0, noCodeSep))
			add(fmt.Sprintf("timelock/leaf/%s/p2tr=%t", item.name, p2tr), s.tx, s.idx, s.prevOuts)
		}
	}
}

func limitCases() {
	one := []byte{0x01}
	items := func(n int) [][]byte {
		out := make([][]byte, n)
		for i := range out {
			out[i] = one
		}
		return out
	}
	drops := func(n int) []byte {
		return cat(repeat(ops(txscript.OP_2DROP), n/2), repeat(ops(txscript.OP_DROP), n%2))
	}
	for _, n := range []int{999, 1000, 1001, 1002} {
		run(fmt.Sprintf("limit/witness-stack/%d", n), cat(drops(n-1)), items(n)...)
		run(fmt.Sprintf("limit/witness-stack/%d/empty-leaf", n), nil, items(n)...)
		run(fmt.Sprintf("limit/pushes/%d", n), cat(repeat(ops(txscript.OP_1), n), drops(n-1)))
		run(fmt.Sprintf("limit/stack-and-altstack/%d", n),
			cat(repeat(ops(txscript.OP_1, txscript.OP_TOALTSTACK), n/2), repeat(ops(txscript.OP_1), n-n/2), drops(n-n/2-1)))
		run(fmt.Sprintf("limit/dup-from-witness/%d", n), cat(ops(txscript.OP_DUP), drops(n-1)), items(n-1)...)
		run(fmt.Sprintf("limit/3dup-then-drop/%d", n), cat(ops(txscript.OP_3DUP, txscript.OP_2DROP, txscript.OP_DROP), drops(n-4)), items(n-3)...)
	}
	for _, n := range []int{519, 520, 521, 1000} {
		run(fmt.Sprintf("limit/witness-item/%d", n), ops(txscript.OP_SIZE, txscript.OP_SWAP, txscript.OP_DROP), filled(n, 1))
		run(fmt.Sprintf("limit/witness-item/%d/below-top", n), ops(txscript.OP_DROP, txscript.OP_DROP, txscript.OP_1), filled(n, 1), one)
		run(fmt.Sprintf("limit/witness-item/%d/empty-leaf", n), nil, filled(n, 1))
	}
	// A leaf has no operation limit and no size limit.
	run("limit/leaf-operations/300", cat(repeat(ops(txscript.OP_NOP), 300), ops(txscript.OP_1)))
	run("limit/leaf-operations/5000", cat(repeat(ops(txscript.OP_1, txscript.OP_DROP), 2500), ops(txscript.OP_1)))
	run("limit/leaf-size/10001", cat(repeat(push(filled(75, 1)), 131), repeat(ops(txscript.OP_DROP), 131), ops(txscript.OP_1)))
	run("limit/empty-leaf", nil, one)
	run("limit/empty-leaf/false", nil, nil)
	run("limit/empty-leaf/no-stack", nil)
	run("limit/empty-leaf/two-items", nil, one, one)
	run("limit/final-stack/negative-zero", ops(txscript.OP_NOP), []byte{0x80})
	run("limit/final-stack/zeros", ops(txscript.OP_NOP), []byte{0x00, 0x00})
	run("limit/final-stack/zero-then-sign", ops(txscript.OP_NOP), []byte{0x00, 0x80})
	run("limit/final-stack/large", ops(txscript.OP_NOP), filled(520, 0))

	// The signature operation budget: 50 plus the witness size, less 50 for
	// every check of a signature that is not empty.
	for _, checks := range []int{1, 2, 3, 4, 5, 6, 8, 12} {
		for _, pad := range []int{0, 1, 48, 49, 50, 99, 100, 300} {
			script := cat(push(pubs[1]), repeat(ops(txscript.OP_2DUP, txscript.OP_CHECKSIGVERIFY), checks-1), ops(txscript.OP_CHECKSIG))
			o := defaults()
			if pad > 0 {
				o.annex = cat([]byte{0x50}, filled(pad-1, 0))
			}
			s := newLeafSpend(script, o)
			s.setStack(s.sign(1, 0, noCodeSep))
			add(fmt.Sprintf("limit/sigops/checks=%d/annex=%d", checks, pad), s.tx, s.idx, s.prevOuts)
		}
		// Empty signatures cost nothing.
		script := cat(repeat(cat(ops(txscript.OP_0), push(pubs[1]), ops(txscript.OP_CHECKSIG, txscript.OP_DROP)), checks*20), ops(txscript.OP_1))
		run(fmt.Sprintf("limit/sigops/empty-signatures=%d", checks*20), script)
		// OP_CHECKSIGADD draws on the same budget.
		addScript := cat(ops(txscript.OP_0), repeat(cat(ops(txscript.OP_OVER, txscript.OP_SWAP), push(pubs[1]), ops(txscript.OP_CHECKSIGADD)), checks),
			push(num(int64(checks))), ops(txscript.OP_NUMEQUALVERIFY, txscript.OP_DROP, txscript.OP_1))
		s := newLeafSpend(addScript, defaults())
		s.setStack(s.sign(1, 0, noCodeSep))
		add(fmt.Sprintf("limit/sigops/checksigadd=%d", checks), s.tx, s.idx, s.prevOuts)
	}
	// The budget is charged before the key and the signature are looked at.
	for _, name := range []string{"bad-signature", "bad-key", "empty-key"} {
		for _, pad := range []int{0, 200} {
			key := pubs[1]
			if name == "bad-key" {
				key = filled(32, 0xff)
			} else if name == "empty-key" {
				key = nil
			}
			script := cat(push(pubs[1]), repeat(ops(txscript.OP_2DUP, txscript.OP_CHECKSIGVERIFY), 3), ops(txscript.OP_DROP), pushRaw(key), ops(txscript.OP_CHECKSIG))
			o := defaults()
			if pad > 0 {
				o.annex = cat([]byte{0x50}, filled(pad, 0))
			}
			s := newLeafSpend(script, o)
			s.setStack(s.sign(1, 0, noCodeSep))
			add(fmt.Sprintf("limit/sigops/fourth-check-%s/annex=%d", name, pad), s.tx, s.idx, s.prevOuts)
		}
	}
}

// Random scripts.

var commonOps = []byte{
	txscript.OP_NOP, txscript.OP_VERIFY, txscript.OP_TOALTSTACK, txscript.OP_FROMALTSTACK, txscript.OP_2DROP, txscript.OP_2DUP,
	txscript.OP_3DUP, txscript.OP_2OVER, txscript.OP_2ROT, txscript.OP_2SWAP, txscript.OP_IFDUP, txscript.OP_DEPTH, txscript.OP_DROP,
	txscript.OP_DUP, txscript.OP_NIP, txscript.OP_OVER, txscript.OP_PICK, txscript.OP_ROLL, txscript.OP_ROT, txscript.OP_SWAP,
	txscript.OP_TUCK, txscript.OP_CAT, txscript.OP_SIZE, txscript.OP_EQUAL, txscript.OP_EQUALVERIFY, txscript.OP_1ADD, txscript.OP_1SUB,
	txscript.OP_NEGATE, txscript.OP_ABS, txscript.OP_NOT, txscript.OP_0NOTEQUAL, txscript.OP_ADD, txscript.OP_SUB, txscript.OP_BOOLAND,
	txscript.OP_BOOLOR, txscript.OP_NUMEQUAL, txscript.OP_NUMEQUALVERIFY, txscript.OP_NUMNOTEQUAL, txscript.OP_LESSTHAN,
	txscript.OP_GREATERTHAN, txscript.OP_LESSTHANOREQUAL, txscript.OP_GREATERTHANOREQUAL, txscript.OP_MIN, txscript.OP_MAX,
	txscript.OP_WITHIN, txscript.OP_RIPEMD160, txscript.OP_SHA1, txscript.OP_SHA256, txscript.OP_HASH160, txscript.OP_HASH256,
	txscript.OP_CODESEPARATOR, txscript.OP_CHECKSIG, txscript.OP_CHECKSIGVERIFY, txscript.OP_CHECKSIGADD,
	txscript.OP_CHECKLOCKTIMEVERIFY, txscript.OP_CHECKSEQUENCEVERIFY, txscript.OP_1NEGATE,
}

var randomNumbers = []int64{0, 0, 1, 1, 1, 2, 2, 3, 4, 5, 7, 16, 17, 100, 127, 128, 255, 256, 65535, 1<<31 - 1, -1, -1, -2, -128, -(1<<31 - 1), 1 << 31, 500000000}

func randomPush() []byte {
	switch rng.Intn(10) {
	case 0:
		return push(randBytes(rng.Intn(40)))
	case 1:
		return push(pubs[rng.Intn(len(pubs))])
	default:
		return push(num(randomNumbers[rng.Intn(len(randomNumbers))]))
	}
}

func randomItem() []byte {
	switch rng.Intn(8) {
	case 0:
		return randBytes(rng.Intn(70))
	case 1:
		return filled(64+rng.Intn(2), byte(rng.Intn(256)))
	default:
		return num(randomNumbers[rng.Intn(len(randomNumbers))])
	}
}

func randomOpts() opts {
	o := defaults()
	o.p2tr = rng.Intn(2) == 0
	if rng.Intn(5) == 0 {
		o.annex = cat([]byte{0x50}, randBytes(rng.Intn(30)))
	}
	if rng.Intn(4) == 0 {
		o.siblings = 1 + rng.Intn(4)
		o.leafPos = rng.Intn(o.siblings + 1)
	}
	o.lockTime = []uint32{0, 1, 100, 499999999, 500000000, 0xffffffff}[rng.Intn(6)]
	o.sequence = []uint32{0, 1, 100, 0x400001, 0xfffffffd, 0xfffffffe, 0xffffffff, 0x80000000}[rng.Intn(8)]
	o.version = []int32{1, 2, 2, 2}[rng.Intn(4)]
	return o
}

// wildScript is noise: opcodes and pushes with no regard for what is on the
// stack, over a random starting stack. Most fail within a few opcodes, in
// every way a script can.
func wildScript(i int) {
	var script []byte
	if rng.Intn(10) == 0 {
		script = randBytes(1 + rng.Intn(30))
	} else {
		for n := 1 + rng.Intn(25); n > 0; n-- {
			switch r := rng.Intn(20); {
			case r < 9:
				script = append(script, commonOps[rng.Intn(len(commonOps))])
			case r < 15:
				script = append(script, randomPush()...)
			case r < 16:
				script = append(script, byte(rng.Intn(256)))
			case r < 18:
				script = append(script, []byte{txscript.OP_IF, txscript.OP_NOTIF, txscript.OP_ELSE, txscript.OP_ENDIF, txscript.OP_ENDIF}[rng.Intn(5)])
			default:
				script = append(script, byte(txscript.OP_1+rng.Intn(16)))
			}
		}
	}
	stack := make([][]byte, rng.Intn(7))
	for j := range stack {
		stack[j] = randomItem()
	}
	runWith(fmt.Sprintf("random/wild-%d", i), randomOpts(), script, stack...)
}

type sigSlot struct {
	key      int
	hashType byte
	codeSep  uint32
	empty    bool
	xmss     bool
}

// plan is a script under construction: a prefix that checks signatures taken
// from the witness, and a body grown one opcode at a time.
type plan struct {
	o      opts
	prefix []byte
	body   []byte
	slots  []sigSlot
	under  [][]byte
}

func (p *plan) build(tail []byte) *spend {
	s := newLeafSpend(cat(p.prefix, p.body, tail), p.o)
	stack := append([][]byte{}, p.under...)
	for i := len(p.slots) - 1; i >= 0; i-- {
		slot := p.slots[i]
		switch {
		case slot.empty:
			stack = append(stack, nil)
		case slot.xmss:
			stack = append(stack, xmssSign(xmssKeys[slot.key], uint32(i), s.msg(0, slot.codeSep))...)
		default:
			stack = append(stack, s.sign(slot.key, slot.hashType, slot.codeSep))
		}
	}
	s.setStack(stack...)
	return s
}

func isSoft(code string) bool {
	return code == "" || code == "ErrCleanStack" || code == "ErrEvalFalse" || code == "ErrEmptyStack"
}

// grownScript asks the engine about every opcode before keeping it, so most
// of these run long and many succeed: signatures that verify, conditionals
// that nest, arithmetic on values that are numbers.
func grownScript(i int, allowXmss bool) {
	p := &plan{o: randomOpts()}
	for n := rng.Intn(4); n > 0; n-- {
		p.under = append(p.under, randomItem())
	}
	opcodes := 0
	codeSep := uint32(noCodeSep)
	emit := func(part []byte, count int) {
		p.prefix = append(p.prefix, part...)
		opcodes += count
	}
	sigs := []int{0, 0, 1, 1, 2, 3}[rng.Intn(6)]
	if allowXmss && sigs == 0 {
		sigs = 1
	}
	withXmss := allowXmss
	for n := 0; n < sigs; n++ {
		if rng.Intn(3) == 0 {
			codeSep = uint32(opcodes)
			emit(ops(txscript.OP_CODESEPARATOR), 1)
		}
		slot := sigSlot{key: 1 + rng.Intn(8), hashType: hashTypes[rng.Intn(len(hashTypes))], codeSep: codeSep}
		if slot.hashType&3 == 3 && p.o.outputs == 0 {
			slot.hashType = 0
		}
		switch r := rng.Intn(10); {
		case withXmss && n == 0:
			slot.xmss, slot.key = true, rng.Intn(2)
			emit(cat(push(xmssKeys[slot.key].pk[:]), ops(txscript.OP_CHECKXMSSSIG, txscript.OP_VERIFY)), 3)
		case r < 4:
			emit(cat(push(pubs[slot.key]), ops(txscript.OP_CHECKSIGVERIFY)), 2)
		case r < 6:
			emit(cat(push(pubs[slot.key]), ops(txscript.OP_CHECKSIG, txscript.OP_VERIFY)), 3)
		case r < 8:
			emit(cat(ops(txscript.OP_0), push(pubs[slot.key]), ops(txscript.OP_CHECKSIGADD, txscript.OP_VERIFY)), 4)
		default:
			slot.empty = true
			emit(cat(push(pubs[slot.key]), ops(txscript.OP_CHECKSIG, txscript.OP_NOT, txscript.OP_VERIFY)), 4)
		}
		p.slots = append(p.slots, slot)
	}

	open := 0
	closing := func(n int) []byte { return repeat(ops(txscript.OP_ENDIF), n) }
	try := func(candidate []byte, openAfter int) result {
		saved := p.body
		p.body = cat(p.body, candidate)
		s := p.build(closing(openAfter))
		res := execute(s.tx, s.idx, s.prevOuts)
		if !isSoft(res.code) {
			p.body = saved
		}
		return res
	}
	target := 3 + rng.Intn(40)
	broken := false
	for step, misses := 0, 0; step < target && misses < 12; {
		var candidate []byte
		openAfter := open
		switch r := rng.Intn(100); {
		case r < 30:
			candidate = randomPush()
		case r < 34:
			candidate, openAfter = ops([]byte{txscript.OP_IF, txscript.OP_NOTIF}[rng.Intn(2)]), open+1
		case r < 37 && open > 0:
			candidate = ops(txscript.OP_ELSE)
		case r < 42 && open > 0:
			candidate, openAfter = ops(txscript.OP_ENDIF), open-1
		case r < 44:
			candidate = []byte{byte(rng.Intn(256))}
			if candidate[0] >= 1 && candidate[0] <= 0x4e {
				candidate = randomPush()
			}
		default:
			candidate = ops(commonOps[rng.Intn(len(commonOps))])
		}
		res := try(candidate, openAfter)
		if isSoft(res.code) {
			open = openAfter
			step++
			continue
		}
		// Keep a failing opcode now and then, and stop there.
		if rng.Intn(9) == 0 {
			p.body = cat(p.body, candidate)
			open = openAfter
			broken = true
			break
		}
		misses++
	}
	tail := closing(open)
	if !broken && rng.Intn(8) != 0 {
		s := p.build(tail)
		res := execute(s.tx, s.idx, s.prevOuts)
		depth := len(res.stack)
		tail = cat(tail, repeat(ops(txscript.OP_2DROP), depth/2), repeat(ops(txscript.OP_DROP), depth%2), ops(txscript.OP_1))
	}
	s := p.build(tail)
	if rng.Intn(25) == 0 {
		// A transaction changed after signing.
		s.tx.LockTime ^= 1
	}
	add(fmt.Sprintf("random/grown-%d", i), s.tx, s.idx, s.prevOuts)
}

func main() {
	out := flag.String("out", "", "file to write")
	seed := flag.Int64("seed", 1, "seed of the random cases")
	random := flag.Int("random", 3000, "number of random scripts")
	randomOnly := flag.Bool("random-only", false, "leave out the enumerated cases, for a sweep")
	flag.Parse()
	if *out == "" {
		panic("-out is required")
	}
	rng = rand.New(rand.NewSource(*seed))

	for i := 0; i < 24; i++ {
		sum := sha256.Sum256([]byte(fmt.Sprintf("pearljs interpreter vectors key %d", i)))
		key, _ := btcec.PrivKeyFromBytes(sum[:])
		keys = append(keys, key)
		pubs = append(pubs, schnorr.SerializePubKey(key.PubKey()))
	}
	for i := 0; i < 2; i++ {
		var priv [xmss.PrivateSeedLen]byte
		var pub [xmss.PublicSeedLen]byte
		for j := range priv {
			priv[j] = byte(0x10*(i+1) + j)
		}
		for j := range pub {
			pub[j] = byte(0x90 + 0x20*i + j)
		}
		k := &xmssKey{}
		var err error
		k.pk, k.sk, err = xmss.Keygen(priv, pub)
		check(err)
		xmssKeys = append(xmssKeys, k)
	}

	if !*randomOnly {
		validSpends()
		mutations()
		opcodeCases()
		signatureCases()
		xmssCases()
		controlBlockCases()
		engineCases()
		timelockCases()
		limitCases()
	}
	xmssEvery := 150
	for i := 0; i < *random; i++ {
		if i%5 < 2 {
			wildScript(i)
		} else {
			grownScript(i, i%xmssEvery == 2)
		}
	}

	var codes []string
	for code := txscript.ErrorCode(0); !strings.HasPrefix(code.String(), "Unknown"); code++ {
		codes = append(codes, code.String())
	}
	file := File{
		Source: "github.com/pearl-research-labs/pearl", Seed: *seed, RandomScripts: *random, ErrorCodes: codes, Cases: cases,
	}
	// One case per line keeps diffs of a regenerated file readable.
	var buf bytes.Buffer
	head, err := json.Marshal(struct {
		Source        string   `json:"source"`
		Seed          int64    `json:"seed"`
		RandomScripts int      `json:"randomScripts"`
		ErrorCodes    []string `json:"errorCodes"`
	}{file.Source, file.Seed, file.RandomScripts, file.ErrorCodes})
	check(err)
	buf.Write(head[:len(head)-1])
	buf.WriteString(",\"cases\":[\n")
	for i, c := range file.Cases {
		line, err := json.Marshal(c)
		check(err)
		buf.Write(line)
		if i < len(file.Cases)-1 {
			buf.WriteByte(',')
		}
		buf.WriteByte('\n')
	}
	buf.WriteString("]}\n")
	written := buf.Bytes()
	if strings.HasSuffix(*out, ".gz") {
		// No name and no time in the header, so the same cases give the same file.
		var packed bytes.Buffer
		zip, err := gzip.NewWriterLevel(&packed, gzip.BestCompression)
		check(err)
		_, err = zip.Write(written)
		check(err)
		check(zip.Close())
		written = packed.Bytes()
	}
	check(os.WriteFile(*out, written, 0o644))

	accepted := 0
	byCode := map[string]int{}
	for _, c := range cases {
		if c.Code == "" {
			accepted++
		}
		byCode[c.Code]++
	}
	fmt.Printf("%d cases, %d accepted, %d refused with %d distinct codes, %d bytes\n", len(cases), accepted, len(cases)-accepted, len(byCode)-1, len(written))
	groups := make([]string, 0, len(counts))
	for group := range counts {
		groups = append(groups, group)
	}
	sort.Strings(groups)
	for _, group := range groups {
		fmt.Printf("  %-14s %d\n", group, counts[group])
	}
	codeNames := make([]string, 0, len(byCode))
	for code := range byCode {
		codeNames = append(codeNames, code)
	}
	sort.Strings(codeNames)
	for _, code := range codeNames {
		if code != "" {
			fmt.Printf("  %-42s %d\n", code, byCode[code])
		}
	}
}

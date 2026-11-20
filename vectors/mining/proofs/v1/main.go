// V1 proof vectors: mainnet V1 blocks (test-mainnet/fixtures) judged by
// zkpow.VerifyCertificate, the function pearld verifies a block's
// certificate with, as mined and after one tampering at a time, and with
// their public data changed at random and at the sizes where a 32-bit usize
// would wrap. A V1 certificate reaches verifyCertificateV1 and
// verify_zk_proof_v1, which VerifyZKProofFFI does not. A V2 and a V3 proof
// from vectors/mining/proofs.json are judged as V1, and the V1 proofs as V2
// and V3.
//
//	go -C /path/to/pearl/node run -tags zkpow /path/to/pearljs/vectors/mining/proofs/v1/main.go \
//	  /path/to/pearljs/test-mainnet/fixtures /path/to/pearljs/vectors/mining/proofs.json \
//	  > /path/to/pearljs/vectors/mining/proofs-v1.json
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
)

type base struct {
	name   string
	header wire.BlockHeader
	pd     []byte
	proof  []byte
}

// A case names its base and what changed. The header and certificate hash
// are given when the case is not resealed, otherwise the reader reseals the
// base's header to the changed certificate as a miner would.
type proofEdit struct {
	Flip   *int `json:"flip,omitempty"`
	Length *int `json:"length,omitempty"`
}

type caseJSON struct {
	Name    string     `json:"name,omitempty"`
	Base    string     `json:"base"`
	Version uint32     `json:"version"`
	Edits   [][2]any   `json:"edits"`
	Proof   *proofEdit `json:"proof,omitempty"`
	Header  string     `json:"header,omitempty"`
	Hash    string     `json:"hash,omitempty"`
	Error   *string    `json:"error"`
}

var seed uint32 = 7

func rnd() uint32 {
	seed ^= seed << 13
	seed ^= seed >> 17
	seed ^= seed << 5
	return seed
}

func pick[T any](xs []T) T { return xs[rnd()%uint32(len(xs))] }

var (
	u32s = []uint32{0, 1, 2, 15, 16, 31, 32, 63, 64, 128, 256, 512, 1023, 1024, 2048, 4096, 8192, 65536, 65537, 1<<21 - 1, 1 << 21, 1<<21 + 1, 1 << 22, 3 << 21, 1<<24 - 1, 1 << 24, 1<<24 + 1, 1 << 31, 1<<32 - 1}
	u16s = []uint16{0, 1, 16, 32, 64, 96, 128, 256, 512, 1024, 2048, 0xffff}
)

func put32(pd []byte, at int, v uint32) { binary.LittleEndian.PutUint32(pd[at:], v) }
func put16(pd []byte, at int, v uint16) { binary.LittleEndian.PutUint16(pd[at:], v) }

// V1 layout: k u32 at 0, rank u16 at 4, MMA type u16 at 6, row and column
// patterns at 8..20, reserved zeros at 20..52, hash_a, hash_b, the jackpot
// at 116..148, then m n t_rows t_cols at 148..164.
func mutate(pd []byte) []byte {
	pd = append([]byte(nil), pd...)
	for i, n := 0, 1+int(rnd()%3); i < n; i++ {
		switch rnd() % 9 {
		case 0:
			pd[rnd()%uint32(len(pd))] = byte(rnd())
		case 1:
			put32(pd, 0, pick(u32s))
		case 2:
			put16(pd, 4, pick(u16s))
		case 3:
			pd[8+rnd()%12] = pick([]byte{0, 1, 2, 3, 7, 15, 31, 255})
		case 4, 5:
			put32(pd, pick([]int{148, 152, 148, 152, 156, 160}), pick(u32s))
		case 6:
			put16(pd, 6, pick([]uint16{0, 1, 2, 3, 0xffff}))
		case 7:
			pd[20+rnd()%32] = byte(rnd())
		case 8:
			pd[52+rnd()%64] ^= 1
		}
	}
	return pd
}

func zeroJackpot(pd []byte) { clear(pd[116:148]) }

func build(b base, version uint32, header wire.BlockHeader, pd, proof []byte) (wire.BlockHeader, wire.BlockCertificate) {
	var cert wire.BlockCertificate
	switch version {
	case 1:
		c := &wire.CertificateV1{ProofData: proof}
		if len(pd) != wire.PublicDataSizeV1 {
			panic("V1 public data is 164 bytes")
		}
		copy(c.PublicData[:], pd)
		header.ProofCommitment = c.ProofCommitment()
		c.Hash = header.BlockHash()
		cert = c
	case 2, 3:
		var p *wire.CertificateV2
		if version == 2 {
			c := &wire.CertificateV2{}
			cert, p = c, c
		} else {
			c := &wire.CertificateV3{}
			cert, p = c, &c.CertificateV2
		}
		p.PublicDataLen = uint32(len(pd))
		copy(p.PublicData[:], pd)
		p.ProofData = proof
		header.ProofCommitment = cert.ProofCommitment()
		p.Hash = header.BlockHash()
	}
	return header, cert
}

func edits(from, to []byte) [][2]any {
	out := [][2]any{}
	for i := 0; i < len(to); {
		if from[i] == to[i] {
			i++
			continue
		}
		j := i
		for j < len(to) && from[j] != to[j] {
			j++
		}
		out = append(out, [2]any{i, hex.EncodeToString(to[i:j])})
		i = j
	}
	return out
}

func headerHex(h *wire.BlockHeader) string {
	var buf bytes.Buffer
	if err := h.Serialize(&buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf.Bytes())
}

func judge(h wire.BlockHeader, cert wire.BlockCertificate) *string {
	if err := zkpow.VerifyCertificate(&h, cert); err != nil {
		s := err.Error()
		return &s
	}
	return nil
}

func load(dir string) []base {
	var out []base
	files, _ := filepath.Glob(filepath.Join(dir, "block-*.hex"))
	for _, f := range files {
		text, err := os.ReadFile(f)
		if err != nil {
			panic(err)
		}
		raw, err := hex.DecodeString(strings.TrimSpace(string(text)))
		if err != nil {
			panic(err)
		}
		var block wire.MsgBlock
		if err := block.Deserialize(bytes.NewReader(raw)); err != nil {
			panic(err)
		}
		c, ok := block.MsgHeader.BlockCertificate().(*wire.CertificateV1)
		if !ok {
			continue
		}
		name := strings.TrimSuffix(strings.TrimPrefix(filepath.Base(f), "block-"), ".hex")
		out = append(out, base{name: name, header: block.MsgHeader.BlockHeader, pd: c.PublicData[:], proof: c.ProofData})
	}
	return out
}

func main() {
	bases := load(os.Args[1])
	var cases []caseJSON
	resealed := func(name string, b base, version uint32, pd, proof []byte, pe *proofEdit) {
		h, cert := build(b, version, b.header, pd, proof)
		cases = append(cases, caseJSON{Name: name, Base: b.name, Version: version, Edits: edits(b.pd, pd), Proof: pe, Error: judge(h, cert)})
	}
	asIs := func(name string, b base, h wire.BlockHeader, cert wire.BlockCertificate) {
		hash := cert.BlockHash()
		cases = append(cases, caseJSON{Name: name, Base: b.name, Version: uint32(cert.Version()), Edits: edits(b.pd, cert.PublicDataBytes()), Header: headerHex(&h), Hash: hex.EncodeToString(hash[:]), Error: judge(h, cert)})
	}
	n := func(v int) *int { return &v }

	for _, b := range bases {
		h, cert := build(b, 1, b.header, b.pd, b.proof)
		if cert.BlockHash() != b.header.BlockHash() {
			panic("rebuilt certificate is not the block's")
		}
		asIs("block "+b.name, b, h, cert)
		for _, at := range []int{0, 22, len(b.proof) / 2, len(b.proof) - 1} {
			p := append([]byte(nil), b.proof...)
			p[at] ^= 1
			resealed(fmt.Sprintf("block %s with proof byte %d flipped", b.name, at), b, 1, b.pd, p, &proofEdit{Flip: n(at)})
		}
		resealed("block "+b.name+" with its proof cut short", b, 1, b.pd, b.proof[:len(b.proof)-100], &proofEdit{Length: n(len(b.proof) - 100)})
		resealed("block "+b.name+" with an empty proof", b, 1, b.pd, []byte{}, &proofEdit{Length: n(0)})
		for _, size := range []int{60000, 60001, 62001} {
			p := make([]byte, size)
			copy(p, b.proof)
			resealed(fmt.Sprintf("block %s with its proof zero-padded to %d bytes", b.name, size), b, 1, b.pd, p, &proofEdit{Length: n(size)})
		}
		{
			pd := append([]byte(nil), b.pd...)
			pd[len(pd)-1] ^= 1
			resealed("block "+b.name+" with its last public data byte flipped", b, 1, pd, b.proof, nil)
		}
		{
			hh := b.header
			hh.Timestamp = hh.Timestamp.Add(time.Second)
			h, cert := build(b, 1, hh, b.pd, b.proof)
			asIs("block "+b.name+" on a header one second later", b, h, cert)
		}
		{
			hh := b.header
			hh.Bits = 0x1d00ffff
			h, cert := build(b, 1, hh, b.pd, b.proof)
			asIs("block "+b.name+" on a header with mainnet's starting bits", b, h, cert)
		}
		{
			_, cert := build(b, 1, b.header, b.pd, b.proof)
			hh := b.header
			hh.MerkleRoot[0] ^= 1
			asIs("block "+b.name+" on another merkle root, not resealed", b, hh, cert)
		}
		{
			_, cert := build(b, 1, b.header, b.pd, b.proof)
			hh := b.header
			hh.ProofCommitment[0] ^= 1
			asIs("block "+b.name+" with a wrong proof commitment", b, hh, cert)
			hh2, c2 := build(b, 1, hh, b.pd, b.proof)
			hh2.ProofCommitment[0] ^= 1
			c2.(*wire.CertificateV1).Hash = hh2.BlockHash()
			asIs("block "+b.name+" with a wrong proof commitment and the hash resealed", b, hh2, c2)
		}
		resealed("block "+b.name+" judged as V2", b, 2, b.pd, b.proof, nil)
		resealed("block "+b.name+" judged as V3", b, 3, b.pd, b.proof, nil)
		{
			pd := append([]byte(nil), b.pd...)
			zeroJackpot(pd)
			resealed("block "+b.name+" with a zero jackpot", b, 1, pd, b.proof, nil)
		}
	}

	// Proofs of the V2 and V3 verifiers, as V1 certificates.
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	var proofs struct {
		Proofs map[string]string `json:"proofs"`
		Cases  []struct {
			Name        string `json:"name"`
			Header      string `json:"header"`
			Certificate struct {
				PublicData string `json:"publicData"`
			} `json:"certificate"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &proofs); err != nil {
		panic(err)
	}
	for _, name := range []string{"V2 dense", "V3 dense"} {
		for _, c := range proofs.Cases {
			if c.Name != name {
				continue
			}
			hb, _ := hex.DecodeString(c.Header)
			var h wire.BlockHeader
			if err := h.Deserialize(bytes.NewReader(hb)); err != nil {
				panic(err)
			}
			pd, _ := hex.DecodeString(c.Certificate.PublicData)
			proof, _ := hex.DecodeString(proofs.Proofs[name])
			b := base{name: name, header: h, pd: pd, proof: proof}
			resealed(name+" judged as V1", b, 1, pd, proof, nil)
			break
		}
	}

	// Matrix sizes where m*k or n*k crosses 2^32, and patterns of 2^16 rows
	// and columns, so h*w is 2^32, each with the jackpot at 0.
	for _, b := range bases {
		for _, at := range []int{148, 152} {
			for _, v := range []uint32{1<<19 - 1, 1 << 19, 1<<19 + 1, 1 << 20, 1<<20 + 1, 1 << 21, 1 << 22, 3 << 21, 1 << 23, 1<<24 - 1, 1 << 24} {
				pd := append([]byte(nil), b.pd...)
				put32(pd, at, v)
				zeroJackpot(pd)
				resealed("", b, 1, pd, b.proof, nil)
			}
		}
		for _, k := range []uint32{8192, 16384, 32768, 65536} {
			pd := append([]byte(nil), b.pd...)
			put32(pd, 0, k)
			put32(pd, 148, 1<<24)
			put32(pd, 152, 1<<24)
			zeroJackpot(pd)
			resealed("", b, 1, pd, b.proof, nil)
		}
		for _, patterns := range [][12]byte{
			{0, 255, 1, 255, 0, 0, 0, 255, 1, 255, 0, 0},
			{0, 255, 1, 255, 0, 0, 0, 1, 0, 0, 0, 0},
			{0, 255, 1, 255, 1, 255, 0, 255, 1, 255, 0, 0},
			{0, 15, 0, 0, 0, 0, 0, 15, 0, 0, 0, 0},
		} {
			pd := append([]byte(nil), b.pd...)
			copy(pd[8:20], patterns[:])
			put32(pd, 148, 1<<24)
			put32(pd, 152, 1<<24)
			zeroJackpot(pd)
			resealed("", b, 1, pd, b.proof, nil)
		}
	}
	for i := 0; i < 1200; i++ {
		b := pick(bases)
		pd := mutate(b.pd)
		if rnd()%2 == 0 {
			zeroJackpot(pd)
		}
		resealed("", b, 1, pd, b.proof, nil)
	}

	reached := 0
	for _, c := range cases {
		if c.Error != nil && strings.Contains(*c.Error, "Proof Invalid") {
			reached++
		}
	}
	fmt.Fprintf(os.Stderr, "%d cases, %d rejected as Proof Invalid\n", len(cases), reached)
	out, _ := json.MarshalIndent(struct {
		Note  string     `json:"note"`
		Cases []caseJSON `json:"cases"`
	}{"Written by vectors/mining/proofs/v1/main.go; do not edit.", cases}, "", " ")
	os.Stdout.Write(append(out, '\n'))
}

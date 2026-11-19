// Differential vectors for the WebAssembly verifier: the certificates of
// vectors/mining/proofs.json with their public data changed, at random from a
// fixed seed and at the matrix sizes where a 32-bit usize would wrap, each
// judged by zkpow.VerifyZKProofFFI. The proof is the base certificate's own,
// so a statement that passes the checks before the proof reaches the
// verifier with a proof for another statement. The header is resealed to the
// changed certificate, as a miner would seal it.
//
//	go -C /path/to/pearl/node run -tags zkpow /path/to/pearljs/vectors/mining/proofs/differential/main.go \
//	  /path/to/pearljs/vectors/mining/proofs.json > /path/to/pearljs/vectors/mining/proofs-differential.json
package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
)

type baseJSON struct {
	Name        string `json:"name"`
	Header      string `json:"header"`
	Certificate struct {
		Version         uint32                `json:"version"`
		PublicData      string                `json:"publicData"`
		Proof           struct{ From string } `json:"proof"`
		AncestorHeaders []string              `json:"ancestorHeaders"`
	} `json:"certificate"`
	Bits  *uint32 `json:"bits"`
	Error *string `json:"error"`
}

type base struct {
	name      string
	header    wire.BlockHeader
	pd, proof []byte
	ancestors []wire.BlockHeader
}

// caseJSON stores the changed public data as its length and the byte runs
// that differ from the base's, which keeps the file small.
type caseJSON struct {
	Base    string   `json:"base"`
	Version uint32   `json:"version"`
	Bits    *uint32  `json:"bits"`
	Length  int      `json:"length"`
	Edits   [][2]any `json:"edits"`
	Error   *string  `json:"error"`
}

var seed uint32 = 1

func rnd() uint32 {
	seed ^= seed << 13
	seed ^= seed >> 17
	seed ^= seed << 5
	return seed
}

func pick[T any](xs []T) T { return xs[rnd()%uint32(len(xs))] }

func header(h string) wire.BlockHeader {
	b, _ := hex.DecodeString(h)
	var hd wire.BlockHeader
	if err := hd.Deserialize(bytes.NewReader(b)); err != nil {
		panic(err)
	}
	return hd
}

var (
	bitsList = []uint32{0x207fffff, 0x1d00ffff, 0, 0xffffffff, 0x00800000, 0x01003456, 0x03123456, 0x2100ffff, 0x22000001, 0x2200ffff, 0x24000001, 0x20800000, 0x1f00ffff}
	u32s     = []uint32{0, 1, 2, 15, 16, 31, 32, 63, 64, 128, 256, 512, 1023, 1024, 2048, 4096, 65536, 65537, 1<<21 - 1, 1 << 21, 1<<21 + 1, 1 << 22, 3 << 21, 1<<24 - 1, 1 << 24, 1<<24 + 1, 1 << 31, 1<<32 - 1}
	u16s     = []uint16{0, 1, 16, 32, 64, 96, 128, 256, 512, 1024, 2048, 0xffff}
)

func put32(pd []byte, at int, v uint32) {
	if at+4 <= len(pd) {
		binary.LittleEndian.PutUint32(pd[at:], v)
	}
}

func put16(pd []byte, at int, v uint16) {
	if at+2 <= len(pd) {
		binary.LittleEndian.PutUint16(pd[at:], v)
	}
}

func resize(pd []byte, n int) []byte {
	out := make([]byte, n)
	copy(out, pd)
	return out
}

// V2/V3 layout: k u32 at 0, rank u16 at 4, patterns at 8..20, experts and
// top_k at 20 and 22, jackpot at 116..148, m n t_rows t_cols at 148..164.
func mutateV23(pd []byte) []byte {
	pd = append([]byte(nil), pd...)
	for i, n := 0, 1+int(rnd()%3); i < n; i++ {
		switch rnd() % 8 {
		case 0:
			pd[rnd()%uint32(len(pd))] = byte(rnd())
		case 1:
			put32(pd, 0, pick(u32s))
		case 2:
			put16(pd, 4, pick(u16s))
		case 3:
			if at := 8 + int(rnd()%12); at < len(pd) {
				pd[at] = pick([]byte{0, 1, 2, 3, 7, 15, 31, 255})
			}
		case 4, 5:
			put32(pd, pick([]int{148, 152, 148, 152, 156, 160}), pick(u32s))
		case 6:
			pd = resize(pd, pick([]int{1, 52, 163, 165, 198, 199, 200, len(pd) - 1, len(pd) + 4}))
		case 7:
			if len(pd) > 164 {
				pd[164+rnd()%uint32(len(pd)-164)] = byte(rnd())
			} else {
				put16(pd, pick([]int{20, 22}), pick(u16s))
			}
		}
	}
	return pd
}

// V4 layout: ancestor header 0..108, k u32 at 108, r u16 at 112, quant 114,
// device 115, B {rows u32 116, hash id 120, tile u32 121}, experts u16 125,
// hash B, A {rows u32 159, hash id 163, tile u32 164}, then hash A, the tile
// bases at 200 and 204 and the jackpot, the last 32 bytes of a dense statement.
func mutateV4(pd []byte) []byte {
	pd = append([]byte(nil), pd...)
	for i, n := 0, 1+int(rnd()%3); i < n; i++ {
		switch rnd() % 7 {
		case 0:
			pd[108+rnd()%uint32(len(pd)-108)] = byte(rnd())
		case 1, 2:
			put32(pd, pick([]int{108, 116, 159, 116, 159, 121, 164}), pick(u32s))
		case 3:
			put16(pd, 112, pick(u16s))
		case 4:
			pd[pick([]int{114, 115, 120, 163})] = pick([]byte{0, 1, 2, 3, 4, 255})
		case 5:
			pd = resize(pd, pick([]int{239, 241, 300, 832, 833, len(pd) + 4}))
		case 6:
			put32(pd, pick([]int{200, 204}), pick(u32s))
		}
	}
	return pd
}

// zeroJackpot lets a statement past any target, so it reaches the proof.
func zeroJackpot(pd []byte, at int) {
	if at >= 0 && at+32 <= len(pd) {
		clear(pd[at : at+32])
	}
}

func build(b base, version uint32, pd []byte) (wire.BlockHeader, wire.BlockCertificate) {
	h := b.header
	var cert wire.BlockCertificate
	switch version {
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
		p.ProofData = b.proof
		h.ProofCommitment = cert.ProofCommitment()
		p.Hash = h.BlockHash()
	case 4:
		c := &wire.CertificateV4{PublicData: pd, ProofData: b.proof, AncestorHeaders: b.ancestors}
		h.ProofCommitment = c.ProofCommitment()
		c.Hash = h.BlockHash()
		cert = c
	}
	return h, cert
}

func edits(from, to []byte) [][2]any {
	out := [][2]any{}
	for i := 0; i < len(to); {
		if i < len(from) && from[i] == to[i] {
			i++
			continue
		}
		j := i
		for j < len(to) && (j >= len(from) || from[j] != to[j]) {
			j++
		}
		out = append(out, [2]any{i, hex.EncodeToString(to[i:j])})
		i = j
	}
	return out
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var file struct {
		Proofs map[string]string `json:"proofs"`
		Cases  []baseJSON        `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		panic(err)
	}
	bases := map[string]base{}
	for _, c := range file.Cases {
		if _, ok := file.Proofs[c.Name]; !ok || c.Error != nil || c.Bits != nil {
			continue
		}
		if _, seen := bases[c.Name]; seen {
			continue
		}
		pd, _ := hex.DecodeString(c.Certificate.PublicData)
		proof, _ := hex.DecodeString(file.Proofs[c.Certificate.Proof.From])
		b := base{name: c.Name, header: header(c.Header), pd: pd, proof: proof}
		for _, a := range c.Certificate.AncestorHeaders {
			b.ancestors = append(b.ancestors, header(a))
		}
		bases[c.Name] = b
	}

	var cases []caseJSON
	add := func(b base, version uint32, pd []byte, bits *uint32) {
		h, cert := build(b, version, pd)
		var msg *string
		if err := zkpow.VerifyZKProofFFI(&h, cert, bits); err != nil {
			s := err.Error()
			msg = &s
		}
		cases = append(cases, caseJSON{Base: b.name, Version: version, Bits: bits, Length: len(pd), Edits: edits(b.pd, pd), Error: msg})
	}
	u32 := func(v uint32) *uint32 { return &v }

	// Every matrix size where m*k, n*k or rows*k crosses 2^32 in the auditor's
	// findings and around it, with the jackpot at 0.
	v3 := bases["V3 dense"]
	for _, at := range []int{148, 152} {
		for _, v := range []uint32{1<<21 - 1, 1 << 21, 1<<21 + 1, 1<<21 + 64, 1 << 22, 1<<22 + 1, 3 << 21, 1 << 23, 1 << 24} {
			pd := append([]byte(nil), v3.pd...)
			put32(pd, at, v)
			zeroJackpot(pd, 116)
			add(v3, 3, pd, nil)
		}
	}
	// Tile patterns of 2^16 rows and columns, so h*w is 2^32.
	for _, patterns := range [][12]byte{
		{0, 255, 1, 255, 0, 0, 0, 255, 1, 255, 0, 0},
		{0, 255, 1, 255, 0, 0, 0, 1, 0, 0, 0, 0},
		{0, 255, 1, 255, 1, 255, 0, 255, 1, 255, 0, 0},
	} {
		pd := append([]byte(nil), v3.pd...)
		copy(pd[8:20], patterns[:])
		put32(pd, 148, 1<<24)
		put32(pd, 152, 1<<24)
		zeroJackpot(pd, 116)
		add(v3, 3, pd, nil)
	}
	for _, name := range []string{"V4 H100", "V4 B200"} {
		b := bases[name]
		for _, edit := range [][3]uint32{{116, 1 << 24, 0}, {159, 1 << 24, 0}, {159, 8323088, 0}, {116, 11862032, 0}, {116, 1 << 22, 0}, {116, 1 << 24, 65536}, {159, 1 << 24, 65536}, {116, 1<<22 + 1, 1024}} {
			pd := append([]byte(nil), b.pd...)
			put32(pd, int(edit[0]), edit[1])
			if edit[2] != 0 {
				put32(pd, 108, edit[2])
			}
			zeroJackpot(pd, len(pd)-32)
			add(b, 4, pd, nil)
		}
	}

	v23 := []base{bases["V2 dense"], bases["V3 dense"], bases["V3 MoE"]}
	for i := 0; i < 1500; i++ {
		b := pick(v23)
		pd := mutateV23(b.pd)
		if rnd()%2 == 0 {
			zeroJackpot(pd, 116)
		}
		var bits *uint32
		if rnd()%2 == 0 {
			bits = u32(pick(bitsList))
		}
		add(b, pick([]uint32{2, 3}), pd, bits)
	}
	v4 := []base{bases["V4 H100"], bases["V4 B200"]}
	for i := 0; i < 800; i++ {
		b := pick(v4)
		pd := mutateV4(b.pd)
		if rnd()%2 == 0 {
			zeroJackpot(pd, len(pd)-32)
		}
		var bits *uint32
		if rnd()%2 == 0 {
			bits = u32(pick(bitsList))
		}
		add(b, 4, pd, bits)
	}

	reached := 0
	for _, c := range cases {
		if c.Error != nil && bytes.Contains([]byte(*c.Error), []byte("Proof Invalid")) {
			reached++
		}
	}
	fmt.Fprintf(os.Stderr, "%d cases, %d rejected as Proof Invalid\n", len(cases), reached)
	out, _ := json.MarshalIndent(struct {
		Note  string     `json:"note"`
		Cases []caseJSON `json:"cases"`
	}{"Written by vectors/mining/proofs/differential/main.go; do not edit.", cases}, "", " ")
	os.Stdout.Write(append(out, '\n'))
}

// Plain-proof vectors: the proofs vectors/mining/plain/mine.rs mines, judged
// by zk-pow's own FFI entry points for pool shares, verify_plain_proof_ffi
// (certificate versions 1 to 3) and verify_plain_proof_v4_ffi, as mined and
// after one change at a time: share bits, header fields, the certificate
// version, the proof cut, extended or with bytes replaced, its size fields set
// past 32 bits, and random byte edits from a fixed seed. Pearl's Go code has no
// caller of either function, so this calls them through cgo the way a pool
// links them. The message is the FFI's, cut to the 127 bytes its buffer holds.
//
// With the zk-pow Go bindings built on Pearl's fp8-scheme branch:
//
//	P=/path/to/pearl/zk-pow/bindings/go
//	CGO_CFLAGS="-I$P" CGO_LDFLAGS="$P/target/release/libzk_pow_ffi.a -framework Security -lpthread -lm" \
//	  go run /path/to/pearljs/vectors/mining/plain/main.go plain-proofs.json \
//	  > /path/to/pearljs/vectors/mining/plain.json
package main

/*
#include <stdlib.h>
#include <string.h>
#include "zk_pow_ffi.h"
*/
import "C"

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"unsafe"
)

type base struct {
	Name        string `json:"name"`
	Header      string `json:"header"`
	CertVersion uint32 `json:"certVersion"`
	Proof       string `json:"proof"`
	header      []byte
	proof       []byte
}

// A case is its base's proof cut or zero-extended to Length (when set), then
// with each edit's bytes written at its offset, against Header (the base's
// unless set) at CertVersion and Bits (0: the header's own bits).
type caseJSON struct {
	Name        string   `json:"name,omitempty"`
	Base        string   `json:"base"`
	CertVersion uint32   `json:"certVersion"`
	Bits        uint32   `json:"bits"`
	Header      string   `json:"header,omitempty"`
	Length      *int     `json:"length,omitempty"`
	Edits       [][2]any `json:"edits,omitempty"`
	Code        int32    `json:"code"`
	Message     string   `json:"message"`
}

var seed uint32 = 11

func rnd() uint32 {
	seed ^= seed << 13
	seed ^= seed >> 17
	seed ^= seed << 5
	return seed
}

func pick[T any](xs []T) T { return xs[rnd()%uint32(len(xs))] }

func judge(header []byte, proof []byte, certVersion, bits uint32) (int32, string) {
	var errBuf [C.ERROR_MSG_MAX_SIZE]C.char
	// C memory, so an empty proof is a valid pointer with length 0, as a pool would pass it.
	pp := C.malloc(C.size_t(len(proof) + 1))
	defer C.free(pp)
	if len(proof) > 0 {
		C.memcpy(pp, unsafe.Pointer(&proof[0]), C.size_t(len(proof)))
	}
	var code C.int32_t
	if certVersion == 4 {
		h := C.CBytes(header)
		defer C.free(h)
		code = C.verify_plain_proof_v4_ffi((*C.uint8_t)(h), (*C.uint8_t)(pp), C.uintptr_t(len(proof)), C.uint32_t(bits), &errBuf[0])
	} else {
		// blockHeaderToC: the wire header with its hashes in display order.
		var ch C.IncompleteBlockHeader
		ch.version = C.uint32_t(binary.LittleEndian.Uint32(header[0:]))
		for i := 0; i < 32; i++ {
			ch.prev_block[i] = C.uint8_t(header[4+31-i])
			ch.merkle_root[i] = C.uint8_t(header[36+31-i])
		}
		ch.timestamp = C.uint32_t(binary.LittleEndian.Uint32(header[68:]))
		ch.nbits = C.uint32_t(binary.LittleEndian.Uint32(header[72:]))
		code = C.verify_plain_proof_ffi(&ch, (*C.uint8_t)(pp), C.uintptr_t(len(proof)), C.uint32_t(certVersion), C.uint32_t(bits), &errBuf[0])
	}
	return int32(code), C.GoString(&errBuf[0])
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var bases []*base
	if err := json.Unmarshal(raw, &bases); err != nil {
		panic(err)
	}
	for _, b := range bases {
		b.header, _ = hex.DecodeString(b.Header)
		b.proof, _ = hex.DecodeString(b.Proof)
	}

	var cases []caseJSON
	add := func(name string, b *base, certVersion, bits uint32, header []byte, length *int, edits [][2]any) {
		proof := append([]byte(nil), b.proof...)
		if length != nil {
			p := make([]byte, *length)
			copy(p, proof)
			proof = p
		}
		for _, e := range edits {
			d, _ := hex.DecodeString(e[1].(string))
			copy(proof[e[0].(int):], d)
		}
		h := b.header
		hs := ""
		if header != nil {
			h, hs = header, hex.EncodeToString(header)
		}
		code, msg := judge(h, proof, certVersion, bits)
		cases = append(cases, caseJSON{Name: name, Base: b.Name, CertVersion: certVersion, Bits: bits, Header: hs, Length: length, Edits: edits, Code: code, Message: msg})
	}
	n := func(v int) *int { return &v }
	u64 := func(v uint64) string {
		var x [8]byte
		binary.LittleEndian.PutUint64(x[:], v)
		return hex.EncodeToString(x[:])
	}
	withHeader := func(b *base, f func(h []byte)) []byte {
		h := append([]byte(nil), b.header...)
		f(h)
		return h
	}

	for _, b := range bases {
		v := b.CertVersion
		bits := binary.LittleEndian.Uint32(b.header[72:])
		add(b.Name, b, v, 0, nil, nil, nil)
		add(b.Name+" at its own bits", b, v, bits, nil, nil, nil)
		add(b.Name+" at mainnet's starting bits", b, v, 0x1d00ffff, nil, nil, nil)
		add(b.Name+" at bits 0x1b00ffff", b, v, 0x1b00ffff, nil, nil, nil)
		add(b.Name+" at bits 0x2100ffff", b, v, 0x2100ffff, nil, nil, nil)
		add(b.Name+" on a header with mainnet's starting bits", b, v, 0, withHeader(b, func(h []byte) { binary.LittleEndian.PutUint32(h[72:], 0x1d00ffff) }), nil, nil)
		add(b.Name+" on a header one second later", b, v, 0, withHeader(b, func(h []byte) { h[68]++ }), nil, nil)
		add(b.Name+" on another merkle root", b, v, 0, withHeader(b, func(h []byte) { h[36] ^= 1 }), nil, nil)
		add(b.Name+" on another previous block", b, v, 0, withHeader(b, func(h []byte) { h[4] ^= 1 }), nil, nil)
		add(b.Name+" on another version", b, v, 0, withHeader(b, func(h []byte) { h[0] ^= 1 }), nil, nil)
		for _, cv := range []uint32{0, 1, 2, 3, 4, 5} {
			if cv != v {
				add(fmt.Sprintf("%s as certificate version %d", b.Name, cv), b, cv, 0, nil, nil, nil)
			}
		}
		add(b.Name+" empty", b, v, 0, nil, n(0), nil)
		add(b.Name+" cut by one byte", b, v, 0, nil, n(len(b.proof)-1), nil)
		add(b.Name+" cut in half", b, v, 0, nil, n(len(b.proof)/2), nil)
		add(b.Name+" with a zero byte after it", b, v, 0, nil, n(len(b.proof)+1), nil)
		add(b.Name+" with 0xff after it", b, v, 0, nil, n(len(b.proof)+1), [][2]any{{len(b.proof), "ff"}})
		if v != 4 {
			// The legacy format: no MoE tag at the end.
			if b.proof[len(b.proof)-1] == 0 {
				add(b.Name+" in the legacy format, without its MoE tag", b, v, 0, nil, n(len(b.proof)-1), nil)
			}
			// m, n, k and noise_rank, each a u64 on the wire.
			for i, field := range []string{"m", "n", "k", "noise_rank"} {
				for _, value := range []uint64{0, 1, 1 << 16, 1<<24 + 1, 1 << 31, 1<<32 - 1, 1 << 32, 1<<32 + 1024, 1 << 40, 1<<64 - 1} {
					add(fmt.Sprintf("%s with %s %d", b.Name, field, value), b, v, 0, nil, nil, [][2]any{{8 * i, u64(value)}})
				}
			}
		}
		for _, at := range []int{0, 8, 16, 24, 32, 40, 64, 100, 200, len(b.proof) / 3, len(b.proof) / 2, len(b.proof) - 40, len(b.proof) - 1} {
			add(fmt.Sprintf("%s with byte %d flipped", b.Name, at), b, v, 0, nil, nil, [][2]any{{at, hex.EncodeToString([]byte{b.proof[at] ^ 1})}})
		}
	}
	// Random edits: a byte, or a u64 or u32 of a chosen size, anywhere, more often near the start.
	sizes := []uint64{0, 1, 2, 63, 64, 1024, 1 << 16, 1 << 20, 1 << 24, 1<<31 + 7, 1<<32 - 1, 1 << 32, 1 << 33, 1 << 40, 1<<63 + 5}
	for i := 0; i < 1500; i++ {
		b := pick(bases)
		var edits [][2]any
		for j, k := 0, 1+int(rnd()%2); j < k; j++ {
			limit := uint32(len(b.proof))
			if rnd()%2 == 0 {
				limit = min(limit, 400)
			}
			at := int(rnd() % limit)
			switch rnd() % 3 {
			case 0:
				edits = append(edits, [2]any{at, hex.EncodeToString([]byte{byte(rnd())})})
			case 1:
				if at+8 <= len(b.proof) {
					edits = append(edits, [2]any{at, u64(pick(sizes))})
				}
			case 2:
				if at+4 <= len(b.proof) {
					var x [4]byte
					binary.LittleEndian.PutUint32(x[:], uint32(pick(sizes)))
					edits = append(edits, [2]any{at, hex.EncodeToString(x[:])})
				}
			}
		}
		var bits uint32
		if rnd()%4 == 0 {
			bits = pick([]uint32{0x1d00ffff, 0x207fffff, 0x1b00ffff, 0x2200ffff, 1})
		}
		add("", b, b.CertVersion, bits, nil, nil, edits)
	}

	// MoE statements declaring sizes whose products pass 2^32, each tree's leaf
	// count set to match so the proof gets past the size check to the positions.
	for _, b := range bases {
		if b.CertVersion == 4 {
			continue
		}
		p := b.proof
		u := func(at int) uint64 { return binary.LittleEndian.Uint64(p[at:]) }
		// A MerkleProof in bincode: leaf_data, leaf_indices, total_leaves, root, siblings.
		merkle := func(at int) (leaves, end int) {
			n := int(u(at))
			at += 8
			for i := 0; i < n; i++ {
				at += 8 + int(u(at))
			}
			at += 8 + 8*int(u(at))
			leaves = at
			at += 8 + 32
			return leaves, at + 8 + 32*int(u(at))
		}
		aLeaves, at := merkle(32)
		at += 8 + 8*int(u(at))
		bLeaves, at := merkle(at)
		at += 8 + 8*int(u(at))
		if p[at] != 1 {
			continue
		}
		e, topK := u(at+1), u(at+9)
		expertAt := at + 17
		at = expertAt + 2
		at += 8 + 4*int(u(at))
		at += 8 + 8*int(u(at))
		routingLeaves, _ := merkle(at)
		m, n, k := u(0), u(8), u(16)
		leaves := func(bytes uint64) uint64 { return (bytes + 1023) / 1024 }
		sized := func(m, n uint64) [][2]any {
			return [][2]any{{0, u64(m)}, {8, u64(n)}, {aLeaves, u64(leaves(m * k))}, {bLeaves, u64(leaves(n * e * k))}, {routingLeaves, u64(leaves(m * topK * 4))}}
		}
		expert := func(w uint16) [2]any { return [2]any{expertAt, hex.EncodeToString([]byte{byte(w), byte(w >> 8)})} }
		for _, nn := range []uint64{1 << 30, 1 << 31, 1<<32 - 1} {
			add(fmt.Sprintf("%s declaring n %d", b.Name, nn), b, b.CertVersion, 0, nil, nil, sized(m, nn))
			for _, w := range []uint16{0, 1, uint16(e - 1)} {
				add(fmt.Sprintf("%s declaring n %d for expert %d", b.Name, nn, w), b, b.CertVersion, 0, nil, nil, append(sized(m, nn), expert(w)))
			}
		}
		for _, mm := range []uint64{1 << 30, 1 << 31, 1<<32 - 1} {
			add(fmt.Sprintf("%s declaring m %d", b.Name, mm), b, b.CertVersion, 0, nil, nil, sized(mm, n))
		}
	}

	counts := map[int32]int{}
	for _, c := range cases {
		counts[c.Code]++
	}
	fmt.Fprintf(os.Stderr, "%d cases, by code %v\n", len(cases), counts)
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", " ")
	if err := enc.Encode(struct {
		Note  string     `json:"note"`
		Bases []*base    `json:"bases"`
		Cases []caseJSON `json:"cases"`
	}{"Written by vectors/mining/plain/main.go; do not edit.", bases, cases}); err != nil {
		panic(err)
	}
	os.Stdout.Write(buf.Bytes())
}

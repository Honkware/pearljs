// Proof verification vectors: certificates mined by zk-pow's CPU miners
// (zkpow.Mine, MineMoE and MineV4, as pearld's own miner and tests call them),
// each judged by zkpow.VerifyZKProofFFI, the function pearld verifies blocks
// and shares with, unchanged and after one tampering at a time. The error text
// is pearld's, so the WebAssembly verifier's verdicts can be compared with it.
// It also times native verification of each valid certificate.
//
// Build against Pearl's fp8-scheme branch with the zk-pow Go bindings built:
//
//	PEARL_COMMIT=<sha> go -C /path/to/pearl/node run -tags zkpow /path/to/pearljs/vectors/mining/proofs/main.go \
//	  > /path/to/pearljs/vectors/mining/proofs.json
//
// check/main.go re-judges the V2 and V3 cases with a master build.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
)

// proofJSON names a mined certificate's proof and the one edit made to it:
// a byte flipped (xor 1) or the proof cut to a length. Mined proofs are listed
// once, under "proofs".
type proofJSON struct {
	From   string `json:"from"`
	Flip   *int   `json:"flip,omitempty"`
	Length *int   `json:"length,omitempty"`
}

type certJSON struct {
	Version         uint32    `json:"version"`
	Hash            string    `json:"hash"`
	PublicData      string    `json:"publicData"`
	Proof           proofJSON `json:"proof"`
	AncestorHeaders []string  `json:"ancestorHeaders,omitempty"`
}

type caseJSON struct {
	Name        string   `json:"name"`
	Header      string   `json:"header"`
	Certificate certJSON `json:"certificate"`
	Bits        *uint32  `json:"bits"`
	Error       *string  `json:"error"`
}

type timingJSON struct {
	Name         string  `json:"name"`
	Runs         int     `json:"runs"`
	Milliseconds float64 `json:"milliseconds"`
}

func headerHex(h *wire.BlockHeader) string {
	var buf bytes.Buffer
	if err := h.Serialize(&buf); err != nil {
		panic(err)
	}
	return hex.EncodeToString(buf.Bytes())
}

func encodeProof(proof []byte, base mined) proofJSON {
	from := base.cert.ProofBytes()
	out := proofJSON{From: base.name}
	switch {
	case bytes.Equal(proof, from):
	case len(proof) < len(from) && bytes.Equal(proof, from[:len(proof)]):
		n := len(proof)
		out.Length = &n
	case len(proof) == len(from):
		for i := range proof {
			if proof[i] != from[i] {
				if proof[i] != from[i]^1 || !bytes.Equal(proof[i+1:], from[i+1:]) {
					panic("proof differs by more than one flipped bit")
				}
				out.Flip = &i
				break
			}
		}
	default:
		panic("proof is not an edit of its mined proof")
	}
	return out
}

func encode(cert wire.BlockCertificate, base mined) certJSON {
	hash := cert.BlockHash()
	out := certJSON{
		Version:    uint32(cert.Version()),
		Hash:       hex.EncodeToString(hash[:]),
		PublicData: hex.EncodeToString(cert.PublicDataBytes()),
		Proof:      encodeProof(cert.ProofBytes(), base),
	}
	if v4, ok := cert.(*wire.CertificateV4); ok {
		for i := range v4.AncestorHeaders {
			out.AncestorHeaders = append(out.AncestorHeaders, headerHex(&v4.AncestorHeaders[i]))
		}
	}
	return out
}

// build makes a certificate of version v around public data and a proof, its
// ancestors for V4, and seals it to the header the way the miners do.
func build(v wire.CertificateVersion, header *wire.BlockHeader, publicData, proof []byte, ancestors []wire.BlockHeader) wire.BlockCertificate {
	var cert wire.BlockCertificate
	switch v {
	case wire.CertificateVersionV2, wire.CertificateVersionV3:
		var p *wire.CertificateV2
		if v == wire.CertificateVersionV2 {
			c := &wire.CertificateV2{}
			cert, p = c, c
		} else {
			c := &wire.CertificateV3{}
			cert, p = c, &c.CertificateV2
		}
		p.PublicDataLen = uint32(len(publicData))
		copy(p.PublicData[:], publicData)
		p.ProofData = proof
		header.ProofCommitment = cert.ProofCommitment()
		p.Hash = header.BlockHash()
	case wire.CertificateVersionV4:
		c := &wire.CertificateV4{PublicData: publicData, ProofData: proof, AncestorHeaders: ancestors}
		header.ProofCommitment = c.ProofCommitment()
		c.Hash = header.BlockHash()
		cert = c
	}
	return cert
}

// resealHash points a certificate at the header's hash and nothing else.
func resealHash(cert wire.BlockCertificate, header wire.BlockHeader) wire.BlockCertificate {
	hash := header.BlockHash()
	switch c := cert.(type) {
	case *wire.CertificateV2:
		c.Hash = hash
	case *wire.CertificateV3:
		c.Hash = hash
	case *wire.CertificateV4:
		c.Hash = hash
	}
	return cert
}

func clone(b []byte) []byte { return append([]byte(nil), b...) }

func ancestorsOf(cert wire.BlockCertificate) []wire.BlockHeader {
	if v4, ok := cert.(*wire.CertificateV4); ok {
		return v4.AncestorHeaders
	}
	return nil
}

type mined struct {
	name   string
	header wire.BlockHeader
	cert   wire.BlockCertificate
}

var cases []caseJSON

func judge(name string, base mined, header wire.BlockHeader, cert wire.BlockCertificate, bits *uint32) {
	var errText *string
	if err := zkpow.VerifyZKProofFFI(&header, cert, bits); err != nil {
		s := err.Error()
		errText = &s
	}
	cases = append(cases, caseJSON{Name: name, Header: headerHex(&header), Certificate: encode(cert, base), Bits: bits, Error: errText})
}

func u32(v uint32) *uint32 { return &v }

func tamper(m mined) {
	h := m.header
	v := m.cert.Version()
	pd, proof, anc := m.cert.PublicDataBytes(), m.cert.ProofBytes(), ancestorsOf(m.cert)

	judge(m.name, m, h, m.cert, nil)
	judge(m.name+" judged at its own bits", m, h, m.cert, u32(h.Bits))
	judge(m.name+" judged at mainnet's starting bits", m, h, m.cert, u32(0x1d00ffff))

	for _, at := range []int{0, 22, len(proof) / 2, len(proof) - 1} {
		p := clone(proof)
		p[at] ^= 1
		hh := h
		judge(fmt.Sprintf("%s with proof byte %d flipped", m.name, at), m, hh, build(v, &hh, clone(pd), p, anc), nil)
	}
	{
		p := clone(pd)
		p[len(p)-1] ^= 1
		hh := h
		judge(m.name+" with its last public data byte flipped", m, hh, build(v, &hh, p, clone(proof), anc), nil)
	}
	{
		hh := h
		hh.Timestamp = hh.Timestamp.Add(time.Second)
		judge(m.name+" on a header one second later", m, hh, build(v, &hh, clone(pd), clone(proof), anc), nil)
	}
	{
		hh := h
		hh.MerkleRoot[0] ^= 1
		judge(m.name+" on another merkle root, not resealed", m, hh, m.cert, nil)
	}
	{
		hh := h
		hh.Bits = 0x1d00ffff
		judge(m.name+" on a header with mainnet's starting bits", m, hh, build(v, &hh, clone(pd), clone(proof), anc), nil)
	}
	{
		hh := h
		hh.ProofCommitment[0] ^= 1
		judge(m.name+" with a wrong proof commitment", m, hh, m.cert, nil)
		c := build(v, &hh, clone(pd), clone(proof), anc)
		hh.ProofCommitment[0] ^= 1
		judge(m.name+" with a wrong proof commitment and the hash resealed", m, hh, resealHash(c, hh), nil)
	}
	{
		hh := h
		judge(m.name+" with an empty proof", m, hh, build(v, &hh, clone(pd), []byte{}, anc), nil)
	}
	{
		hh := h
		judge(m.name+" with its proof cut short", m, hh, build(v, &hh, clone(pd), clone(proof[:len(proof)-100]), anc), nil)
	}
	switch v {
	case wire.CertificateVersionV2:
		hh := h
		judge(m.name+" judged as V3", m, hh, build(wire.CertificateVersionV3, &hh, clone(pd), clone(proof), nil), nil)
	case wire.CertificateVersionV3:
		hh := h
		judge(m.name+" judged as V2", m, hh, build(wire.CertificateVersionV2, &hh, clone(pd), clone(proof), nil), nil)
		hh = h
		judge(m.name+" judged as V4", m, hh, build(wire.CertificateVersionV4, &hh, clone(pd), clone(proof), nil), nil)
	case wire.CertificateVersionV4:
		hh := h
		judge(m.name+" judged as V3", m, hh, build(wire.CertificateVersionV3, &hh, clone(pd), clone(proof), nil), nil)
		hh = h
		parent := wire.BlockHeader{Bits: 0x207fffff, Timestamp: time.Unix(1, 0)}
		judge(m.name+" with an ancestor header it does not need", m, hh, build(v, &hh, clone(pd), clone(proof), []wire.BlockHeader{parent}), nil)
	}
}

func timeIt(m mined, runs int) timingJSON {
	h := m.header
	if err := zkpow.VerifyZKProofFFI(&h, m.cert, nil); err != nil {
		panic(fmt.Sprintf("%s does not verify: %v", m.name, err))
	}
	start := time.Now()
	for range runs {
		if err := zkpow.VerifyZKProofFFI(&h, m.cert, nil); err != nil {
			panic(err)
		}
	}
	return timingJSON{Name: m.name, Runs: runs, Milliseconds: float64(time.Since(start).Microseconds()) / 1000 / float64(runs)}
}

func main() {
	var all []mined
	for i, v := range []wire.CertificateVersion{wire.CertificateVersionV2, wire.CertificateVersionV3} {
		h := wire.BlockHeader{Version: 1, Bits: 0x207fffff, Timestamp: time.Unix(1_760_000_000+int64(i), 0)}
		h.PrevBlock[0] = byte(i + 1)
		h.MerkleRoot[0] = byte(i + 7)
		cert, err := zkpow.Mine(&h, v)
		if err != nil {
			panic(err)
		}
		all = append(all, mined{fmt.Sprintf("V%d dense", v), h, cert})
	}
	{
		h := wire.BlockHeader{Version: 1, Bits: 0x207fffff, Timestamp: time.Unix(1_760_000_100, 0)}
		h.PrevBlock[0] = 9
		cert, err := zkpow.MineMoE(&h, 1024, 256, 4, 2, wire.CertificateVersionV3)
		if err != nil {
			panic(err)
		}
		all = append(all, mined{"V3 MoE", h, cert})
	}
	for device, name := range []string{"H100", "B200"} {
		parent := wire.BlockHeader{Version: 1, Bits: 0x207fffff, Timestamp: time.Unix(1_760_000_200+int64(device), 0)}
		h := wire.BlockHeader{Version: 1, PrevBlock: parent.BlockHash(), Bits: 0x207fffff, Timestamp: parent.Timestamp.Add(time.Minute)}
		h.MerkleRoot[0] = byte(device + 3)
		cert, err := zkpow.MineV4(&h, &parent, device)
		if err != nil {
			panic(err)
		}
		all = append(all, mined{"V4 " + name, h, cert})
	}
	var timings []timingJSON
	for _, m := range all {
		tamper(m)
		timings = append(timings, timeIt(m, 10))
	}
	proofs := map[string]string{}
	for _, m := range all {
		proofs[m.name] = hex.EncodeToString(m.cert.ProofBytes())
	}
	out := map[string]any{"commit": os.Getenv("PEARL_COMMIT"), "proofs": proofs, "cases": cases, "nativeTimings": timings}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		panic(err)
	}
}

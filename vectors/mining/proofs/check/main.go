// Re-judges the V2 and V3 cases of vectors/mining/proofs.json with
// zkpow.VerifyZKProofFFI from another Pearl build, master in practice, and
// reports any verdict or message that differs from the fp8-scheme branch's:
//
//	go -C /path/to/pearl/node run -tags zkpow /path/to/pearljs/vectors/mining/proofs/check/main.go \
//	  /path/to/pearljs/vectors/mining/proofs.json
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"

	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
)

type caseJSON struct {
	Name        string `json:"name"`
	Header      string `json:"header"`
	Certificate struct {
		Version    uint32 `json:"version"`
		Hash       string `json:"hash"`
		PublicData string `json:"publicData"`
		Proof      struct {
			From   string `json:"from"`
			Flip   *int   `json:"flip"`
			Length *int   `json:"length"`
		} `json:"proof"`
	} `json:"certificate"`
	Bits  *uint32 `json:"bits"`
	Error *string `json:"error"`
}

func main() {
	check(os.Args[1])
}

func check(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		panic(err)
	}
	var file struct {
		Proofs map[string]string `json:"proofs"`
		Cases  []caseJSON        `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		panic(err)
	}
	same, differ := 0, 0
	for _, c := range file.Cases {
		if c.Certificate.Version == 4 {
			continue
		}
		hb, _ := hex.DecodeString(c.Header)
		var h wire.BlockHeader
		if err := h.Deserialize(bytes.NewReader(hb)); err != nil {
			panic(err)
		}
		pd, _ := hex.DecodeString(c.Certificate.PublicData)
		proof, _ := hex.DecodeString(file.Proofs[c.Certificate.Proof.From])
		if f := c.Certificate.Proof.Flip; f != nil {
			proof[*f] ^= 1
		}
		if n := c.Certificate.Proof.Length; n != nil {
			proof = proof[:*n]
		}
		hashBytes, _ := hex.DecodeString(c.Certificate.Hash)
		var cert wire.BlockCertificate
		var p *wire.CertificateV2
		if c.Certificate.Version == 2 {
			x := &wire.CertificateV2{}
			cert, p = x, x
		} else {
			x := &wire.CertificateV3{}
			cert, p = x, &x.CertificateV2
		}
		p.PublicDataLen = uint32(len(pd))
		copy(p.PublicData[:], pd)
		p.ProofData = proof
		copy(p.Hash[:], hashBytes)
		var got *string
		if err := zkpow.VerifyZKProofFFI(&h, cert, c.Bits); err != nil {
			s := err.Error()
			got = &s
		}
		if (got == nil) != (c.Error == nil) || (got != nil && *got != *c.Error) {
			differ++
			fmt.Printf("DIFFERS %s: fp8 %v, this build %v\n", c.Name, deref(c.Error), deref(got))
		} else {
			same++
		}
	}
	fmt.Printf("%d V2 and V3 cases judged the same, %d differ\n", same, differ)
	if differ > 0 {
		os.Exit(1)
	}
}

func deref(s *string) string {
	if s == nil {
		return "accepted"
	}
	return *s
}

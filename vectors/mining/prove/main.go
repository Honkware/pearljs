// A prover for the live mining test: zkpow.Mine, the function pearld's own
// miner proves blocks with, run on a header pearljs assembled. It reads the
// header's 108-byte hex (the proof commitment is overwritten) and a
// certificate version from its arguments and prints the certificate's public
// data and proof as hex, one per line. Build it from a Pearl source checkout
// whose zk-pow Go bindings are built:
//
//	go -C /path/to/pearl/node build -tags zkpow -o /path/to/pearljs-prove /path/to/pearljs/vectors/mining/prove/main.go
//
// and point PEARL_PROVER at the binary when running test/live/mining.test.ts.
package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"

	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/node/zkpow"
)

func main() {
	raw, err := hex.DecodeString(os.Args[1])
	if err != nil {
		panic(err)
	}
	version, err := strconv.Atoi(os.Args[2])
	if err != nil {
		panic(err)
	}
	var header wire.BlockHeader
	if err := header.Deserialize(bytes.NewReader(raw)); err != nil {
		panic(err)
	}
	cert, err := zkpow.Mine(&header, wire.CertificateVersion(version))
	if err != nil {
		panic(err)
	}
	fmt.Println(hex.EncodeToString(cert.PublicDataBytes()))
	fmt.Println(hex.EncodeToString(cert.ProofBytes()))
}

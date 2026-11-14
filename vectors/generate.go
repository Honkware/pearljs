// Run with a Pearl source checkout:
// go -C /path/to/pearl/node run /path/to/pearljs/vectors/generate.go -out /path/to/pearljs/vectors/pearl-go.json
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/pearl-research-labs/pearl/node/blockchain"
	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcec/schnorr"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/btcutil/hdkeychain"
	"github.com/pearl-research-labs/pearl/node/btcutil/psbt"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
)

type NetworkVector struct {
	Name           string `json:"name"`
	Magic          uint32 `json:"magic"`
	DefaultPort    int    `json:"defaultPort"`
	Bech32HRP      string `json:"bech32Hrp"`
	WIF            byte   `json:"wif"`
	HDPrivateKeyID uint32 `json:"hdPrivateKeyId"`
	HDPublicKeyID  uint32 `json:"hdPublicKeyId"`
	CoinType       uint32 `json:"coinType"`
	GenesisHash    string `json:"genesisHash"`
}

type AddressVector struct {
	Network string `json:"network"`
	Kind    string `json:"kind"`
	Program string `json:"program"`
	Address string `json:"address"`
	Script  string `json:"script"`
}

type ChildVector struct {
	Path           string `json:"path"`
	InternalPubKey string `json:"internalPubKey"`
	Address        string `json:"address"`
}

type BIP86Vector struct {
	Seed        string        `json:"seed"`
	Network     string        `json:"network"`
	AccountPath string        `json:"accountPath"`
	AccountXPub string        `json:"accountXpub"`
	Children    []ChildVector `json:"children"`
}

type TransactionVector struct {
	Name         string `json:"name"`
	Hex          string `json:"hex"`
	NoWitnessHex string `json:"noWitnessHex"`
	TxID         string `json:"txid"`
	WTxID        string `json:"wtxid"`
}

type SighashVector struct {
	HashType uint32 `json:"hashType"`
	Hash     string `json:"hash"`
}

type PSBTVector struct {
	Base64        string `json:"base64"`
	UnsignedTxHex string `json:"unsignedTxHex"`
}

type SigningVector struct {
	Name              string `json:"name"`
	Path              string `json:"path"`
	Change            bool   `json:"change"`
	Index             uint32 `json:"index"`
	Value             int64  `json:"value"`
	HashType          uint32 `json:"hashType"`
	MasterFingerprint string `json:"masterFingerprint"`
	InternalPubKey    string `json:"internalPubKey"`
	TweakedPubKey     string `json:"tweakedPubKey"`
	Sighash           string `json:"sighash"`
	Signature         string `json:"signature"`
	UnsignedTxHex     string `json:"unsignedTxHex"`
	PreparedPSBT      string `json:"preparedPsbt"`
	SignedPSBT        string `json:"signedPsbt"`
	FinalPSBT         string `json:"finalPsbt"`
	FinalTxHex        string `json:"finalTxHex"`
	TxID              string `json:"txid"`
}

type BlockHeaderVector struct {
	Name      string `json:"name"`
	Hex       string `json:"hex"`
	Hash      string `json:"hash"`
	Version   int32  `json:"version"`
	Timestamp uint32 `json:"timestamp"`
	Bits      uint32 `json:"bits"`
}

type ClassificationVector struct {
	Name      string `json:"name"`
	Hex       string `json:"hex"`
	ClassName string `json:"className"`
}

type PushVector struct {
	Name   string `json:"name"`
	Data   string `json:"data"`
	Script string `json:"script"`
}

type ScriptNumberVector struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Script string `json:"script"`
}

type TapLeafVector struct {
	Name   string `json:"name"`
	Script string `json:"script"`
	Hash   string `json:"hash"`
}

type TapBranchVector struct {
	Name  string `json:"name"`
	Left  string `json:"left"`
	Right string `json:"right"`
	Hash  string `json:"hash"`
}

type ScriptVectors struct {
	Classifications []ClassificationVector `json:"classifications"`
	Pushes          []PushVector           `json:"pushes"`
	ScriptNumbers   []ScriptNumberVector   `json:"scriptNumbers"`
	TapLeaves       []TapLeafVector        `json:"tapLeaves"`
	TapBranches     []TapBranchVector      `json:"tapBranches"`
}

type ScriptTreeLeafVector struct {
	Script              string `json:"script"`
	LeafHash            string `json:"leafHash"`
	Proof               string `json:"proof"`
	TaprootControlBlock string `json:"taprootControlBlock"`
	P2MRControlBlock    string `json:"p2mrControlBlock"`
}

type ScriptTreeVector struct {
	Name             string                 `json:"name"`
	InternalPubKey   string                 `json:"internalPubKey"`
	Root             string                 `json:"root"`
	TaprootOutputKey string                 `json:"taprootOutputKey"`
	TaprootAddress   string                 `json:"taprootAddress"`
	P2MRAddress      string                 `json:"p2mrAddress"`
	Leaves           []ScriptTreeLeafVector `json:"leaves"`
}

type PrevoutVector struct {
	Script string `json:"script"`
	Value  int64  `json:"value"`
}

type ScriptPathSpendVector struct {
	Name          string          `json:"name"`
	Kind          string          `json:"kind"`
	LeafCount     int             `json:"leafCount"`
	LeafIndex     int             `json:"leafIndex"`
	SignerPath    string          `json:"signerPath"`
	HashType      uint32          `json:"hashType"`
	InputIndex    int             `json:"inputIndex"`
	Prevouts      []PrevoutVector `json:"prevouts"`
	Value         int64           `json:"value"`
	PrevScript    string          `json:"prevScript"`
	LeafScript    string          `json:"leafScript"`
	LeafHash      string          `json:"leafHash"`
	ControlBlock  string          `json:"controlBlock"`
	UnsignedTxHex string          `json:"unsignedTxHex"`
	Sighash       string          `json:"sighash"`
	Signature     string          `json:"signature"`
	FinalTxHex    string          `json:"finalTxHex"`
	TxID          string          `json:"txid"`
	WTxID         string          `json:"wtxid"`
	PreparedPSBT  string          `json:"preparedPsbt,omitempty"`
	FinalPSBT     string          `json:"finalPsbt,omitempty"`
}

type Vectors struct {
	Source           string                  `json:"source"`
	Networks         []NetworkVector         `json:"networks"`
	Addresses        []AddressVector         `json:"addresses"`
	BIP86            BIP86Vector             `json:"bip86"`
	Transactions     []TransactionVector     `json:"transactions"`
	PSBT             PSBTVector              `json:"psbt"`
	Sighashes        []SighashVector         `json:"sighashes"`
	Signing          []SigningVector         `json:"signing"`
	BlockHeaders     []BlockHeaderVector     `json:"blockHeaders"`
	Scripts          ScriptVectors           `json:"scripts"`
	ScriptTrees      []ScriptTreeVector      `json:"scriptTrees"`
	ScriptPathSpends []ScriptPathSpendVector `json:"scriptPathSpends"`
	Blocks           []BlockVector           `json:"blocks"`
	BadBlocks        []BadBlockVector        `json:"badBlocks"`
}

type BlockVector struct {
	Name                   string   `json:"name"`
	Hex                    string   `json:"hex"`
	Hash                   string   `json:"hash"`
	CertificateVersion     uint32   `json:"certificateVersion"`
	CertificateHex         string   `json:"certificateHex"`
	ProofCommitment        string   `json:"proofCommitment"`
	IsMoE                  bool     `json:"isMoE"`
	CertificateHashMatches bool     `json:"certificateHashMatches"`
	CommitmentMatches      bool     `json:"commitmentMatches"`
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

func serializeBlock(block *wire.MsgBlock) []byte {
	var buf bytes.Buffer
	check(block.Serialize(&buf))
	return buf.Bytes()
}

// makeBlockVector records what Pearl itself computes for a block, so the
// TypeScript side is compared against the node instead of against itself.
func makeBlockVector(name string, block *wire.MsgBlock) BlockVector {
	raw := serializeBlock(block)
	var decoded wire.MsgBlock
	check(decoded.Deserialize(bytes.NewReader(raw)))
	if !bytes.Equal(serializeBlock(&decoded), raw) {
		panic(name + ": block does not round-trip")
	}
	utilBlock := btcutil.NewBlock(block)
	header := block.BlockHeader()
	vector := BlockVector{
		Name: name, Hex: hex.EncodeToString(raw), Hash: header.BlockHash().String(),
		MerkleRoot:        blockchain.CalcMerkleRoot(utilBlock.Transactions(), false).String(),
		WitnessMerkleRoot: blockchain.CalcMerkleRoot(utilBlock.Transactions(), true).String(),
		Size:              block.SerializeSize(), StrippedSize: block.SerializeSizeStripped(),
		NoWitnessSize: block.SerializeSizeNoWitness(), Vsize: blockchain.GetBlockVsize(utilBlock),
	}
	for _, tx := range block.Transactions {
		vector.TxIDs = append(vector.TxIDs, tx.TxID())
	}
	if err := blockchain.ValidateWitnessCommitment(utilBlock); err != nil {
		vector.WitnessError = err.Error()
	}
	var certBuf bytes.Buffer
	check(block.MsgHeader.MsgCertificate.PrlEncode(&certBuf, 0))
	vector.CertificateHex = hex.EncodeToString(certBuf.Bytes())
	if cert := block.BlockCertificate(); cert != nil {
		blockHash, commitment := header.BlockHash(), cert.ProofCommitment()
		certHash := cert.BlockHash()
		vector.CertificateVersion = uint32(cert.Version())
		vector.ProofCommitment = hex.EncodeToString(commitment[:])
		vector.IsMoE = cert.IsMoE()
		vector.CertificateHashMatches = certHash == blockHash
		vector.CommitmentMatches = header.ProofCommitment == commitment
	}
	return vector
}

// coinbaseTx pays to payScript and, when txs carry witnesses, commits to them
// the way Pearl's miner does: a 32-byte witness nonce and an OP_RETURN output
// with the witness magic bytes.
func coinbaseTx(height int64, payScript []byte, withNonce bool) *wire.MsgTx {
	tx := wire.NewMsgTx(wire.TxVersion)
	sigScript, err := txscript.NewScriptBuilder().AddInt64(height).AddData([]byte("pearljs")).Script()
	check(err)
	in := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{}, wire.MaxPrevOutIndex), sigScript, nil)
	if withNonce {
		in.SetWitness(wire.TxWitness{make([]byte, blockchain.CoinbaseWitnessDataLen)})
	}
	tx.AddTxIn(in)
	tx.AddTxOut(wire.NewTxOut(5_000_000_000, payScript))
	return tx
}

func addWitnessCommitment(block *wire.MsgBlock, corrupt bool) {
	coinbase := block.Transactions[0]
	nonce := coinbase.TxIn[0].DecodeWitness()[0]
	txs := btcutil.NewBlock(block).Transactions()
	root := blockchain.CalcMerkleRoot(txs, true)
	commitment := chainhash.DoubleHashB(append(root[:], nonce...))
	if corrupt {
		commitment[0] ^= 0xff
	}
	script := append(append([]byte{}, blockchain.WitnessMagicBytes...), commitment...)
	coinbase.AddTxOut(wire.NewTxOut(0, script))
}

// sealBlock fills in the merkle root and, given a certificate, binds header
// and certificate the way Pearl's verifier expects: the header carries the
// certificate's proof commitment and the certificate carries the header hash.
func sealBlock(block *wire.MsgBlock, cert wire.BlockCertificate) {
	header := block.BlockHeader()
	header.MerkleRoot = blockchain.CalcMerkleRoot(btcutil.NewBlock(block).Transactions(), false)
	if cert == nil {
		block.MsgHeader.MsgCertificate.Certificate = nil
		return
	}
	header.ProofCommitment = cert.ProofCommitment()
	hash := header.BlockHash()
	switch c := cert.(type) {
	case *wire.CertificateV1:
		c.Hash = hash
	case *wire.CertificateV2:
		c.Hash = hash
	case *wire.CertificateV3:
		c.Hash = hash
	}
	block.MsgHeader.MsgCertificate.Certificate = cert
}

func patternBytes(n int, seed byte) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = seed + byte(i)
	}
	return out
}

// leafKeyScripts returns n tapscript leaves, leaf i being
// <x-only key of account/0/i> OP_CHECKSIG, plus the keys that sign them.
func leafKeyScripts(account *hdkeychain.ExtendedKey, n int) ([]txscript.TapLeaf, []*btcec.PrivateKey) {
	leaves := make([]txscript.TapLeaf, n)
	keys := make([]*btcec.PrivateKey, n)
	for i := 0; i < n; i++ {
		priv, err := derive(account, 0, uint32(i)).ECPrivKey()
		check(err)
		script, err := txscript.NewScriptBuilder().
			AddData(schnorr.SerializePubKey(priv.PubKey())).
			AddOp(txscript.OP_CHECKSIG).
			Script()
		check(err)
		leaves[i] = txscript.NewBaseTapLeaf(script)
		keys[i] = priv
	}
	return leaves, keys
}

// verifyInputs runs Pearl's script engine over every input so a vector is
// only written when consensus accepts the whole transaction.
func verifyInputs(tx *wire.MsgTx, prevOuts []*wire.TxOut) {
	fetcher := txscript.NewMultiPrevOutFetcher(nil)
	for i, txIn := range tx.TxIn {
		fetcher.AddPrevOut(txIn.PreviousOutPoint, prevOuts[i])
	}
	sigHashes := txscript.NewTxSigHashes(tx, fetcher)
	for i, prevOut := range prevOuts {
		engine, err := txscript.NewEngine(
			prevOut.PkScript, tx, i, txscript.StandardVerifyFlags, nil,
			sigHashes, prevOut.Value, fetcher,
		)
		check(err)
		check(engine.Execute())
	}
}

func check(err error) {
	if err != nil {
		panic(err)
	}
}

func serializeTx(tx *wire.MsgTx, witness bool) string {
	var buf bytes.Buffer
	var err error
	if witness {
		err = tx.Serialize(&buf)
	} else {
		err = tx.SerializeNoWitness(&buf)
	}
	check(err)
	return hex.EncodeToString(buf.Bytes())
}

func derive(key *hdkeychain.ExtendedKey, path ...uint32) *hdkeychain.ExtendedKey {
	var err error
	for _, index := range path {
		key, err = key.Derive(index)
		check(err)
	}
	return key
}

func encodePSBT(packet *psbt.Packet) string {
	encoded, err := packet.B64Encode()
	check(err)
	return encoded
}

func makeHeaderVector(name string, header *wire.BlockHeader) BlockHeaderVector {
	var buf bytes.Buffer
	check(header.Serialize(&buf))
	return BlockHeaderVector{
		Name: name, Hex: hex.EncodeToString(buf.Bytes()), Hash: header.BlockHash().String(),
		Version: header.Version, Timestamp: uint32(header.Timestamp.Unix()), Bits: header.Bits,
	}
}

func main() {
	out := flag.String("out", "vectors/pearl-go.json", "output JSON path")
	flag.Parse()

	nets := []*chaincfg.Params{
		&chaincfg.MainNetParams,
		&chaincfg.TestNetParams,
		&chaincfg.TestNet2Params,
		&chaincfg.RegressionNetParams,
		&chaincfg.SimNetParams,
	}
	vectors := Vectors{Source: "github.com/pearl-research-labs/pearl"}
	for _, net := range nets {
		vectors.Networks = append(vectors.Networks, NetworkVector{
			Name: net.Name, Magic: uint32(net.Net), DefaultPort: mustPort(net.DefaultPort),
			Bech32HRP: net.Bech32HRPSegwit, WIF: net.PrivateKeyID,
			HDPrivateKeyID: binaryUint32(net.HDPrivateKeyID),
			HDPublicKeyID:  binaryUint32(net.HDPublicKeyID), CoinType: net.HDCoinType,
			GenesisHash: net.GenesisHash.String(),
		})
		for _, item := range []struct {
			kind    string
			program byte
		}{{"p2tr", 0x11}, {"p2mr", 0x22}} {
			program := bytes.Repeat([]byte{item.program}, 32)
			var addr btcutil.Address
			var err error
			if item.kind == "p2tr" {
				addr, err = btcutil.NewAddressTaproot(program, net)
			} else {
				addr, err = btcutil.NewAddressMerkleRoot(program, net)
			}
			check(err)
			script, err := txscript.PayToAddrScript(addr)
			check(err)
			vectors.Addresses = append(vectors.Addresses, AddressVector{
				Network: net.Name, Kind: item.kind, Program: hex.EncodeToString(program),
				Address: addr.String(), Script: hex.EncodeToString(script),
			})
		}
		vectors.BlockHeaders = append(vectors.BlockHeaders, makeHeaderVector(
			net.Name+"-genesis", &net.GenesisBlock.MsgHeader.BlockHeader,
		))
	}

	vectors.BlockHeaders = append(vectors.BlockHeaders, makeHeaderVector("edge-values", &wire.BlockHeader{
		Version: -1, Timestamp: time.Unix(0xffffffff, 0), Bits: 0xffffffff,
		PrevBlock: chainhash.Hash{0x01}, MerkleRoot: chainhash.Hash{0x02},
		ProofCommitment: chainhash.Hash{0x03},
	}))

	classify := func(name string, script []byte) {
		vectors.Scripts.Classifications = append(vectors.Scripts.Classifications, ClassificationVector{
			Name: name, Hex: hex.EncodeToString(script), ClassName: txscript.GetScriptClass(script).String(),
		})
	}
	classify("empty", nil)
	classify("p2pkh", append([]byte{txscript.OP_DUP, txscript.OP_HASH160, 20}, append(bytes.Repeat([]byte{0x42}, 20), txscript.OP_EQUALVERIFY, txscript.OP_CHECKSIG)...))
	classify("p2tr", append([]byte{txscript.OP_1, 32}, bytes.Repeat([]byte{0x11}, 32)...))
	classify("p2mr", append([]byte{txscript.OP_2, 32}, bytes.Repeat([]byte{0x22}, 32)...))
	classify("nulldata-non-push", []byte{txscript.OP_RETURN, txscript.OP_RETURN})
	classify("nulldata-large", append([]byte{txscript.OP_RETURN, txscript.OP_PUSHDATA1, 81}, bytes.Repeat([]byte{0x33}, 81)...))
	classify("witness-v0", append([]byte{txscript.OP_0, 20}, bytes.Repeat([]byte{0x44}, 20)...))

	for _, item := range []struct {
		name string
		data []byte
	}{
		{"empty", nil}, {"zero", []byte{0}}, {"one", []byte{1}}, {"sixteen", []byte{16}},
		{"seventeen", []byte{17}}, {"negative-one", []byte{0x81}},
		{"direct-75", bytes.Repeat([]byte{0x42}, 75)}, {"pushdata1-76", bytes.Repeat([]byte{0x43}, 76)},
		{"pushdata2-520", bytes.Repeat([]byte{0x44}, 520)},
	} {
		script, err := txscript.NewScriptBuilder().AddData(item.data).Script()
		check(err)
		vectors.Scripts.Pushes = append(vectors.Scripts.Pushes, PushVector{
			Name: item.name, Data: hex.EncodeToString(item.data), Script: hex.EncodeToString(script),
		})
	}
	for _, value := range []int64{-1, 0, 1, 16, 17, -17, 127, 128, -128, -129, 500000000, 4294967295} {
		script, err := txscript.NewScriptBuilder().AddInt64(value).Script()
		check(err)
		vectors.Scripts.ScriptNumbers = append(vectors.Scripts.ScriptNumbers, ScriptNumberVector{
			Name: fmt.Sprintf("number-%d", value), Value: fmt.Sprintf("%d", value), Script: hex.EncodeToString(script),
		})
	}
	leafOne := txscript.NewBaseTapLeaf([]byte{txscript.OP_1})
	leafTwo := txscript.NewBaseTapLeaf([]byte{txscript.OP_CAT})
	for _, item := range []struct {
		name string
		leaf txscript.TapLeaf
	}{{"one", leafOne}, {"cat", leafTwo}} {
		hash := item.leaf.TapHash()
		vectors.Scripts.TapLeaves = append(vectors.Scripts.TapLeaves, TapLeafVector{
			Name: item.name, Script: hex.EncodeToString(item.leaf.Script), Hash: hex.EncodeToString(hash[:]),
		})
	}
	left := leafOne.TapHash()
	right := leafTwo.TapHash()
	branch := txscript.NewTapBranch(leafOne, leafTwo).TapHash()
	vectors.Scripts.TapBranches = append(vectors.Scripts.TapBranches,
		TapBranchVector{Name: "forward", Left: hex.EncodeToString(left[:]), Right: hex.EncodeToString(right[:]), Hash: hex.EncodeToString(branch[:])},
		TapBranchVector{Name: "reversed", Left: hex.EncodeToString(right[:]), Right: hex.EncodeToString(left[:]), Hash: hex.EncodeToString(branch[:])},
	)

	seed, err := hex.DecodeString("5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4")
	check(err)
	master, err := hdkeychain.NewMaster(seed, &chaincfg.MainNetParams)
	check(err)
	const h uint32 = hdkeychain.HardenedKeyStart
	accountPath := fmt.Sprintf("m/86'/%d'/0'", chaincfg.MainNetParams.HDCoinType)
	account := derive(master, uint32(86)+h, chaincfg.MainNetParams.HDCoinType+h, h)
	accountPub, err := account.Neuter()
	check(err)
	vectors.BIP86 = BIP86Vector{
		Seed: hex.EncodeToString(seed), Network: chaincfg.MainNetParams.Name,
		AccountPath: accountPath, AccountXPub: accountPub.String(),
	}
	for _, child := range []struct {
		change uint32
		index  uint32
	}{{0, 0}, {0, 1}, {1, 0}} {
		key := derive(account, child.change, child.index)
		pub, err := key.ECPubKey()
		check(err)
		tweaked := txscript.ComputeTaprootKeyNoScript(pub)
		addr, err := btcutil.NewAddressTaproot(schnorr.SerializePubKey(tweaked), &chaincfg.MainNetParams)
		check(err)
		vectors.BIP86.Children = append(vectors.BIP86.Children, ChildVector{
			Path:           fmt.Sprintf("%s/%d/%d", accountPath, child.change, child.index),
			InternalPubKey: hex.EncodeToString(pub.SerializeCompressed()[1:]),
			Address:        addr.String(),
		})
	}

	program := bytes.Repeat([]byte{0x11}, 32)
	addr, err := btcutil.NewAddressTaproot(program, &chaincfg.MainNetParams)
	check(err)
	script, err := txscript.PayToAddrScript(addr)
	check(err)
	prevHash := chainhash.Hash{0x07}
	tx := wire.NewMsgTx(wire.TxVersion)
	tx.LockTime = 500
	input := wire.NewTxIn(wire.NewOutPoint(&prevHash, 2), nil, nil)
	input.Sequence = 0xfffffffd
	tx.AddTxIn(input)
	tx.AddTxOut(wire.NewTxOut(123456789, script))
	vectors.Transactions = append(vectors.Transactions, TransactionVector{
		Name: "unsigned", Hex: serializeTx(tx, true), NoWitnessHex: serializeTx(tx, false),
		TxID: tx.TxID(), WTxID: tx.WitnessHash().String(),
	})
	signed := tx.Copy()
	signed.TxIn[0].SetWitness([][]byte{bytes.Repeat([]byte{0x42}, 64)})
	vectors.Transactions = append(vectors.Transactions, TransactionVector{
		Name: "witness", Hex: serializeTx(signed, true), NoWitnessHex: serializeTx(signed, false),
		TxID: signed.TxID(), WTxID: signed.WitnessHash().String(),
	})

	packet, err := psbt.NewFromUnsignedTx(tx)
	check(err)
	updater, err := psbt.NewUpdater(packet)
	check(err)
	check(updater.AddInWitnessUtxo(wire.NewTxOut(200000000, script), 0))
	var psbtBuf bytes.Buffer
	check(packet.Serialize(&psbtBuf))
	vectors.PSBT = PSBTVector{Base64: base64.StdEncoding.EncodeToString(psbtBuf.Bytes()), UnsignedTxHex: serializeTx(tx, false)}

	fetcher := txscript.NewCannedPrevOutputFetcher(script, 200000000)
	sigHashes := txscript.NewTxSigHashes(tx, fetcher)
	for _, hashType := range []txscript.SigHashType{
		txscript.SigHashDefault, txscript.SigHashAll, txscript.SigHashNone,
		txscript.SigHashSingle, txscript.SigHashAll | txscript.SigHashAnyOneCanPay,
		txscript.SigHashNone | txscript.SigHashAnyOneCanPay,
		txscript.SigHashSingle | txscript.SigHashAnyOneCanPay,
	} {
		hash, err := txscript.CalcTaprootSignatureHash(sigHashes, hashType, tx, 0, fetcher)
		check(err)
		vectors.Sighashes = append(vectors.Sighashes, SighashVector{HashType: uint32(hashType), Hash: hex.EncodeToString(hash)})
	}

	masterPub, err := master.ECPubKey()
	check(err)
	masterFingerprint := binary.LittleEndian.Uint32(btcutil.Hash160(masterPub.SerializeCompressed())[:4])
	for _, item := range []struct {
		name     string
		index    uint32
		hashType txscript.SigHashType
	}{
		{"default", 0, txscript.SigHashDefault},
		{"all", 1, txscript.SigHashAll},
		{"none", 0, txscript.SigHashNone},
		{"single", 0, txscript.SigHashSingle},
		{"all-anyonecanpay", 0, txscript.SigHashAll | txscript.SigHashAnyOneCanPay},
		{"none-anyonecanpay", 0, txscript.SigHashNone | txscript.SigHashAnyOneCanPay},
		{"single-anyonecanpay", 0, txscript.SigHashSingle | txscript.SigHashAnyOneCanPay},
	} {
		key := derive(account, 0, item.index)
		pub, err := key.ECPubKey()
		check(err)
		priv, err := key.ECPrivKey()
		check(err)
		internalKey := pub.SerializeCompressed()[1:]
		outputKey := txscript.ComputeTaprootKeyNoScript(pub)
		inputAddr, err := btcutil.NewAddressTaproot(schnorr.SerializePubKey(outputKey), &chaincfg.MainNetParams)
		check(err)
		inputScript, err := txscript.PayToAddrScript(inputAddr)
		check(err)
		const amount int64 = 200000000
		spendTx := wire.NewMsgTx(wire.TxVersion)
		spendTx.LockTime = 500
		spendInput := wire.NewTxIn(wire.NewOutPoint(&prevHash, 2), nil, nil)
		spendInput.Sequence = 0xfffffffd
		spendTx.AddTxIn(spendInput)
		spendTx.AddTxOut(wire.NewTxOut(amount-5000, script))

		spendPacket, err := psbt.NewFromUnsignedTx(spendTx)
		check(err)
		spendUpdater, err := psbt.NewUpdater(spendPacket)
		check(err)
		check(spendUpdater.AddInWitnessUtxo(wire.NewTxOut(amount, inputScript), 0))
		spendPacket.Inputs[0].TaprootInternalKey = internalKey
		spendPacket.Inputs[0].TaprootBip32Derivation = []*psbt.TaprootBip32Derivation{{
			XOnlyPubKey: internalKey, MasterKeyFingerprint: masterFingerprint,
			Bip32Path: []uint32{86 + h, chaincfg.MainNetParams.HDCoinType + h, h, 0, item.index},
		}}
		spendPacket.Inputs[0].SighashType = item.hashType
		prepared := encodePSBT(spendPacket)
		spendFetcher := txscript.NewCannedPrevOutputFetcher(inputScript, amount)
		spendSigHashes := txscript.NewTxSigHashes(spendTx, spendFetcher)
		sighash, err := txscript.CalcTaprootSignatureHash(spendSigHashes, item.hashType, spendTx, 0, spendFetcher)
		check(err)
		signature, err := txscript.RawTxInTaprootSignature(
			spendTx, spendSigHashes, 0, amount, inputScript, nil, item.hashType, priv,
		)
		check(err)
		spendPacket.Inputs[0].TaprootKeySpendSig = signature
		signed := encodePSBT(spendPacket)
		check(psbt.Finalize(spendPacket, 0))
		finalized := encodePSBT(spendPacket)
		finalTx, err := psbt.Extract(spendPacket)
		check(err)
		vectors.Signing = append(vectors.Signing, SigningVector{
			Name: item.name, Path: fmt.Sprintf("%s/0/%d", accountPath, item.index),
			Change: false, Index: item.index, Value: amount, HashType: uint32(item.hashType),
			MasterFingerprint: hex.EncodeToString(btcutil.Hash160(masterPub.SerializeCompressed())[:4]),
			InternalPubKey:    hex.EncodeToString(internalKey), TweakedPubKey: hex.EncodeToString(schnorr.SerializePubKey(outputKey)),
			Sighash: hex.EncodeToString(sighash), Signature: hex.EncodeToString(signature),
			UnsignedTxHex: serializeTx(spendTx, false), PreparedPSBT: prepared, SignedPSBT: signed, FinalPSBT: finalized,
			FinalTxHex: serializeTx(finalTx, true), TxID: finalTx.TxID(),
		})
	}

	// Script trees of one to five leaves cover the single-leaf case, even
	// pairs, and AssembleTaprootScriptTree's odd-leaf merge.
	internalPriv, err := derive(account, 1, 0).ECPrivKey()
	check(err)
	internalPub := internalPriv.PubKey()
	internalKey := schnorr.SerializePubKey(internalPub)
	for n := 1; n <= 5; n++ {
		leaves, _ := leafKeyScripts(account, n)
		tree := txscript.AssembleTaprootScriptTree(leaves...)
		root := tree.RootNode.TapHash()
		outputKey := txscript.ComputeTaprootOutputKey(internalPub, root[:])
		trAddr, err := btcutil.NewAddressTaproot(schnorr.SerializePubKey(outputKey), &chaincfg.MainNetParams)
		check(err)
		mrAddr, err := btcutil.NewAddressMerkleRoot(root[:], &chaincfg.MainNetParams)
		check(err)
		treeVector := ScriptTreeVector{
			Name: fmt.Sprintf("leaves-%d", n), InternalPubKey: hex.EncodeToString(internalKey),
			Root: hex.EncodeToString(root[:]), TaprootOutputKey: hex.EncodeToString(schnorr.SerializePubKey(outputKey)),
			TaprootAddress: trAddr.String(), P2MRAddress: mrAddr.String(),
		}
		for i, proof := range tree.LeafMerkleProofs {
			trBlock := proof.ToControlBlock(internalPub)
			trBytes, err := trBlock.ToBytes()
			check(err)
			check(txscript.VerifyTaprootLeafCommitment(&trBlock, schnorr.SerializePubKey(outputKey), leaves[i].Script))
			mrBlock := txscript.MerkleRootControlBlock{LeafVersion: txscript.BaseLeafVersion, InclusionProof: proof.InclusionProof}
			mrBytes, err := mrBlock.ToBytes()
			check(err)
			check(txscript.VerifyMerkleRootLeafCommitment(&mrBlock, root[:], leaves[i].Script))
			leafHash := leaves[i].TapHash()
			treeVector.Leaves = append(treeVector.Leaves, ScriptTreeLeafVector{
				Script: hex.EncodeToString(leaves[i].Script), LeafHash: hex.EncodeToString(leafHash[:]),
				Proof: hex.EncodeToString(proof.InclusionProof), TaprootControlBlock: hex.EncodeToString(trBytes),
				P2MRControlBlock: hex.EncodeToString(mrBytes),
			})
		}
		vectors.ScriptTrees = append(vectors.ScriptTrees, treeVector)
	}

	for _, item := range []struct {
		name      string
		kind      string
		leafCount int
		leafIndex int
		hashType  txscript.SigHashType
		// withP2TR puts a BIP86 key-path input first, so the vectors cover
		// a transaction that mixes P2TR and P2MR inputs.
		withP2TR bool
	}{
		{"p2tr-1-leaf-default", "p2tr", 1, 0, txscript.SigHashDefault, false},
		{"p2tr-3-leaves-last-default", "p2tr", 3, 2, txscript.SigHashDefault, false},
		{"p2tr-5-leaves-first-all", "p2tr", 5, 0, txscript.SigHashAll, false},
		{"p2mr-1-leaf-default", "p2mr", 1, 0, txscript.SigHashDefault, false},
		{"p2mr-3-leaves-middle-all-anyonecanpay", "p2mr", 3, 1, txscript.SigHashAll | txscript.SigHashAnyOneCanPay, false},
		{"p2mr-5-leaves-last-single", "p2mr", 5, 4, txscript.SigHashSingle, false},
		{"p2mr-2-leaves-with-p2tr-input-default", "p2mr", 2, 1, txscript.SigHashDefault, true},
	} {
		leaves, keys := leafKeyScripts(account, item.leafCount)
		tree := txscript.AssembleTaprootScriptTree(leaves...)
		root := tree.RootNode.TapHash()
		proof := tree.LeafMerkleProofs[item.leafIndex]
		leaf := leaves[item.leafIndex]
		leafHash := leaf.TapHash()

		var prevScript, controlBlock []byte
		if item.kind == "p2tr" {
			outputKey := txscript.ComputeTaprootOutputKey(internalPub, root[:])
			prevScript, err = txscript.PayToTaprootScript(outputKey)
			check(err)
			block := proof.ToControlBlock(internalPub)
			controlBlock, err = block.ToBytes()
			check(err)
		} else {
			mrAddr, err := btcutil.NewAddressMerkleRoot(root[:], &chaincfg.MainNetParams)
			check(err)
			prevScript, err = txscript.PayToAddrScript(mrAddr)
			check(err)
			block := txscript.MerkleRootControlBlock{LeafVersion: txscript.BaseLeafVersion, InclusionProof: proof.InclusionProof}
			controlBlock, err = block.ToBytes()
			check(err)
		}

		const amount int64 = 150000000
		spendTx := wire.NewMsgTx(wire.TxVersion)
		spendTx.LockTime = 700
		var prevOuts []*wire.TxOut
		var keyPathPriv *btcec.PrivateKey
		if item.withP2TR {
			keyPathPriv, err = derive(account, 1, 1).ECPrivKey()
			check(err)
			keyPathScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(keyPathPriv.PubKey()))
			check(err)
			keyPathInput := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x08}, 0), nil, nil)
			keyPathInput.Sequence = 0xfffffffe
			spendTx.AddTxIn(keyPathInput)
			prevOuts = append(prevOuts, wire.NewTxOut(50000000, keyPathScript))
		}
		inputIndex := len(spendTx.TxIn)
		spendInput := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x09}, uint32(item.leafIndex)), nil, nil)
		spendInput.Sequence = 0xfffffffe
		spendTx.AddTxIn(spendInput)
		prevOuts = append(prevOuts, wire.NewTxOut(amount, prevScript))
		spendTx.AddTxOut(wire.NewTxOut(amount-7000, script))
		unsignedHex := serializeTx(spendTx, false)

		fetcher := txscript.NewMultiPrevOutFetcher(nil)
		var prevoutVectors []PrevoutVector
		for i, txIn := range spendTx.TxIn {
			fetcher.AddPrevOut(txIn.PreviousOutPoint, prevOuts[i])
			prevoutVectors = append(prevoutVectors, PrevoutVector{
				Script: hex.EncodeToString(prevOuts[i].PkScript), Value: prevOuts[i].Value,
			})
		}
		sigHashes := txscript.NewTxSigHashes(spendTx, fetcher)
		sighash, err := txscript.CalcTapscriptSignaturehash(sigHashes, item.hashType, spendTx, inputIndex, fetcher, leaf)
		check(err)
		signature, err := txscript.RawTxInTapscriptSignature(
			spendTx, sigHashes, inputIndex, amount, prevScript, leaf, item.hashType, keys[item.leafIndex],
		)
		check(err)

		vector := ScriptPathSpendVector{
			Name: item.name, Kind: item.kind, LeafCount: item.leafCount, LeafIndex: item.leafIndex,
			SignerPath: fmt.Sprintf("%s/0/%d", accountPath, item.leafIndex), HashType: uint32(item.hashType),
			InputIndex: inputIndex, Prevouts: prevoutVectors,
			Value: amount, PrevScript: hex.EncodeToString(prevScript), LeafScript: hex.EncodeToString(leaf.Script),
			LeafHash: hex.EncodeToString(leafHash[:]), ControlBlock: hex.EncodeToString(controlBlock),
			UnsignedTxHex: unsignedHex, Sighash: hex.EncodeToString(sighash), Signature: hex.EncodeToString(signature),
		}

		var finalTx *wire.MsgTx
		if item.kind == "p2tr" {
			// BIP371 script-path PSBT, finalized by Pearl's own finalizer.
			packet, err := psbt.NewFromUnsignedTx(spendTx)
			check(err)
			updater, err := psbt.NewUpdater(packet)
			check(err)
			check(updater.AddInWitnessUtxo(wire.NewTxOut(amount, prevScript), inputIndex))
			packet.Inputs[inputIndex].TaprootInternalKey = internalKey
			packet.Inputs[inputIndex].TaprootMerkleRoot = root[:]
			packet.Inputs[inputIndex].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
				ControlBlock: controlBlock, Script: leaf.Script, LeafVersion: leaf.LeafVersion,
			}}
			packet.Inputs[inputIndex].SighashType = item.hashType
			vector.PreparedPSBT = encodePSBT(packet)
			packet.Inputs[inputIndex].TaprootScriptSpendSig = []*psbt.TaprootScriptSpendSig{{
				XOnlyPubKey: schnorr.SerializePubKey(keys[item.leafIndex].PubKey()),
				LeafHash:    leafHash[:], Signature: signature[:schnorr.SignatureSize], SigHash: item.hashType,
			}}
			check(psbt.Finalize(packet, inputIndex))
			vector.FinalPSBT = encodePSBT(packet)
			finalTx, err = psbt.Extract(packet)
			check(err)
		} else {
			// Pearl's PSBT cannot carry P2MR control blocks, so the witness
			// is built directly, as wallet/txauthor spendMerkleRoot does.
			finalTx = spendTx.Copy()
			finalTx.TxIn[inputIndex].SetWitness(wire.TxWitness{signature, leaf.Script, controlBlock})
		}
		if keyPathPriv != nil {
			keySig, err := txscript.RawTxInTaprootSignature(
				finalTx, txscript.NewTxSigHashes(finalTx, fetcher), 0, prevOuts[0].Value,
				prevOuts[0].PkScript, nil, txscript.SigHashDefault, keyPathPriv,
			)
			check(err)
			finalTx.TxIn[0].SetWitness(wire.TxWitness{keySig})
		}
		verifyInputs(finalTx, prevOuts)
		vector.FinalTxHex = serializeTx(finalTx, true)
		vector.TxID = finalTx.TxID()
		vector.WTxID = finalTx.WitnessHash().String()
		vectors.ScriptPathSpends = append(vectors.ScriptPathSpends, vector)
	}

	for _, net := range nets {
		vectors.Blocks = append(vectors.Blocks, makeBlockVector(net.Name+"-genesis", net.GenesisBlock))
	}

	// Synthetic blocks cover every certificate version, the MoE size
	// threshold, odd transaction counts and witness commitments. Spends are
	// taken from the script-path vectors above so the blocks carry real
	// witness transactions.
	var spends []*wire.MsgTx
	for _, vector := range vectors.ScriptPathSpends {
		raw, err := hex.DecodeString(vector.FinalTxHex)
		check(err)
		var tx wire.MsgTx
		check(tx.Deserialize(bytes.NewReader(raw)))
		spends = append(spends, &tx)
	}
	v1Public := [wire.PublicDataSizeV1]byte{}
	copy(v1Public[:], patternBytes(wire.PublicDataSizeV1, 0x10))
	newV2 := func(publicLen int, seed byte) wire.CertificateV2 {
		c := wire.CertificateV2{PublicDataLen: uint32(publicLen), ProofData: patternBytes(97, seed)}
		copy(c.PublicData[:], patternBytes(publicLen, seed))
		return c
	}
	v2Dense, v2MoE, v3 := newV2(wire.PublicDataSizeDenseV2, 0x20), newV2(wire.PublicDataSizeDenseV2+1, 0x30), newV2(300, 0x40)
	v2BadCommit, v2NoCommit := newV2(200, 0x50), newV2(180, 0x70)
	for i, item := range []struct {
		name      string
		cert      wire.BlockCertificate
		spends    int
		commit    bool
		corrupt   bool
		withNonce bool
	}{
		{"no-certificate-coinbase-only", nil, 0, false, false, false},
		{"v1-one-spend", &wire.CertificateV1{PublicData: v1Public, ProofData: patternBytes(150, 0x01)}, 1, true, false, true},
		{"v2-dense-two-spends", &v2Dense, 2, true, false, true},
		{"v2-moe-three-spends", &v2MoE, 3, true, false, true},
		{"v3-four-spends", &wire.CertificateV3{CertificateV2: v3}, 4, true, false, true},
		{"v2-wrong-witness-commitment", &v2BadCommit, 1, true, true, true},
		{"v2-witness-without-commitment", &v2NoCommit, 1, false, false, false},
	} {
		block := &wire.MsgBlock{}
		block.MsgHeader.BlockHeader = wire.BlockHeader{
			Version: 1, PrevBlock: chainhash.Hash{byte(0x60 + i)},
			Timestamp: time.Unix(int64(1_760_000_000+i*600), 0), Bits: 0x1d00ffff,
		}
		block.AddTransaction(coinbaseTx(int64(100+i), script, item.withNonce))
		for _, spend := range spends[:item.spends] {
			block.AddTransaction(spend)
		}
		if item.commit {
			addWitnessCommitment(block, item.corrupt)
		}
		sealBlock(block, item.cert)
		vectors.Blocks = append(vectors.Blocks, makeBlockVector(item.name, block))
	}

	// Encodings Pearl's decoder rejects, built by editing a valid block.
	base, err := hex.DecodeString(vectors.Blocks[len(nets)+2].Hex)
	check(err)
	badCert := func(edit func(b []byte) []byte) []byte {
		return edit(append([]byte{}, base...))
	}
	for _, item := range []struct {
		name string
		raw  []byte
	}{
		{"unknown-certificate-version", badCert(func(b []byte) []byte { b[0] = 4; return b })},
		{"public-data-over-limit", badCert(func(b []byte) []byte {
			binary.LittleEndian.PutUint32(b[36:], wire.PublicDataMaxSizeV2+1)
			return b
		})},
		{"proof-over-limit", badCert(func(b []byte) []byte {
			at := 40 + wire.PublicDataSizeDenseV2
			binary.LittleEndian.PutUint32(b[at:], wire.MaxZKProofSize+1)
			return b
		})},
		{"truncated-header", base[:4+32+4+wire.PublicDataSizeDenseV2+4+97+50]},
		{"truncated-transactions", base[:len(base)-10]},
	} {
		var block wire.MsgBlock
		err := block.Deserialize(bytes.NewReader(item.raw))
		if err == nil {
			panic(item.name + ": Pearl accepted a bad block")
		}
		vectors.BadBlocks = append(vectors.BadBlocks, BadBlockVector{
			Name: item.name, Hex: hex.EncodeToString(item.raw), Error: err.Error(),
		})
	}

	data, err := json.MarshalIndent(vectors, "", "  ")
	check(err)
	data = append(data, '\n')
	check(os.WriteFile(*out, data, 0o644))
}

func mustPort(port string) int {
	var value int
	_, err := fmt.Sscanf(port, "%d", &value)
	check(err)
	return value
}

func binaryUint32(id [4]byte) uint32 {
	return uint32(id[0])<<24 | uint32(id[1])<<16 | uint32(id[2])<<8 | uint32(id[3])
}

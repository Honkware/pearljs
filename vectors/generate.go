// Run with a Pearl source checkout, after building its XMSS library with
// `make -C /path/to/pearl/xmss`:
// go -C /path/to/pearl/node run -tags xmss /path/to/pearljs/vectors/generate.go -out /path/to/pearljs/vectors/pearl-go.json
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
	"strings"
	"time"

	"github.com/pearl-research-labs/pearl/node/blockchain"
	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcec/schnorr"
	"github.com/pearl-research-labs/pearl/node/btcutil"
	"github.com/pearl-research-labs/pearl/node/btcutil/base58"
	"github.com/pearl-research-labs/pearl/node/btcutil/hdkeychain"
	"github.com/pearl-research-labs/pearl/node/btcutil/psbt"
	"github.com/pearl-research-labs/pearl/node/chaincfg"
	"github.com/pearl-research-labs/pearl/node/chaincfg/chainhash"
	"github.com/pearl-research-labs/pearl/node/mempool"
	"github.com/pearl-research-labs/pearl/node/txscript"
	"github.com/pearl-research-labs/pearl/node/wire"
	"github.com/pearl-research-labs/pearl/wallet/rpc/jsonrpc"
	"github.com/pearl-research-labs/pearl/xmss"
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
	XMSS             XMSSVectors             `json:"xmss"`
	Messages         []MessageVector         `json:"messages"`
	MultiASpends     []MultiASpendVector     `json:"multiASpends"`
	ScriptToolkit    ScriptToolkitVectors    `json:"scriptToolkit"`
	WIF              []WIFVector             `json:"wif"`
	BadWIF           []BadWIFVector          `json:"badWif"`
	BadBlocks        []BadBlockVector        `json:"badBlocks"`
	Policy           PolicyVectors           `json:"policy"`
}

// DustVector is mempool.GetDustThreshold of a script and mempool.IsDust of
// an output paying it Value at the default relay fee.
type DustVector struct {
	Name      string `json:"name"`
	Script    string `json:"script"`
	Threshold int64  `json:"threshold"`
	Value     int64  `json:"value,string"`
	Dust      bool   `json:"dust"`
}

// StandardVector is blockchain.CheckTransactionSanity and then
// mempool.CheckTransactionStandard of a transaction, the order pearld's
// mempool runs them in, with Error "" when both pass.
type StandardVector struct {
	Name           string `json:"name"`
	TxHex          string `json:"txHex"`
	Vsize          int64  `json:"vsize"`
	Height         int32  `json:"height"`
	MedianTimePast int64  `json:"medianTimePast"`
	MinRelayFee    int64  `json:"minRelayFee"`
	Error          string `json:"error"`
}

type PolicyVectors struct {
	Dust     []DustVector     `json:"dust"`
	Standard []StandardVector `json:"standard"`
}

// WIFVector is a private key as btcutil.NewWIF encodes it. Address is the
// BIP86 key-path P2TR address Oyster's importprivkey gives the key.
type WIFVector struct {
	Network    string `json:"network"`
	PrivateKey string `json:"privateKey"`
	Compressed bool   `json:"compressed"`
	WIF        string `json:"wif"`
	Address    string `json:"address"`
}

// BadWIFVector is a string btcutil.DecodeWIF rejects, with its error.
type BadWIFVector struct {
	Name  string `json:"name"`
	WIF   string `json:"wif"`
	Error string `json:"error"`
}

// OpcodeVector describes one byte value. Disasm is DisasmString of the
// one-byte script. LeafError is the engine error from spending a P2MR leaf
// that is just that byte, or "" if it spends. Pearl removed BIP 342's
// OP_SUCCESS handling, so no byte makes a leaf succeed by itself.
type OpcodeVector struct {
	Value     int    `json:"value"`
	Disasm    string `json:"disasm"`
	LeafError string `json:"leafError"`
}

type DisasmVector struct {
	Name     string `json:"name"`
	Script   string `json:"script"`
	Disasm   string `json:"disasm"`
	Error    bool   `json:"error"`
	PushOnly bool   `json:"pushOnly"`
}

type ScriptNumVector struct {
	Data      string `json:"data"`
	Minimal   bool   `json:"minimal"`
	MaxLength int    `json:"maxLength"`
	Value     int64  `json:"value"`
	Error     string `json:"error"`
}

type ScriptToolkitVectors struct {
	OpcodeByName map[string]int    `json:"opcodeByName"`
	Opcodes      []OpcodeVector    `json:"opcodes"`
	Disasm       []DisasmVector    `json:"disasm"`
	Numbers      []ScriptNumVector `json:"numbers"`
}

// MultiASpendVector is a k-of-n OP_CHECKSIGADD leaf spent through a PSBT and
// finalized by Pearl's psbt.Finalize, which leaves an empty witness item for
// each key without a signature and drops signatures beyond the threshold.
type MultiASpendVector struct {
	Name           string          `json:"name"`
	KeyIndices     []uint32        `json:"keyIndices"`
	SignerIndices  []uint32        `json:"signerIndices"`
	Threshold      int             `json:"threshold"`
	LeafScript     string          `json:"leafScript"`
	InternalPubKey string          `json:"internalPubKey"`
	UnsignedTxHex  string          `json:"unsignedTxHex"`
	Prevouts       []PrevoutVector `json:"prevouts"`
	FinalTxHex     string          `json:"finalTxHex"`
	// WitnessLengths are the item lengths of the finalized witness.
	WitnessLengths []int `json:"witnessLengths"`
}

// MessageVector is a signmessage case from Oyster's BIP322SignMessageSimple
// and BIP322VerifyMessageSimple. SignError is set when Oyster refuses to
// sign; Valid is what its verifier returns for Signature against Address.
type MessageVector struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Address   string `json:"address"`
	Message   string `json:"message"`
	Signature string `json:"signature"`
	SignError string `json:"signError"`
	Valid     bool   `json:"valid"`
}

type XMSSKeyVector struct {
	Name        string `json:"name"`
	PrivateSeed string `json:"privateSeed"`
	PublicSeed  string `json:"publicSeed"`
	PublicKey   string `json:"publicKey"`
	SecretKey   string `json:"secretKey"`
}

type XMSSSignatureVector struct {
	Key       string `json:"key"`
	MsgUID    uint32 `json:"msgUid"`
	Message   string `json:"message"`
	Signature string `json:"signature"`
	// Valid is what xmss.Verify returns. Pearl's Sign reports success at
	// index 31 but the signature does not verify.
	Valid bool `json:"valid"`
}

type XMSSSpendVector struct {
	Name          string          `json:"name"`
	Key           string          `json:"key"`
	MsgUID        uint32          `json:"msgUid"`
	LeafScripts   []string        `json:"leafScripts"`
	LeafIndex     int             `json:"leafIndex"`
	InputIndex    int             `json:"inputIndex"`
	Prevouts      []PrevoutVector `json:"prevouts"`
	ControlBlock  string          `json:"controlBlock"`
	UnsignedTxHex string          `json:"unsignedTxHex"`
	Sighash       string          `json:"sighash"`
	Signature     string          `json:"signature"`
	FinalTxHex    string          `json:"finalTxHex"`
	TxID          string          `json:"txid"`
}

type XMSSVectors struct {
	Keys       []XMSSKeyVector       `json:"keys"`
	Signatures []XMSSSignatureVector `json:"signatures"`
	Spends     []XMSSSpendVector     `json:"spends"`
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

	// k-of-n multi_a leaves finalized by Pearl's PSBT code.
	for _, item := range []struct {
		name      string
		keys      []uint32
		signers   []uint32
		threshold int64
	}{
		{"2-of-3-signed-by-0-and-2", []uint32{0, 1, 2}, []uint32{0, 2}, 2},
		{"2-of-3-signed-by-all", []uint32{0, 1, 2}, []uint32{0, 1, 2}, 2},
		{"3-of-5-signed-by-1-3-4", []uint32{0, 1, 2, 3, 4}, []uint32{1, 3, 4}, 3},
	} {
		privs := map[uint32]*btcec.PrivateKey{}
		builder := txscript.NewScriptBuilder()
		for i, index := range item.keys {
			priv, err := derive(account, 0, 20+index).ECPrivKey()
			check(err)
			privs[index] = priv
			builder.AddData(schnorr.SerializePubKey(priv.PubKey()))
			if i == 0 {
				builder.AddOp(txscript.OP_CHECKSIG)
			} else {
				builder.AddOp(txscript.OP_CHECKSIGADD)
			}
		}
		leafScript, err := builder.AddInt64(item.threshold).AddOp(txscript.OP_NUMEQUAL).Script()
		check(err)
		leaf := txscript.NewBaseTapLeaf(leafScript)
		tree := txscript.AssembleTaprootScriptTree(leaf)
		root := tree.RootNode.TapHash()
		prevScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(internalPub, root[:]))
		check(err)
		block := tree.LeafMerkleProofs[0].ToControlBlock(internalPub)
		controlBlock, err := block.ToBytes()
		check(err)

		const amount int64 = 200_000_000
		spendTx := wire.NewMsgTx(2)
		spendTx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0c}, 0), nil, nil))
		spendTx.AddTxOut(wire.NewTxOut(amount-10_000, prevScript))
		unsignedHex := serializeTx(spendTx, false)
		packet, err := psbt.NewFromUnsignedTx(spendTx)
		check(err)
		updater, err := psbt.NewUpdater(packet)
		check(err)
		check(updater.AddInWitnessUtxo(wire.NewTxOut(amount, prevScript), 0))
		packet.Inputs[0].TaprootInternalKey = internalKey
		packet.Inputs[0].TaprootMerkleRoot = root[:]
		packet.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
			ControlBlock: controlBlock, Script: leafScript, LeafVersion: leaf.LeafVersion,
		}}
		fetcher := txscript.NewCannedPrevOutputFetcher(prevScript, amount)
		sigHashes := txscript.NewTxSigHashes(spendTx, fetcher)
		leafHash := leaf.TapHash()
		for _, index := range item.signers {
			sig, err := txscript.RawTxInTapscriptSignature(
				spendTx, sigHashes, 0, amount, prevScript, leaf, txscript.SigHashDefault, privs[index],
			)
			check(err)
			packet.Inputs[0].TaprootScriptSpendSig = append(packet.Inputs[0].TaprootScriptSpendSig,
				&psbt.TaprootScriptSpendSig{
					XOnlyPubKey: schnorr.SerializePubKey(privs[index].PubKey()), LeafHash: leafHash[:],
					Signature: sig, SigHash: txscript.SigHashDefault,
				})
		}
		check(psbt.Finalize(packet, 0))
		finalTx, err := psbt.Extract(packet)
		check(err)
		verifyInputs(finalTx, []*wire.TxOut{wire.NewTxOut(amount, prevScript)})
		var lengths []int
		for _, item := range finalTx.TxIn[0].DecodeWitness() {
			lengths = append(lengths, len(item))
		}
		vectors.MultiASpends = append(vectors.MultiASpends, MultiASpendVector{
			Name: item.name, KeyIndices: item.keys, SignerIndices: item.signers, Threshold: int(item.threshold),
			LeafScript: hex.EncodeToString(leafScript), InternalPubKey: hex.EncodeToString(internalKey),
			UnsignedTxHex: unsignedHex,
			Prevouts:      []PrevoutVector{{Script: hex.EncodeToString(prevScript), Value: amount}},
			FinalTxHex:    serializeTx(finalTx, true), WitnessLengths: lengths,
		})
	}

	// Script toolkit: opcode names, one-line disassembly, push-only checks,
	// script numbers, and which bytes are OP_SUCCESS in tapscript.
	vectors.ScriptToolkit.OpcodeByName = map[string]int{}
	for name, value := range txscript.OpcodeByName {
		vectors.ScriptToolkit.OpcodeByName[name] = int(value)
	}
	leafError := func(op byte) string {
		leafScript := []byte{op}
		leaf := txscript.NewBaseTapLeaf(leafScript)
		tree := txscript.AssembleTaprootScriptTree(leaf)
		root := tree.RootNode.TapHash()
		mrAddr, err := btcutil.NewAddressMerkleRoot(root[:], &chaincfg.MainNetParams)
		check(err)
		pkScript, err := txscript.PayToAddrScript(mrAddr)
		check(err)
		cb, err := (&txscript.MerkleRootControlBlock{LeafVersion: txscript.BaseLeafVersion}).ToBytes()
		check(err)
		tx := wire.NewMsgTx(2)
		tx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0d}, 0), nil, nil))
		tx.TxIn[0].SetWitness(wire.TxWitness{leafScript, cb})
		tx.AddTxOut(wire.NewTxOut(1000, pkScript))
		fetcher := txscript.NewCannedPrevOutputFetcher(pkScript, 2000)
		vm, err := txscript.NewEngine(pkScript, tx, 0, txscript.StandardVerifyFlags, nil,
			txscript.NewTxSigHashes(tx, fetcher), 2000, fetcher)
		if err == nil {
			err = vm.Execute()
		}
		if err != nil {
			return err.Error()
		}
		return ""
	}
	for value := 0; value < 256; value++ {
		disasm, _ := txscript.DisasmString([]byte{byte(value)})
		vectors.ScriptToolkit.Opcodes = append(vectors.ScriptToolkit.Opcodes, OpcodeVector{
			Value: value, Disasm: disasm, LeafError: leafError(byte(value)),
		})
	}
	for _, item := range []struct {
		name   string
		script []byte
	}{
		{"p2tr", append([]byte{txscript.OP_1, 32}, bytes.Repeat([]byte{0x11}, 32)...)},
		{"p2mr", append([]byte{txscript.OP_2, 32}, bytes.Repeat([]byte{0x22}, 32)...)},
		{"nulldata", []byte{txscript.OP_RETURN, 0x05, 'p', 'e', 'a', 'r', 'l'}},
		{"multi-a", mustHex(vectors.MultiASpends[0].LeafScript)},
		{"xmss-leaf", append(append([]byte{64}, bytes.Repeat([]byte{0x44}, 64)...), txscript.OP_CHECKXMSSSIG)},
		{"hashlock", append(append([]byte{txscript.OP_SHA256, 32}, bytes.Repeat([]byte{0x33}, 32)...), txscript.OP_EQUALVERIFY, 0x51)},
		{"timelock", []byte{0x03, 0x40, 0x0d, 0x03, txscript.OP_CHECKLOCKTIMEVERIFY, txscript.OP_DROP, txscript.OP_TRUE}},
		{"small-ints", []byte{txscript.OP_0, txscript.OP_1NEGATE, txscript.OP_1, txscript.OP_16}},
		{"one-byte-push", []byte{0x01, 0x10, 0x01, 0x81}},
		{"pushdata1", append([]byte{txscript.OP_PUSHDATA1, 3}, 1, 2, 3)},
		{"pushdata2", append([]byte{txscript.OP_PUSHDATA2, 2, 0}, 0xaa, 0xbb)},
		{"pushdata4", append([]byte{txscript.OP_PUSHDATA4, 1, 0, 0, 0}, 0xcc)},
		{"cat-and-xmss", []byte{txscript.OP_CAT, txscript.OP_CHECKXMSSSIG, txscript.OP_CHECKSIGADD}},
		{"unknown-and-disabled", []byte{txscript.OP_MUL, 0xbb, 0xff}},
		{"empty", nil},
		{"truncated-push", []byte{0x05, 1, 2}},
		{"truncated-pushdata2", []byte{txscript.OP_DUP, txscript.OP_PUSHDATA2, 0x10}},
	} {
		disasm, err := txscript.DisasmString(item.script)
		vectors.ScriptToolkit.Disasm = append(vectors.ScriptToolkit.Disasm, DisasmVector{
			Name: item.name, Script: hex.EncodeToString(item.script), Disasm: disasm,
			Error: err != nil, PushOnly: txscript.IsPushOnlyScript(item.script),
		})
	}
	for _, item := range []struct {
		data      string
		minimal   bool
		maxLength int
	}{
		{"", true, 4}, {"01", true, 4}, {"81", true, 4}, {"7f", true, 4}, {"8000", true, 4},
		{"0080", true, 4}, {"ff7f", true, 4}, {"ffffff7f", true, 4}, {"ffffffff", true, 4},
		{"00", true, 4}, {"00", false, 4}, {"0100", true, 4}, {"0100", false, 4}, {"80", true, 4},
		{"0000008000", true, 4}, {"0000008000", true, 5}, {"ffffffff7f", true, 5},
	} {
		value, err := txscript.MakeScriptNum(mustHex(item.data), item.minimal, item.maxLength)
		vector := ScriptNumVector{Data: item.data, Minimal: item.minimal, MaxLength: item.maxLength}
		if err != nil {
			vector.Error = err.Error()
		} else {
			vector.Value = int64(value)
		}
		vectors.ScriptToolkit.Numbers = append(vectors.ScriptToolkit.Numbers, vector)
	}

	// WIF private keys, as dumpprivkey writes them and importprivkey reads them.
	curveOrderMinusOne := mustHex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140")
	keyOne := append(make([]byte, 31), 1)
	childKey, err := derive(account, 0, 0).ECPrivKey()
	check(err)
	for _, net := range []*chaincfg.Params{&chaincfg.MainNetParams, &chaincfg.TestNetParams, &chaincfg.SimNetParams} {
		for _, raw := range [][]byte{childKey.Serialize(), keyOne, curveOrderMinusOne} {
			priv, _ := btcec.PrivKeyFromBytes(raw)
			addr, err := btcutil.NewAddressTaproot(
				schnorr.SerializePubKey(txscript.ComputeTaprootKeyNoScript(priv.PubKey())), net,
			)
			check(err)
			for _, compressed := range []bool{true, false} {
				wif, err := btcutil.NewWIF(priv, net, compressed)
				check(err)
				decoded, err := btcutil.DecodeWIF(wif.String())
				check(err)
				if !decoded.IsForNet(net) || decoded.CompressPubKey != compressed {
					panic("WIF does not round-trip")
				}
				vectors.WIF = append(vectors.WIF, WIFVector{
					Network: net.Name, PrivateKey: hex.EncodeToString(raw), Compressed: compressed,
					WIF: wif.String(), Address: addr.String(),
				})
			}
		}
	}
	goodWIF := vectors.WIF[0].WIF
	encodeRaw := func(payload []byte) string {
		return base58.Encode(append(payload, chainhash.DoubleHashB(payload)[:4]...))
	}
	flipped := []byte(goodWIF)
	if flipped[len(flipped)-1] == 'a' {
		flipped[len(flipped)-1] = 'b'
	} else {
		flipped[len(flipped)-1] = 'a'
	}
	for _, item := range []struct {
		name string
		wif  string
	}{
		{"checksum", string(flipped)},
		{"truncated", goodWIF[:len(goodWIF)-4]},
		{"bad-compress-flag", encodeRaw(append(append([]byte{0x80}, childKey.Serialize()...), 0x02))},
		{"zero-key", encodeRaw(append([]byte{0x80}, make([]byte, 32)...))},
		{"key-equals-curve-order", encodeRaw(append([]byte{0x80}, mustHex("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141")...))},
		{"not-base58", "0" + goodWIF[1:]},
	} {
		_, err := btcutil.DecodeWIF(item.wif)
		if err == nil {
			panic(item.name + ": Pearl accepted a bad WIF")
		}
		vectors.BadWIF = append(vectors.BadWIF, BadWIFVector{Name: item.name, WIF: item.wif, Error: err.Error()})
	}

	// Message signing as Oyster does it, with BIP86 mainnet keys.
	messageKey := func(index uint32) (*btcec.PrivateKey, *btcutil.AddressTaproot) {
		priv, err := derive(account, 0, index).ECPrivKey()
		check(err)
		addr, err := btcutil.NewAddressTaproot(
			schnorr.SerializePubKey(txscript.ComputeTaprootKeyNoScript(priv.PubKey())), &chaincfg.MainNetParams,
		)
		check(err)
		return priv, addr
	}
	privM0, addrM0 := messageKey(0)
	_, addrM1 := messageKey(1)
	for _, item := range []struct {
		name    string
		message string
	}{
		{"empty", ""},
		{"ascii", "Hello, Pearl"},
		{"utf8", "h\u00e9llo w\u00f6rld \u2713"},
		{"eighty-bytes", strings.Repeat("a", 80)},
		{"eighty-one-bytes", strings.Repeat("a", 81)},
	} {
		vector := MessageVector{
			Name: item.name, Path: accountPath + "/0/0", Address: addrM0.String(), Message: item.message,
		}
		sig, err := jsonrpc.BIP322SignMessageSimple(privM0, addrM0, item.message)
		if err != nil {
			vector.SignError = err.Error()
		} else {
			vector.Signature = sig
			vector.Valid, err = jsonrpc.BIP322VerifyMessageSimple(addrM0, sig, item.message)
			check(err)
		}
		vectors.Messages = append(vectors.Messages, vector)
	}
	asciiSignature := vectors.Messages[1].Signature
	for _, item := range []struct {
		name    string
		addr    *btcutil.AddressTaproot
		message string
	}{
		{"other-message", addrM0, "Hello, Pearl!"},
		{"other-address", addrM1, "Hello, Pearl"},
	} {
		valid, err := jsonrpc.BIP322VerifyMessageSimple(item.addr, asciiSignature, item.message)
		check(err)
		vectors.Messages = append(vectors.Messages, MessageVector{
			Name: item.name, Path: accountPath + "/0/0", Address: item.addr.String(), Message: item.message,
			Signature: asciiSignature, Valid: valid,
		})
	}

	// XMSS: keys from fixed seeds (key "a" uses the seeds published in
	// pearl-research-labs/pearl#111), signatures across the index range, and
	// P2MR spends checked by the script engine with OP_CHECKXMSSSIG.
	type xmssKey struct {
		priv [xmss.PrivateSeedLen]byte
		pub  [xmss.PublicSeedLen]byte
		pk   [xmss.PKLen]byte
		sk   [xmss.SKLen]byte
	}
	xmssKeys := map[string]*xmssKey{}
	for _, item := range []struct {
		name                string
		privStart, pubStart byte
	}{{"a", 0x00, 0x40}, {"b", 0x80, 0xc0}, {"c", 0x5a, 0xa5}} {
		k := &xmssKey{}
		for i := range k.priv {
			k.priv[i] = item.privStart + byte(i)
		}
		for i := range k.pub {
			k.pub[i] = item.pubStart + byte(i)
		}
		k.pk, k.sk, err = xmss.Keygen(k.priv, k.pub)
		check(err)
		xmssKeys[item.name] = k
		vectors.XMSS.Keys = append(vectors.XMSS.Keys, XMSSKeyVector{
			Name: item.name, PrivateSeed: hex.EncodeToString(k.priv[:]), PublicSeed: hex.EncodeToString(k.pub[:]),
			PublicKey: hex.EncodeToString(k.pk[:]), SecretKey: hex.EncodeToString(k.sk[:]),
		})
	}
	for _, item := range []struct {
		key string
		uid uint32
	}{{"a", 0}, {"a", 1}, {"a", 7}, {"a", 30}, {"a", 31}, {"b", 0}, {"c", 16}} {
		k := xmssKeys[item.key]
		var msg [xmss.MsgLen]byte
		copy(msg[:], chainhash.HashB([]byte(fmt.Sprintf("pearljs xmss %s %d", item.key, item.uid))))
		sig, err := xmss.Sign(item.uid, k.sk, msg)
		check(err)
		vectors.XMSS.Signatures = append(vectors.XMSS.Signatures, XMSSSignatureVector{
			Key: item.key, MsgUID: item.uid, Message: hex.EncodeToString(msg[:]),
			Signature: hex.EncodeToString(sig[:]), Valid: xmss.Verify(k.pk, msg, sig),
		})
	}
	for _, item := range []struct {
		name     string
		key      string
		uid      uint32
		withLeaf bool
		withP2TR bool
	}{
		{"p2mr-xmss-single-leaf", "a", 0, false, false},
		{"p2mr-xmss-with-schnorr-leaf", "b", 3, true, false},
		{"p2mr-xmss-with-p2tr-input", "c", 30, false, true},
	} {
		k := xmssKeys[item.key]
		xmssLeaf, err := txscript.NewScriptBuilder().AddData(k.pk[:]).AddOp(txscript.OP_CHECKXMSSSIG).Script()
		check(err)
		leaves := []txscript.TapLeaf{txscript.NewBaseTapLeaf(xmssLeaf)}
		if item.withLeaf {
			schnorrLeaves, _ := leafKeyScripts(account, 1)
			leaves = append(leaves, schnorrLeaves[0])
		}
		tree := txscript.AssembleTaprootScriptTree(leaves...)
		root := tree.RootNode.TapHash()
		mrAddr, err := btcutil.NewAddressMerkleRoot(root[:], &chaincfg.MainNetParams)
		check(err)
		prevScript, err := txscript.PayToAddrScript(mrAddr)
		check(err)
		cb, err := (&txscript.MerkleRootControlBlock{
			LeafVersion: txscript.BaseLeafVersion, InclusionProof: tree.LeafMerkleProofs[0].InclusionProof,
		}).ToBytes()
		check(err)

		const amount int64 = 1_000_000_000
		spendTx := wire.NewMsgTx(wire.TxVersion)
		var prevOuts []*wire.TxOut
		var keyPathPriv *btcec.PrivateKey
		if item.withP2TR {
			keyPathPriv, err = derive(account, 1, 2).ECPrivKey()
			check(err)
			keyPathScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(keyPathPriv.PubKey()))
			check(err)
			spendTx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0a}, 0), nil, nil))
			prevOuts = append(prevOuts, wire.NewTxOut(20_000_000, keyPathScript))
		}
		inputIndex := len(spendTx.TxIn)
		spendTx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0b}, 1), nil, nil))
		prevOuts = append(prevOuts, wire.NewTxOut(amount, prevScript))
		spendTx.AddTxOut(wire.NewTxOut(amount-50_000, prevScript))
		unsignedHex := serializeTx(spendTx, false)

		fetcher := txscript.NewMultiPrevOutFetcher(nil)
		var prevoutVectors []PrevoutVector
		for i, txIn := range spendTx.TxIn {
			fetcher.AddPrevOut(txIn.PreviousOutPoint, prevOuts[i])
			prevoutVectors = append(prevoutVectors, PrevoutVector{Script: hex.EncodeToString(prevOuts[i].PkScript), Value: prevOuts[i].Value})
		}
		sighash, err := txscript.CalcTapscriptSignaturehash(
			txscript.NewTxSigHashes(spendTx, fetcher), txscript.SigHashDefault, spendTx, inputIndex, fetcher, leaves[0],
		)
		check(err)
		var msg [xmss.MsgLen]byte
		copy(msg[:], sighash)
		sig, err := xmss.Sign(item.uid, k.sk, msg)
		check(err)

		finalTx := spendTx.Copy()
		witness := wire.TxWitness{}
		chunk := xmss.SignatureLen / 5
		for i := 0; i < 5; i++ {
			witness = append(witness, sig[i*chunk:(i+1)*chunk])
		}
		finalTx.TxIn[inputIndex].SetWitness(append(witness, xmssLeaf, cb))
		if keyPathPriv != nil {
			keySig, err := txscript.RawTxInTaprootSignature(
				finalTx, txscript.NewTxSigHashes(finalTx, fetcher), 0, prevOuts[0].Value,
				prevOuts[0].PkScript, nil, txscript.SigHashDefault, keyPathPriv,
			)
			check(err)
			finalTx.TxIn[0].SetWitness(wire.TxWitness{keySig})
		}
		verifyInputs(finalTx, prevOuts)

		var leafScripts []string
		for _, leaf := range leaves {
			leafScripts = append(leafScripts, hex.EncodeToString(leaf.Script))
		}
		vectors.XMSS.Spends = append(vectors.XMSS.Spends, XMSSSpendVector{
			Name: item.name, Key: item.key, MsgUID: item.uid, LeafScripts: leafScripts, LeafIndex: 0,
			InputIndex: inputIndex, Prevouts: prevoutVectors, ControlBlock: hex.EncodeToString(cb),
			UnsignedTxHex: unsignedHex, Sighash: hex.EncodeToString(sighash), Signature: hex.EncodeToString(sig[:]),
			FinalTxHex: serializeTx(finalTx, true), TxID: finalTx.TxID(),
		})
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

	// Relay policy, on edits of one standard P2TR spend.
	policyP2TR := append([]byte{txscript.OP_1, txscript.OP_DATA_32}, patternBytes(32, 7)...)
	policyP2MR := append([]byte{txscript.OP_2, txscript.OP_DATA_32}, patternBytes(32, 8)...)
	for _, item := range []struct {
		name   string
		script []byte
		value  int64
	}{
		{"p2tr-under", policyP2TR, 332},
		{"p2tr-at", policyP2TR, 333},
		{"p2mr-under", policyP2MR, 332},
		{"p2wpkh-at", append([]byte{txscript.OP_0, txscript.OP_DATA_20}, patternBytes(20, 9)...), 297},
		{"bare-op-true-under", []byte{txscript.OP_TRUE}, 473},
		{"bare-op-true-at", []byte{txscript.OP_TRUE}, 474},
		{"op-return", []byte{txscript.OP_RETURN}, 1_000_000},
		{"unparsable", []byte{txscript.OP_PUSHDATA1}, 1_000_000},
		{"over-max-script-size", make([]byte, txscript.MaxScriptSize+1), 1_000_000_000},
		{"over-max-grain", policyP2TR, btcutil.MaxGrain + 1},
	} {
		out := wire.NewTxOut(item.value, item.script)
		vectors.Policy.Dust = append(vectors.Policy.Dust, DustVector{
			Name: item.name, Script: hex.EncodeToString(item.script), Threshold: mempool.GetDustThreshold(out),
			Value: item.value, Dust: mempool.IsDust(out, mempool.DefaultMinRelayTxFee),
		})
	}
	const policyHeight, policyTime = 1000, 1_700_000_000
	policyTx := func() *wire.MsgTx {
		tx := wire.NewMsgTx(2)
		var prev chainhash.Hash
		copy(prev[:], patternBytes(32, 1))
		in := wire.NewTxIn(&wire.OutPoint{Hash: prev, Index: 0}, nil, nil)
		in.SetWitness(wire.TxWitness{patternBytes(64, 2)})
		tx.AddTxIn(in)
		tx.AddTxOut(wire.NewTxOut(10000, policyP2TR))
		tx.AddTxOut(wire.NewTxOut(5000, policyP2MR))
		return tx
	}
	timeLock := func(lockTime uint32) func(*wire.MsgTx) {
		return func(tx *wire.MsgTx) {
			tx.LockTime = lockTime
			tx.TxIn[0].Sequence = wire.MaxTxInSequenceNum - 1
		}
	}
	sigScript := func(script []byte) func(*wire.MsgTx) {
		return func(tx *wire.MsgTx) { tx.TxIn[0].SignatureScript = script }
	}
	pushData2 := func(n int) []byte {
		return append([]byte{txscript.OP_PUSHDATA2, byte(n), byte(n >> 8)}, make([]byte, n)...)
	}
	addOutput := func(value int64, script []byte) func(*wire.MsgTx) {
		return func(tx *wire.MsgTx) { tx.AddTxOut(wire.NewTxOut(value, script)) }
	}
	for _, item := range []struct {
		name        string
		edit        func(*wire.MsgTx)
		minRelayFee btcutil.Amount
	}{
		{"standard", func(*wire.MsgTx) {}, 0},
		{"version-1", func(tx *wire.MsgTx) { tx.Version = 1 }, 0},
		{"version-3", func(tx *wire.MsgTx) { tx.Version = 3 }, 0},
		{"version-0", func(tx *wire.MsgTx) { tx.Version = 0 }, 0},
		{"lock-height-not-reached", timeLock(policyHeight), 0},
		{"lock-height-reached", timeLock(policyHeight - 1), 0},
		{"lock-time-not-reached", timeLock(policyTime), 0},
		{"lock-time-reached", timeLock(policyTime - 1), 0},
		{"lock-ignored-by-final-sequence", func(tx *wire.MsgTx) { tx.LockTime = policyTime }, 0},
		{"over-max-vsize", addOutput(0, append([]byte{txscript.OP_RETURN}, make([]byte, 100_000)...)), 0},
		{"sig-script-at-limit", sigScript(pushData2(1647)), 0},
		{"sig-script-over-limit", sigScript(pushData2(1648)), 0},
		{"sig-script-not-push-only", sigScript([]byte{txscript.OP_NOP}), 0},
		{"p2wpkh-output", addOutput(10000, append([]byte{txscript.OP_0, txscript.OP_DATA_20}, patternBytes(20, 9)...)), 0},
		{"witness-v1-33-byte-output", addOutput(10000, append([]byte{txscript.OP_1, txscript.OP_DATA_33}, patternBytes(33, 9)...)), 0},
		{"dust-p2tr-output", addOutput(332, policyP2TR), 0},
		{"p2tr-output-at-dust-threshold", addOutput(333, policyP2TR), 0},
		{"dust-p2mr-output", addOutput(332, policyP2MR), 0},
		{"dust-at-higher-relay-fee", addOutput(1000, policyP2TR), 5000},
		{"dust-allowed-at-zero-relay-fee", addOutput(1, policyP2TR), -1},
		{"op-return-output", addOutput(0, []byte{txscript.OP_RETURN, txscript.OP_DATA_1, 1}), 0},
		{"op-return-not-push-only", addOutput(0, []byte{txscript.OP_RETURN, txscript.OP_NOP}), 0},
		{"two-op-return-outputs", func(tx *wire.MsgTx) {
			tx.AddTxOut(wire.NewTxOut(0, []byte{txscript.OP_RETURN}))
			tx.AddTxOut(wire.NewTxOut(0, []byte{txscript.OP_RETURN}))
		}, 0},
	} {
		tx := policyTx()
		item.edit(tx)
		fee := item.minRelayFee
		switch fee {
		case 0:
			fee = mempool.DefaultMinRelayTxFee
		case -1:
			fee = 0
		}
		errText := ""
		utx := btcutil.NewTx(tx)
		if err := blockchain.CheckTransactionSanity(utx); err != nil {
			errText = err.Error()
		} else if err := mempool.CheckTransactionStandard(utx, policyHeight, time.Unix(policyTime, 0), fee, 2); err != nil {
			errText = err.Error()
		}
		vectors.Policy.Standard = append(vectors.Policy.Standard, StandardVector{
			Name: item.name, TxHex: serializeTx(tx, true), Vsize: blockchain.GetTransactionVsize(utx),
			Height: policyHeight, MedianTimePast: policyTime, MinRelayFee: int64(fee), Error: errText,
		})
	}

	data, err := json.MarshalIndent(vectors, "", "  ")
	check(err)
	data = append(data, '\n')
	check(os.WriteFile(*out, data, 0o644))
}

func mustHex(s string) []byte {
	out, err := hex.DecodeString(s)
	check(err)
	return out
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

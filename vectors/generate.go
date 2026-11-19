// Run with a Pearl source checkout, after building its XMSS library with
// `make -C /path/to/pearl/xmss`:
// go -C /path/to/pearl/node run -tags xmss /path/to/pearljs/vectors/generate.go -out /path/to/pearljs/vectors/pearl-go.json
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"math/big"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/pearl-research-labs/pearl/node/blockchain"
	"github.com/pearl-research-labs/pearl/node/btcec"
	"github.com/pearl-research-labs/pearl/node/btcec/ecdsa"
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
	"github.com/pearl-research-labs/pearl/wallet/wallet"
	"github.com/pearl-research-labs/pearl/wallet/wallet/txauthor"
	"github.com/pearl-research-labs/pearl/wallet/wallet/txrules"
	"github.com/pearl-research-labs/pearl/wallet/wallet/txsizes"
	"github.com/pearl-research-labs/pearl/wallet/waddrmgr"
	"github.com/pearl-research-labs/pearl/wallet/walletdb"
	_ "github.com/pearl-research-labs/pearl/wallet/walletdb/bdb"
	bip39 "github.com/tyler-smith/go-bip39"
	"golang.org/x/crypto/hkdf"
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

// TapscriptSignatureVector is one signature of a TapscriptExtraVector. CodeSepPos
// is the opcode position of the last OP_CODESEPARATOR executed before the
// OP_CHECKSIG that takes it, 4294967295 when there is none.
type TapscriptSignatureVector struct {
	KeyIndex   int    `json:"keyIndex"`
	CodeSepPos uint32 `json:"codeSepPos"`
	Sighash    string `json:"sighash"`
	Signature  string `json:"signature"`
}

// TapscriptExtraVector is a script-path spend that carries an annex, runs
// OP_CODESEPARATOR before a signature check, or both. Signatures are in
// witness order. CodeSepPositions lists the opcode position of every
// OP_CODESEPARATOR in the leaf, from txscript's tokenizer. Pearl's script
// engine has accepted FinalTxHex.
type TapscriptExtraVector struct {
	Name             string                     `json:"name"`
	Kind             string                     `json:"kind"`
	HashType         uint32                     `json:"hashType"`
	Prevouts         []PrevoutVector            `json:"prevouts"`
	LeafScript       string                     `json:"leafScript"`
	ControlBlock     string                     `json:"controlBlock"`
	Annex            string                     `json:"annex"`
	CodeSepPositions []int32                    `json:"codeSepPositions"`
	UnsignedTxHex    string                     `json:"unsignedTxHex"`
	Signatures       []TapscriptSignatureVector `json:"signatures"`
	FinalTxHex       string                     `json:"finalTxHex"`
	TxID             string                     `json:"txid"`
}

// CustomLeafVector is a spend through a leaf that takes more than
// signatures. Stack is the witness without the leaf script and control
// block; the item at SignatureAt, when not -1, is the signature of the key at
// account/0/KeyIndex.
type CustomLeafVector struct {
	Name           string          `json:"name"`
	Kind           string          `json:"kind"`
	InternalPubKey string          `json:"internalPubKey"`
	Prevouts       []PrevoutVector `json:"prevouts"`
	LeafScript     string          `json:"leafScript"`
	ControlBlock   string          `json:"controlBlock"`
	UnsignedTxHex  string          `json:"unsignedTxHex"`
	KeyIndex       int             `json:"keyIndex"`
	SignatureAt    int             `json:"signatureAt"`
	Sighash        string          `json:"sighash"`
	Stack          []string        `json:"stack"`
	FinalTxHex     string          `json:"finalTxHex"`
	TxID           string          `json:"txid"`
}

// ChangeOutputVector is a PSBT whose output OutputIndex carries the
// derivation Oyster records for a change output of its own.
type ChangeOutputVector struct {
	Name          string `json:"name"`
	Change        bool   `json:"change"`
	Index         uint32 `json:"index"`
	OutputIndex   int    `json:"outputIndex"`
	Path          string `json:"path"`
	UnsignedTxHex string `json:"unsignedTxHex"`
	PSBT          string `json:"psbt"`
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
	MessageFormats   []MessageFormatVector   `json:"messageFormats"`
	MultiASpends     []MultiASpendVector     `json:"multiASpends"`
	ScriptToolkit    ScriptToolkitVectors    `json:"scriptToolkit"`
	WIF              []WIFVector             `json:"wif"`
	BadWIF           []BadWIFVector          `json:"badWif"`
	BadBlocks        []BadBlockVector        `json:"badBlocks"`
	Policy           PolicyVectors           `json:"policy"`
	P2MRPSBTs        []P2MRPSBTVector        `json:"p2mrPsbts"`
	Leaves           LeafBuilderVectors      `json:"leaves"`
	Mempool          []MempoolScenarioVector `json:"mempool"`
	Consensus        ConsensusVectors        `json:"consensus"`
	CoinSelection    CoinSelectionVectors    `json:"coinSelection"`
	TapscriptExtras  []TapscriptExtraVector  `json:"tapscriptExtras"`
	CustomLeaves     []CustomLeafVector      `json:"customLeaves"`
	ChangeOutputs    []ChangeOutputVector    `json:"changeOutputs"`
	Recovery         RecoveryVectors         `json:"recovery"`
	HTLCs            []HTLCSpendVector       `json:"htlcs"`
}

// RecoveryWalletVector is a wallet Oyster's own code created from Input, as
// its --createfromfile does (wallet/walletsetup.go): a valid BIP39 mnemonic
// becomes bip39.NewSeed(Input, ""), anything else is read as a hex seed. Its
// addresses are the first ones Oyster's address manager hands out on the
// receive and change branches of Account.
type RecoveryWalletVector struct {
	Name        string   `json:"name"`
	Network     string   `json:"network"`
	Input       string   `json:"input"`
	Kind        string   `json:"kind"`
	Seed        string   `json:"seed"`
	Account     uint32   `json:"account"`
	AccountPath string   `json:"accountPath"`
	AccountXPub string   `json:"accountXpub"`
	Receive     []string `json:"receive"`
	Change      []string `json:"change"`
}

// PQAddressVector is an address Oyster's getnewaddress (or
// getrawchangeaddress) handed out with pq=true before Pearl removed that
// argument (pearl-research-labs/pearl#463): the BIP86 key of Path tweaked
// with the root of one leaf, <xmss_pubkey> OP_CHECKXMSSSIG, whose XMSS key
// came from the private key at the same path under purpose 222 through
// HKDF-SHA256 with info "XMSS-SEED-EXPANSION" (wallet/waddrmgr/xmss_keys.go
// at 0798903bced203de8cfcb49441f44fd9b51b18eb, rebuilt here from Pearl's
// current packages since the file is gone).
type PQAddressVector struct {
	Network       string `json:"network"`
	Mnemonic      string `json:"mnemonic"`
	Path          string `json:"path"`
	XMSSPublicKey string `json:"xmssPublicKey"`
	LeafScript    string `json:"leafScript"`
	TapscriptRoot string `json:"tapscriptRoot"`
	Address       string `json:"address"`
	PlainAddress  string `json:"plainAddress"`
}

type RecoveryVectors struct {
	RecoveryWindow uint32                 `json:"recoveryWindow"`
	Wallets        []RecoveryWalletVector `json:"wallets"`
	PQAddresses    []PQAddressVector      `json:"pqAddresses"`
}

// HTLCSpendVector is one spend of a two-leaf hash timelock tree, the claim
// leaf OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 (or OP_HASH160) <hash>
// OP_EQUALVERIFY <claim key> OP_CHECKSIG and the refund leaf <lock>
// OP_CHECKLOCKTIMEVERIFY (or OP_CHECKSEQUENCEVERIFY) OP_DROP <refund key>
// OP_CHECKSIG, in a P2TR output (with InternalPubKey) or a P2MR output.
// Stack is the witness items before the leaf script, signatures included;
// Error is what Pearl's script engine says of the spend, empty when it
// accepts it. Keys are account/0/ClaimKey and account/0/RefundKey.
type HTLCSpendVector struct {
	Name           string   `json:"name"`
	Container      string   `json:"container"`
	Lock           string   `json:"lock"`
	LockValue      int64    `json:"lockValue"`
	HashType       string   `json:"hashType"`
	Preimage       string   `json:"preimage"`
	Hash           string   `json:"hash"`
	ClaimKey       uint32   `json:"claimKey"`
	RefundKey      uint32   `json:"refundKey"`
	ClaimLeaf      string   `json:"claimLeaf"`
	RefundLeaf     string   `json:"refundLeaf"`
	InternalPubKey string   `json:"internalPubKey"`
	Root           string   `json:"root"`
	Address        string   `json:"address"`
	PrevScript     string   `json:"prevScript"`
	Value          int64    `json:"value"`
	LeafIndex      int      `json:"leafIndex"`
	ControlBlock   string   `json:"controlBlock"`
	UnsignedTxHex  string   `json:"unsignedTxHex"`
	Sighash        string   `json:"sighash"`
	Stack          []string `json:"stack"`
	SpendTxHex     string   `json:"spendTxHex"`
	Error          string   `json:"error"`
}

// CoinVector is an unspent output offered to coin selection.
type CoinVector struct {
	TxID   string `json:"txid"`
	Vout   uint32 `json:"vout"`
	Value  int64  `json:"value,string"`
	Script string `json:"script"`
}

// CoinSelectionVector is one run of txauthor.NewUnsignedTransaction. Strategy
// names how the coins reached it: "largest" and "random" go through Oyster's
// ArrangeCoins and its accumulating input source, "all" through the constant
// source it uses for user-selected outputs. Arranged is the order the input
// source saw; for "random" the shuffle is replaced by a sort on outpoint so
// the file is reproducible. ChangeScriptSize is what txauthor was told the
// change script measures, which sweepaccount gets wrong.
type CoinSelectionVector struct {
	Name             string          `json:"name"`
	Strategy         string          `json:"strategy"`
	FeeRate          int64           `json:"feeRate,string"`
	Coins            []CoinVector    `json:"coins"`
	Outputs          []PrevoutVector `json:"outputs"`
	ChangeScript     string          `json:"changeScript"`
	ChangeScriptSize int             `json:"changeScriptSize"`
	Arranged         []string        `json:"arranged"`
	Inputs           []string        `json:"inputs"`
	TotalInput       int64           `json:"totalInput,string"`
	Fee              int64           `json:"fee,string"`
	Change           int64           `json:"change,string"`
	ChangeIndex      int             `json:"changeIndex"`
	UnsignedTxHex    string          `json:"unsignedTxHex"`
	Error            string          `json:"error"`
}

// SizeEstimateVector is txsizes.EstimateVirtualSize for a count of key-path
// inputs, the given output scripts and a P2TR change output.
type SizeEstimateVector struct {
	Inputs  int      `json:"inputs"`
	Outputs []string `json:"outputs"`
	Vsize   int      `json:"vsize"`
}

type CoinSelectionVectors struct {
	CoinbaseMaturity uint16                `json:"coinbaseMaturity"`
	MinInputVsize    int                   `json:"minInputVsize"`
	SizeEstimates    []SizeEstimateVector  `json:"sizeEstimates"`
	Cases            []CoinSelectionVector `json:"cases"`
}

// P2MRPSBTInputVector is one input of a P2MRPSBTVector. Kind is "p2mr" for
// a script-path input or "p2tr-key" for a BIP86 key-path input at
// account/1/1. Signers are child indices under account/0, and Signatures and
// Sighashes follow them in order.
type P2MRPSBTInputVector struct {
	Kind          string   `json:"kind"`
	LeafScripts   []string `json:"leafScripts"`
	LeafIndex     int      `json:"leafIndex"`
	ControlBlock  string   `json:"controlBlock"`
	HashType      uint32   `json:"hashType"`
	PreviousTxHex string   `json:"previousTxHex"`
	Signers       []uint32 `json:"signers"`
	Sighash       string   `json:"sighash"`
	Signatures    []string `json:"signatures"`
}

// P2MRPSBTVector is a P2MR script-path spend in a PSBT built with Pearl's
// psbt package. Pearl has no P2MR-specific PSBT code, so the input carries
// the fields that package already has: the witness UTXO, the previous
// transaction when the signature does not cover input values, the sighash
// type, a tap leaf script keyed by the P2MR control block, and tap script
// signatures, with no internal key or Merkle root. ParseError fields hold
// the error psbt.NewFromRawBytes gives for the encoding, empty when it
// loads, and FinalizeError the error psbt.Finalize gives for a P2MR input.
type P2MRPSBTVector struct {
	Name               string                `json:"name"`
	UnsignedTxHex      string                `json:"unsignedTxHex"`
	Prevouts           []PrevoutVector       `json:"prevouts"`
	Inputs             []P2MRPSBTInputVector `json:"inputs"`
	PreparedPSBT       string                `json:"preparedPsbt"`
	PreparedParseError string                `json:"preparedParseError"`
	SignedPSBT         string                `json:"signedPsbt"`
	SignedParseError   string                `json:"signedParseError"`
	FinalizeError      string                `json:"finalizeError"`
	FinalTxHex         string                `json:"finalTxHex"`
	TxID               string                `json:"txid"`
	WTxID              string                `json:"wtxid"`
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

// MessageFormatVector is one message in the two other formats a Pearl key
// signs messages in. The BIP322 fields follow BIP-322's simple variant for
// the P2TR address of Path: the tagged message hash, both virtual
// transactions, the key-path sighash Pearl's txscript computes for to_sign,
// a signature TaprootWitnessSignature made over it, and whether Pearl's
// script engine accepts that signature. OysterAccepts is what Oyster's
// BIP322VerifyMessageSimple answers for the same signature. The Legacy fields
// are pearld's signmessagewithprivkey (node/rpcserver.go): ecdsa.SignCompact
// over the double SHA-256 of "Pearl Signed Message:\n" and the message, each
// written as a var string, for the same key as a compressed and an
// uncompressed WIF.
type MessageFormatVector struct {
	Name                 string `json:"name"`
	Path                 string `json:"path"`
	Address              string `json:"address"`
	Message              string `json:"message"`
	BIP322MessageHash    string `json:"bip322MessageHash"`
	BIP322ToSpendTxID    string `json:"bip322ToSpendTxid"`
	BIP322ToSignHex      string `json:"bip322ToSignHex"`
	BIP322Sighash        string `json:"bip322Sighash"`
	BIP322Signature      string `json:"bip322Signature"`
	BIP322Valid          bool   `json:"bip322Valid"`
	OysterAccepts        bool   `json:"oysterAccepts"`
	LegacyHash           string `json:"legacyHash"`
	LegacyWIF            string `json:"legacyWif"`
	LegacySignature      string `json:"legacySignature"`
	LegacyUncompressed   string `json:"legacyUncompressedSignature"`
	LegacyRecoveredKey   string `json:"legacyRecoveredKey"`
	LegacyRecoveredFlags bool   `json:"legacyRecoveredCompressed"`
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

// pearlScriptSpendStack returns the signature items Pearl's psbt.Finalize
// puts before the leaf script and control block. Finalize only accepts P2TR
// inputs, so it runs over a P2TR stand-in carrying the same leaf and
// signatures; the stack does not depend on the output type.
func pearlScriptSpendStack(leaf []byte, sigs []*psbt.TaprootScriptSpendSig) wire.TxWitness {
	key := bytes.Repeat([]byte{0}, 31)
	key = append(key, 1)
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0xff}, 0), nil, nil))
	tx.AddTxOut(wire.NewTxOut(1, []byte{txscript.OP_TRUE}))
	packet, err := psbt.NewFromUnsignedTx(tx)
	check(err)
	packet.Inputs[0].WitnessUtxo = wire.NewTxOut(1, append([]byte{txscript.OP_1, txscript.OP_DATA_32}, key...))
	packet.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
		ControlBlock: append([]byte{byte(txscript.BaseLeafVersion)}, key...), Script: leaf,
		LeafVersion: txscript.BaseLeafVersion,
	}}
	packet.Inputs[0].TaprootScriptSpendSig = sigs
	check(psbt.Finalize(packet, 0))
	final, err := psbt.Extract(packet)
	check(err)
	witness := final.TxIn[0].DecodeWitness()
	return witness[:len(witness)-2]
}

func parseError(encoded string) string {
	if _, err := psbt.NewFromRawBytes(strings.NewReader(encoded), true); err != nil {
		return err.Error()
	}
	return ""
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
	vectors.TapscriptExtras = tapscriptExtraVectors(account, internalPub, script)
	vectors.CustomLeaves = customLeafVectors(account, script)

	// The fields wallet.createOutputInfo (wallet/wallet/psbt.go:321) puts on
	// a change output: both derivation records and the internal key. The
	// function is unexported and needs a wallet database, so its struct is
	// rebuilt here and serialized by the psbt package.
	for _, item := range []struct {
		name   string
		branch uint32
		index  uint32
	}{
		{"change-chain", 1, 7},
		{"receive-chain", 0, 2147483647},
	} {
		pub, err := derive(account, item.branch, item.index).ECPubKey()
		check(err)
		changeScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(pub))
		check(err)
		tx := wire.NewMsgTx(wire.TxVersion)
		tx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0d}, 0), nil, nil))
		tx.AddTxOut(wire.NewTxOut(150000000, script))
		tx.AddTxOut(wire.NewTxOut(49990000, changeScript))
		packet, err := psbt.NewFromUnsignedTx(tx)
		check(err)
		path := []uint32{86 + h, chaincfg.MainNetParams.HDCoinType + h, h, item.branch, item.index}
		compressed := pub.SerializeCompressed()
		packet.Outputs[1] = psbt.POutput{
			Bip32Derivation: []*psbt.Bip32Derivation{{
				PubKey: compressed, MasterKeyFingerprint: masterFingerprint, Bip32Path: path,
			}},
			TaprootBip32Derivation: []*psbt.TaprootBip32Derivation{{
				XOnlyPubKey: compressed[1:], MasterKeyFingerprint: masterFingerprint, Bip32Path: path,
			}},
			TaprootInternalKey: compressed[1:],
		}
		vectors.ChangeOutputs = append(vectors.ChangeOutputs, ChangeOutputVector{
			Name: item.name, Change: item.branch == 1, Index: item.index, OutputIndex: 1,
			Path:          fmt.Sprintf("%s/%d/%d", accountPath, item.branch, item.index),
			UnsignedTxHex: serializeTx(tx, false), PSBT: encodePSBT(packet),
		})
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

	// P2MR script-path inputs in PSBTs. Leaves are leafKeyScripts, or a
	// 2-of-3 multi_a leaf over account/0/20..22 followed by them.
	multiALeaf := func() []byte {
		builder := txscript.NewScriptBuilder()
		for i := uint32(0); i < 3; i++ {
			priv, err := derive(account, 0, 20+i).ECPrivKey()
			check(err)
			builder.AddData(schnorr.SerializePubKey(priv.PubKey()))
			if i == 0 {
				builder.AddOp(txscript.OP_CHECKSIG)
			} else {
				builder.AddOp(txscript.OP_CHECKSIGADD)
			}
		}
		leafScript, err := builder.AddInt64(2).AddOp(txscript.OP_NUMEQUAL).Script()
		check(err)
		return leafScript
	}()
	type p2mrPSBTInput struct {
		kind       string
		leafCount  int
		multiA     bool
		leafIndex  int
		hashType   txscript.SigHashType
		previousTx bool
		signers    []uint32
	}
	for vectorIndex, item := range []struct {
		name   string
		inputs []p2mrPSBTInput
	}{
		{"p2mr-1-leaf-default", []p2mrPSBTInput{{"p2mr", 1, false, 0, txscript.SigHashDefault, true, []uint32{0}}}},
		{"p2mr-2-leaves-first-default", []p2mrPSBTInput{{"p2mr", 2, false, 0, txscript.SigHashDefault, true, []uint32{0}}}},
		{"p2mr-4-leaves-third-all", []p2mrPSBTInput{{"p2mr", 4, false, 2, txscript.SigHashAll, true, []uint32{2}}}},
		{"p2mr-3-leaves-first-none", []p2mrPSBTInput{{"p2mr", 3, false, 0, txscript.SigHashNone, true, []uint32{0}}}},
		{"p2mr-2-leaves-second-single-anyonecanpay", []p2mrPSBTInput{
			{"p2mr", 2, false, 1, txscript.SigHashSingle | txscript.SigHashAnyOneCanPay, false, []uint32{1}},
		}},
		{"p2mr-with-p2tr-key-input", []p2mrPSBTInput{
			{"p2tr-key", 0, false, 0, txscript.SigHashDefault, false, nil},
			{"p2mr", 3, false, 1, txscript.SigHashDefault, false, []uint32{1}},
		}},
		{"p2mr-two-inputs-default", []p2mrPSBTInput{
			{"p2mr", 2, false, 1, txscript.SigHashDefault, true, []uint32{1}},
			{"p2mr", 5, false, 4, txscript.SigHashDefault, true, []uint32{4}},
		}},
		{"p2mr-multi-a-2-of-3-default", []p2mrPSBTInput{{"p2mr", 3, true, 0, txscript.SigHashDefault, true, []uint32{20, 22}}}},
	} {
		const amount int64 = 120_000_000
		spendTx := wire.NewMsgTx(2)
		spendTx.LockTime = 800
		var prevOuts []*wire.TxOut
		var previousTxs []*wire.MsgTx
		var leafSets [][]txscript.TapLeaf
		var keyPathPriv *btcec.PrivateKey
		for i, input := range item.inputs {
			var prevScript []byte
			var leaves []txscript.TapLeaf
			if input.kind == "p2tr-key" {
				keyPathPriv, err = derive(account, 1, 1).ECPrivKey()
				check(err)
				prevScript, err = txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(keyPathPriv.PubKey()))
				check(err)
			} else {
				leaves, _ = leafKeyScripts(account, input.leafCount)
				if input.multiA {
					leaves = append([]txscript.TapLeaf{txscript.NewBaseTapLeaf(multiALeaf)}, leaves[:input.leafCount-1]...)
				}
				root := txscript.AssembleTaprootScriptTree(leaves...).RootNode.TapHash()
				mrAddr, err := btcutil.NewAddressMerkleRoot(root[:], &chaincfg.MainNetParams)
				check(err)
				prevScript, err = txscript.PayToAddrScript(mrAddr)
				check(err)
			}
			prevOut := wire.NewTxOut(amount+int64(i)*1_000_000, prevScript)
			outPoint := wire.NewOutPoint(&chainhash.Hash{0x40 + byte(vectorIndex), byte(i)}, uint32(i))
			var previous *wire.MsgTx
			if input.previousTx {
				// The spent output sits at index 1 so a lookup by index is exercised.
				previous = wire.NewMsgTx(2)
				previous.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x50 + byte(vectorIndex), byte(i)}, 0), nil, nil))
				previous.AddTxOut(wire.NewTxOut(5_000, script))
				previous.AddTxOut(prevOut)
				hash := previous.TxHash()
				outPoint = wire.NewOutPoint(&hash, 1)
			}
			txIn := wire.NewTxIn(outPoint, nil, nil)
			txIn.Sequence = 0xfffffffd
			spendTx.AddTxIn(txIn)
			prevOuts = append(prevOuts, prevOut)
			previousTxs = append(previousTxs, previous)
			leafSets = append(leafSets, leaves)
		}
		for i := range item.inputs {
			spendTx.AddTxOut(wire.NewTxOut(amount-9_000+int64(i)*1_000_000, script))
		}

		packet, err := psbt.NewFromUnsignedTx(spendTx)
		check(err)
		updater, err := psbt.NewUpdater(packet)
		check(err)
		fetcher := txscript.NewMultiPrevOutFetcher(nil)
		vector := P2MRPSBTVector{Name: item.name, UnsignedTxHex: serializeTx(spendTx, false)}
		for i, input := range item.inputs {
			fetcher.AddPrevOut(spendTx.TxIn[i].PreviousOutPoint, prevOuts[i])
			vector.Prevouts = append(vector.Prevouts, PrevoutVector{
				Script: hex.EncodeToString(prevOuts[i].PkScript), Value: prevOuts[i].Value,
			})
			if previousTxs[i] != nil {
				check(updater.AddInNonWitnessUtxo(previousTxs[i], i))
			}
			check(updater.AddInWitnessUtxo(prevOuts[i], i))
			pInput := &packet.Inputs[i]
			pInput.SighashType = input.hashType
			inputVector := P2MRPSBTInputVector{
				Kind: input.kind, LeafIndex: input.leafIndex, HashType: uint32(input.hashType), Signers: []uint32{},
				LeafScripts: []string{},
			}
			if previousTxs[i] != nil {
				var buf bytes.Buffer
				check(previousTxs[i].Serialize(&buf))
				inputVector.PreviousTxHex = hex.EncodeToString(buf.Bytes())
			}
			if input.kind == "p2tr-key" {
				internalKey := schnorr.SerializePubKey(keyPathPriv.PubKey())
				pInput.TaprootInternalKey = internalKey
				pInput.TaprootBip32Derivation = []*psbt.TaprootBip32Derivation{{
					XOnlyPubKey: internalKey, MasterKeyFingerprint: masterFingerprint,
					Bip32Path: []uint32{86 + h, chaincfg.MainNetParams.HDCoinType + h, h, 1, 1},
				}}
			} else {
				leaves := leafSets[i]
				tree := txscript.AssembleTaprootScriptTree(leaves...)
				block := txscript.MerkleRootControlBlock{
					LeafVersion: txscript.BaseLeafVersion, InclusionProof: tree.LeafMerkleProofs[input.leafIndex].InclusionProof,
				}
				controlBlock, err := block.ToBytes()
				check(err)
				leaf := leaves[input.leafIndex]
				pInput.TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
					ControlBlock: controlBlock, Script: leaf.Script, LeafVersion: leaf.LeafVersion,
				}}
				for _, l := range leaves {
					inputVector.LeafScripts = append(inputVector.LeafScripts, hex.EncodeToString(l.Script))
				}
				inputVector.ControlBlock = hex.EncodeToString(controlBlock)
			}
			vector.Inputs = append(vector.Inputs, inputVector)
		}
		vector.PreparedPSBT = encodePSBT(packet)
		vector.PreparedParseError = parseError(vector.PreparedPSBT)

		sigHashes := txscript.NewTxSigHashes(spendTx, fetcher)
		for i, input := range item.inputs {
			inputVector := &vector.Inputs[i]
			if input.kind == "p2tr-key" {
				sighash, err := txscript.CalcTaprootSignatureHash(sigHashes, input.hashType, spendTx, i, fetcher)
				check(err)
				signature, err := txscript.RawTxInTaprootSignature(
					spendTx, sigHashes, i, prevOuts[i].Value, prevOuts[i].PkScript, nil, input.hashType, keyPathPriv,
				)
				check(err)
				packet.Inputs[i].TaprootKeySpendSig = signature
				inputVector.Sighash = hex.EncodeToString(sighash)
				inputVector.Signatures = []string{hex.EncodeToString(signature)}
				continue
			}
			leaf := leafSets[i][input.leafIndex]
			leafHash := leaf.TapHash()
			sighash, err := txscript.CalcTapscriptSignaturehash(sigHashes, input.hashType, spendTx, i, fetcher, leaf)
			check(err)
			inputVector.Sighash = hex.EncodeToString(sighash)
			inputVector.Signers = input.signers
			// Pearl serializes signatures for one leaf in the order they were
			// added, and BIP174 orders keys bytewise, so add them sorted.
			var sigs []*psbt.TaprootScriptSpendSig
			for _, signer := range input.signers {
				priv, err := derive(account, 0, signer).ECPrivKey()
				check(err)
				signature, err := txscript.RawTxInTapscriptSignature(
					spendTx, sigHashes, i, prevOuts[i].Value, prevOuts[i].PkScript, leaf, input.hashType, priv,
				)
				check(err)
				inputVector.Signatures = append(inputVector.Signatures, hex.EncodeToString(signature))
				sigs = append(sigs, &psbt.TaprootScriptSpendSig{
					XOnlyPubKey: schnorr.SerializePubKey(priv.PubKey()), LeafHash: leafHash[:],
					Signature: signature[:schnorr.SignatureSize], SigHash: input.hashType,
				})
			}
			sort.Slice(sigs, func(a, b int) bool { return bytes.Compare(sigs[a].XOnlyPubKey, sigs[b].XOnlyPubKey) < 0 })
			packet.Inputs[i].TaprootScriptSpendSig = sigs
		}
		vector.SignedPSBT = encodePSBT(packet)
		vector.SignedParseError = parseError(vector.SignedPSBT)

		for i, input := range item.inputs {
			if input.kind == "p2tr-key" {
				check(psbt.Finalize(packet, i))
				continue
			}
			if err := psbt.Finalize(packet, i); err != nil {
				vector.FinalizeError = err.Error()
			} else {
				panic("psbt.Finalize accepted a P2MR input")
			}
			// Finish the input the way finalizeTaprootInput does for P2TR.
			pInput := packet.Inputs[i]
			leaf := pInput.TaprootLeafScript[0]
			witness := pearlScriptSpendStack(leaf.Script, pInput.TaprootScriptSpendSig)
			witness = append(witness, leaf.Script, leaf.ControlBlock)
			var witnessBytes bytes.Buffer
			check(psbt.WriteTxWitness(&witnessBytes, witness))
			finished := psbt.NewPsbtInput(nil, pInput.WitnessUtxo)
			finished.FinalScriptWitness = witnessBytes.Bytes()
			packet.Inputs[i] = *finished
		}
		finalTx, err := psbt.Extract(packet)
		check(err)
		verifyInputs(finalTx, prevOuts)
		vector.FinalTxHex = serializeTx(finalTx, true)
		vector.TxID = finalTx.TxID()
		vector.WTxID = finalTx.WitnessHash().String()
		vectors.P2MRPSBTs = append(vectors.P2MRPSBTs, vector)
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

	vectors.MessageFormats = messageFormatVectors(privM0, addrM0, accountPath+"/0/0")

	vectors.Recovery = recoveryVectors(nets)

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

	vectors.Leaves = leafBuilderVectors(account, internalPub)
	vectors.HTLCs = htlcVectors(account, internalPub)
	vectors.Mempool = mempoolVectors()
	vectors.Consensus = consensusVectors(nets)

	vectors.CoinSelection = coinSelectionVectors()

	data, err := json.MarshalIndent(vectors, "", "  ")
	check(err)
	data = append(data, '\n')
	check(os.WriteFile(*out, data, 0o644))
}

// bip322Transactions builds BIP-322's to_spend and to_sign for a message
// and an output script, with to_sign's witness left empty.
func bip322Transactions(message []byte, pkScript []byte) (chainhash.Hash, *wire.MsgTx, *wire.MsgTx) {
	hash := chainhash.TaggedHash([]byte("BIP0322-signed-message"), message)
	sigScript, err := txscript.NewScriptBuilder().AddOp(txscript.OP_0).AddData(hash[:]).Script()
	check(err)
	toSpend := wire.NewMsgTx(0)
	toSpend.AddTxIn(&wire.TxIn{
		PreviousOutPoint: wire.OutPoint{Index: 0xffffffff}, SignatureScript: sigScript, Sequence: 0,
	})
	toSpend.AddTxOut(wire.NewTxOut(0, pkScript))
	toSign := wire.NewMsgTx(0)
	toSpendHash := toSpend.TxHash()
	toSign.AddTxIn(&wire.TxIn{PreviousOutPoint: *wire.NewOutPoint(&toSpendHash, 0), Sequence: 0})
	toSign.AddTxOut(wire.NewTxOut(0, []byte{txscript.OP_RETURN}))
	return *hash, toSpend, toSign
}

func messageFormatVectors(priv *btcec.PrivateKey, addr *btcutil.AddressTaproot, path string) []MessageFormatVector {
	pkScript, err := txscript.PayToAddrScript(addr)
	check(err)
	var out []MessageFormatVector
	for _, item := range []struct {
		name    string
		message string
	}{
		{"empty", ""},
		{"hello", "Hello World"},
		{"utf8", "h\u00e9llo w\u00f6rld \u2713"},
		{"payout-registration", "I set mdl1qexampleexampleexampleexampleexample"},
		{"three-hundred-bytes", strings.Repeat("0123456789", 30)},
	} {
		message := []byte(item.message)
		hash, toSpend, toSign := bip322Transactions(message, pkScript)
		fetcher := txscript.NewCannedPrevOutputFetcher(pkScript, 0)
		sigHashes := txscript.NewTxSigHashes(toSign, fetcher)
		sighash, err := txscript.CalcTaprootSignatureHash(sigHashes, txscript.SigHashDefault, toSign, 0, fetcher)
		check(err)
		witness, err := txscript.TaprootWitnessSignature(toSign, sigHashes, 0, 0, pkScript, txscript.SigHashDefault, priv)
		check(err)
		unsigned := serializeTx(toSign, false)
		toSign.TxIn[0].SetWitness(witness)
		engine, err := txscript.NewEngine(pkScript, toSign, 0, txscript.StandardVerifyFlags, nil, sigHashes, 0, fetcher)
		check(err)
		valid := engine.Execute() == nil
		encoded, err := jsonrpc.SerializeWitnessStack(witness)
		check(err)
		signature := base64.StdEncoding.EncodeToString(encoded)
		oysterAccepts := false
		if len(message) <= txscript.MaxDataCarrierSize {
			oysterAccepts, err = jsonrpc.BIP322VerifyMessageSimple(addr, signature, item.message)
			check(err)
		}

		var buf bytes.Buffer
		check(wire.WriteVarString(&buf, 0, "Pearl Signed Message:\n"))
		check(wire.WriteVarString(&buf, 0, item.message))
		legacyHash := chainhash.DoubleHashB(buf.Bytes())
		wif, err := btcutil.NewWIF(priv, &chaincfg.MainNetParams, true)
		check(err)
		compact := ecdsa.SignCompact(wif.PrivKey, legacyHash, wif.CompressPubKey)
		uncompressed := ecdsa.SignCompact(priv, legacyHash, false)
		recovered, compressed, err := ecdsa.RecoverCompact(compact, legacyHash)
		check(err)

		out = append(out, MessageFormatVector{
			Name: item.name, Path: path, Address: addr.String(), Message: item.message,
			BIP322MessageHash: hex.EncodeToString(hash[:]), BIP322ToSpendTxID: toSpend.TxHash().String(),
			BIP322ToSignHex: unsigned, BIP322Sighash: hex.EncodeToString(sighash),
			BIP322Signature: signature, BIP322Valid: valid, OysterAccepts: oysterAccepts,
			LegacyHash: hex.EncodeToString(legacyHash), LegacyWIF: wif.String(),
			LegacySignature:    base64.StdEncoding.EncodeToString(compact),
			LegacyUncompressed: base64.StdEncoding.EncodeToString(uncompressed),
			LegacyRecoveredKey: hex.EncodeToString(recovered.SerializeCompressed()), LegacyRecoveredFlags: compressed,
		})
	}
	return out
}

// oysterWallet creates a wallet with Oyster's loader in a fresh directory and
// returns the first addresses its address manager hands out.
func oysterWallet(params *chaincfg.Params, seed []byte, account uint32, count int) (string, []string, []string) {
	waddrmgr.InitKeyScopes(params.HDCoinType)
	dir, err := os.MkdirTemp("", "oyster-vector-")
	check(err)
	defer os.RemoveAll(dir)
	privPass := []byte("vector")
	loader := wallet.NewLoader(params, dir, true, time.Minute, 250)
	w, err := loader.CreateNewWallet([]byte(wallet.InsecurePubPassphrase), privPass, seed, time.Unix(1724644369, 0))
	check(err)
	defer func() { check(loader.UnloadWallet()) }()
	scoped, err := w.Manager.FetchScopedKeyManager(waddrmgr.KeyScopeBIP0086)
	check(err)
	var xpub string
	var receive, change []string
	check(walletdb.Update(w.Database(), func(tx walletdb.ReadWriteTx) error {
		ns := tx.ReadWriteBucket([]byte("waddrmgr"))
		if account != 0 {
			check(w.Manager.Unlock(ns, privPass))
			created, err := scoped.NewAccount(ns, fmt.Sprintf("account-%d", account))
			check(err)
			if created != account {
				panic("Oyster numbered the new account differently")
			}
		}
		props, err := scoped.AccountProperties(ns, account)
		check(err)
		xpub = props.AccountPubKey.String()
		external, err := scoped.NextExternalAddresses(ns, account, uint32(count))
		check(err)
		internal, err := scoped.NextInternalAddresses(ns, account, uint32(count))
		check(err)
		for _, a := range external {
			receive = append(receive, a.Address().EncodeAddress())
		}
		for _, a := range internal {
			change = append(change, a.Address().EncodeAddress())
		}
		return nil
	}))
	return xpub, receive, change
}

func recoveryVectors(nets []*chaincfg.Params) RecoveryVectors {
	out := RecoveryVectors{RecoveryWindow: 250}
	const abandon = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
	const legal = "legal winner thank year wave sausage worth useful legal winner thank yellow"
	const zoo24 = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote"
	type input struct {
		name    string
		input   string
		account uint32
	}
	inputs := []input{
		{"abandon", abandon, 0},
		{"legal-winner", legal, 0},
		{"zoo-24", zoo24, 0},
		// Oyster validates with strings.Fields but hashes the phrase as given,
		// so a double space or a newline makes another seed.
		{"abandon-double-space", strings.Replace(abandon, " ", "  ", 1), 0},
		{"abandon-newlines", strings.ReplaceAll(abandon, " about", "\nabout"), 0},
		{"hex-seed", "000102030405060708090a0b0c0d0e0f", 0},
		{"abandon-account-1", abandon, 1},
	}
	for _, params := range nets {
		for _, item := range inputs {
			if params.Name != chaincfg.MainNetParams.Name && item.name != "abandon" {
				continue
			}
			vector := RecoveryWalletVector{
				Name: item.name, Network: params.Name, Input: item.input, Account: item.account,
				AccountPath: fmt.Sprintf("m/86'/%d'/%d'", params.HDCoinType, item.account),
			}
			var seed []byte
			if bip39.IsMnemonicValid(item.input) {
				vector.Kind = "mnemonic"
				seed = bip39.NewSeed(item.input, "")
			} else {
				vector.Kind = "hex"
				seed = mustHex(item.input)
			}
			vector.Seed = hex.EncodeToString(seed)
			vector.AccountXPub, vector.Receive, vector.Change = oysterWallet(params, seed, item.account, 3)
			out.Wallets = append(out.Wallets, vector)
		}
	}
	waddrmgr.InitKeyScopes(chaincfg.MainNetParams.HDCoinType)

	h := uint32(hdkeychain.HardenedKeyStart)
	for _, params := range []*chaincfg.Params{&chaincfg.MainNetParams, &chaincfg.TestNet2Params} {
		master, err := hdkeychain.NewMaster(bip39.NewSeed(abandon, ""), params)
		check(err)
		for _, child := range []struct{ branch, index uint32 }{{0, 0}, {1, 0}, {0, 1}} {
			if params != &chaincfg.MainNetParams && child.index != 0 {
				continue
			}
			pqKey, err := derive(master, 222+h, params.HDCoinType+h, h, child.branch, child.index).ECPrivKey()
			check(err)
			seeds := make([]byte, xmss.PrivateSeedLen+xmss.PublicSeedLen)
			_, err = io.ReadFull(hkdf.New(sha256.New, pqKey.Serialize(), nil, []byte("XMSS-SEED-EXPANSION")), seeds)
			check(err)
			var privSeed [xmss.PrivateSeedLen]byte
			var pubSeed [xmss.PublicSeedLen]byte
			copy(privSeed[:], seeds[:xmss.PrivateSeedLen])
			copy(pubSeed[:], seeds[xmss.PrivateSeedLen:])
			pk, _, err := xmss.Keygen(privSeed, pubSeed)
			check(err)
			leaf, err := txscript.NewScriptBuilder().AddData(pk[:]).AddOp(txscript.OP_CHECKXMSSSIG).Script()
			check(err)
			root := txscript.AssembleTaprootScriptTree(txscript.NewBaseTapLeaf(leaf)).RootNode.TapHash()
			internal, err := derive(master, 86+h, params.HDCoinType+h, h, child.branch, child.index).ECPubKey()
			check(err)
			pqAddr, err := btcutil.NewAddressTaproot(schnorr.SerializePubKey(txscript.ComputeTaprootOutputKey(internal, root[:])), params)
			check(err)
			plain, err := btcutil.NewAddressTaproot(schnorr.SerializePubKey(txscript.ComputeTaprootKeyNoScript(internal)), params)
			check(err)
			out.PQAddresses = append(out.PQAddresses, PQAddressVector{
				Network: params.Name, Mnemonic: abandon,
				Path:          fmt.Sprintf("m/86'/%d'/0'/%d/%d", params.HDCoinType, child.branch, child.index),
				XMSSPublicKey: hex.EncodeToString(pk[:]), LeafScript: hex.EncodeToString(leaf),
				TapscriptRoot: hex.EncodeToString(root[:]), Address: pqAddr.EncodeAddress(), PlainAddress: plain.EncodeAddress(),
			})
		}
	}
	return out
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

// TimelockSpendVector is a CLTV or CSV leaf over the key at account/0/KeyIndex,
// spent through P2TR by a transaction that Pearl's script engine accepts when
// Error is empty and refuses with Error otherwise.
type TimelockSpendVector struct {
	Name       string        `json:"name"`
	Kind       string        `json:"kind"`
	Value      int64         `json:"value"`
	KeyIndex   uint32        `json:"keyIndex"`
	LeafScript string        `json:"leafScript"`
	Prevout    PrevoutVector `json:"prevout"`
	SpendTxHex string        `json:"spendTxHex"`
	Error      string        `json:"error"`
}

// SequenceVector is blockchain.LockTimeToSequence(IsSeconds, LockTime).
type SequenceVector struct {
	IsSeconds bool   `json:"isSeconds"`
	LockTime  uint32 `json:"lockTime"`
	Sequence  uint32 `json:"sequence"`
}

type LeafBuilderVectors struct {
	Timelocks []TimelockSpendVector `json:"timelocks"`
	Sequences []SequenceVector      `json:"sequences"`
	// MultiA is a 17-of-18 multi_a leaf, whose threshold is a data push
	// rather than a small-int opcode, finalized by psbt.Finalize.
	MultiA MultiASpendVector `json:"multiA"`
}

// MempoolTxVector is one transaction offered to a TxPool. Error is the
// pool's refusal, empty when it was accepted.
type MempoolTxVector struct {
	Name  string `json:"name"`
	TxHex string `json:"txHex"`
	Fee   int64  `json:"fee"`
	Vsize int64  `json:"vsize"`
	Error string `json:"error"`
}

// MempoolScenarioVector offers Transactions in order to a fresh TxPool with
// the production package limits and default relay fee.
type MempoolScenarioVector struct {
	Name              string            `json:"name"`
	RejectReplacement bool              `json:"rejectReplacement"`
	Transactions      []MempoolTxVector `json:"transactions"`
}

type CheckpointVector struct {
	Height int32  `json:"height"`
	Hash   string `json:"hash"`
}

// CertRuleVector is blockchain.CheckCertificateRules (with BFNoPoWCheck, so
// the rank-penalty rule is skipped) for a certificate of Version carrying
// PublicDataLen bytes of public data, at Height.
type CertRuleVector struct {
	Height        int32  `json:"height"`
	Version       uint32 `json:"version"`
	PublicDataLen int    `json:"publicDataLen"`
	Required      uint32 `json:"required"`
	Error         string `json:"error"`
}

// HeightAmountVector carries Amount as a string, since supplies pass 2^53.
type HeightAmountVector struct {
	Height int32 `json:"height"`
	Amount int64 `json:"amount,string"`
}

type DifficultyVector struct {
	Bits       uint32  `json:"bits"`
	Difficulty float64 `json:"difficulty"`
}

type ConsensusNetworkVector struct {
	Name                  string               `json:"name"`
	MoEForkHeight         int32                `json:"moeForkHeight"`
	DenseOnlyForkHeight   int32                `json:"denseOnlyForkHeight"`
	RankPenaltyForkHeight int32                `json:"rankPenaltyForkHeight"`
	SaltedSeedForkHeight  int32                `json:"saltedSeedForkHeight"`
	Checkpoints           []CheckpointVector   `json:"checkpoints"`
	DNSSeeds              []string             `json:"dnsSeeds"`
	TargetTimePerBlock    int64                `json:"targetTimePerBlock"`
	WTEMAHalfLife         int64                `json:"wtemaHalfLife"`
	PowLimit              string               `json:"powLimit"`
	PowLimitBits          uint32               `json:"powLimitBits"`
	CoinbaseMaturity      uint16               `json:"coinbaseMaturity"`
	CertRules             []CertRuleVector     `json:"certRules"`
	Subsidies             []HeightAmountVector `json:"subsidies"`
	Supplies              []HeightAmountVector `json:"supplies"`
	Difficulties          []DifficultyVector   `json:"difficulties"`
}

// CompactVector is CompactToBig(Bits) and CalcWork(Bits) as decimal strings,
// and BigToCompact of that target.
type CompactVector struct {
	Bits      uint32 `json:"bits"`
	Target    string `json:"target"`
	Work      string `json:"work"`
	Recompact uint32 `json:"recompact"`
}

type TargetVector struct {
	Target string `json:"target"`
	Bits   uint32 `json:"bits"`
}

type ConsensusVectors struct {
	Networks []ConsensusNetworkVector `json:"networks"`
	Compact  []CompactVector          `json:"compact"`
	Targets  []TargetVector           `json:"targets"`
}

// scriptError runs Pearl's script engine over every input and returns its
// first error, or "" when the transaction is valid.
func scriptError(tx *wire.MsgTx, prevOuts []*wire.TxOut) string {
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
		if err != nil {
			return err.Error()
		}
		if err := engine.Execute(); err != nil {
			return err.Error()
		}
	}
	return ""
}

func leafBuilderVectors(account *hdkeychain.ExtendedKey, internalPub *btcec.PublicKey) LeafBuilderVectors {
	var out LeafBuilderVectors
	const timelockKey = 40
	priv, err := derive(account, 0, timelockKey).ECPrivKey()
	check(err)
	xOnly := schnorr.SerializePubKey(priv.PubKey())
	const amount int64 = 100_000_000

	timelockLeaf := func(kind string, value int64) []byte {
		op := byte(txscript.OP_CHECKLOCKTIMEVERIFY)
		if kind == "csv" {
			op = txscript.OP_CHECKSEQUENCEVERIFY
		}
		script, err := txscript.NewScriptBuilder().AddInt64(value).AddOp(op).AddOp(txscript.OP_DROP).
			AddData(xOnly).AddOp(txscript.OP_CHECKSIG).Script()
		check(err)
		return script
	}
	secondsSequence := int64(blockchain.LockTimeToSequence(true, 20*512))
	for _, item := range []struct {
		name     string
		kind     string
		value    int64
		version  int32
		lockTime uint32
		sequence uint32
		fails    bool
	}{
		{"cltv-height", "cltv", 500, 2, 500, wire.MaxTxInSequenceNum - 1, false},
		{"cltv-height-later-locktime", "cltv", 500, 2, 600, wire.MaxTxInSequenceNum - 1, false},
		{"cltv-height-before-maturity", "cltv", 500, 2, 499, wire.MaxTxInSequenceNum - 1, true},
		{"cltv-height-final-sequence", "cltv", 500, 2, 600, wire.MaxTxInSequenceNum, true},
		{"cltv-time", "cltv", 1_700_000_000, 2, 1_700_000_000, 0, false},
		{"cltv-time-before-maturity", "cltv", 1_700_000_000, 2, 1_699_999_999, 0, true},
		{"cltv-time-against-height-locktime", "cltv", 1_700_000_000, 2, 499_999_999, 0, true},
		{"cltv-small-int", "cltv", 16, 1, 16, 0, false},
		{"cltv-five-byte-number", "cltv", 3_000_000_000, 2, 3_000_000_000, 0, false},
		{"csv-blocks", "csv", 10, 2, 0, 10, false},
		{"csv-blocks-before-maturity", "csv", 10, 2, 0, 9, true},
		{"csv-one-block", "csv", 1, 2, 0, 1, false},
		{"csv-blocks-version-1", "csv", 10, 1, 0, 10, true},
		{"csv-blocks-disabled-input-sequence", "csv", 10, 2, 0, 10 | wire.SequenceLockTimeDisabled, true},
		{"csv-seconds", "csv", secondsSequence, 2, 0, uint32(secondsSequence), false},
		{"csv-seconds-before-maturity", "csv", secondsSequence, 2, 0, uint32(secondsSequence) - 1, true},
		{"csv-seconds-against-block-sequence", "csv", secondsSequence, 2, 0, 20, true},
		{"csv-disabled-in-script", "csv", int64(wire.SequenceLockTimeDisabled), 1, 0, wire.MaxTxInSequenceNum, false},
	} {
		leafScript := timelockLeaf(item.kind, item.value)
		leaf := txscript.NewBaseTapLeaf(leafScript)
		tree := txscript.AssembleTaprootScriptTree(leaf)
		root := tree.RootNode.TapHash()
		prevScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(internalPub, root[:]))
		check(err)
		block := tree.LeafMerkleProofs[0].ToControlBlock(internalPub)
		controlBlock, err := block.ToBytes()
		check(err)

		tx := wire.NewMsgTx(item.version)
		tx.LockTime = item.lockTime
		txIn := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x1d}, 0), nil, nil)
		txIn.Sequence = item.sequence
		tx.AddTxIn(txIn)
		tx.AddTxOut(wire.NewTxOut(amount-10_000, prevScript))
		fetcher := txscript.NewCannedPrevOutputFetcher(prevScript, amount)
		sigHashes := txscript.NewTxSigHashes(tx, fetcher)
		sig, err := txscript.RawTxInTapscriptSignature(
			tx, sigHashes, 0, amount, prevScript, leaf, txscript.SigHashDefault, priv,
		)
		check(err)
		tx.TxIn[0].SetWitness(wire.TxWitness{sig, leafScript, controlBlock})
		errText := scriptError(tx, []*wire.TxOut{wire.NewTxOut(amount, prevScript)})
		if (errText != "") != item.fails {
			panic(fmt.Sprintf("timelock %s: unexpected script result %q", item.name, errText))
		}
		out.Timelocks = append(out.Timelocks, TimelockSpendVector{
			Name: item.name, Kind: item.kind, Value: item.value, KeyIndex: timelockKey,
			LeafScript: hex.EncodeToString(leafScript),
			Prevout:    PrevoutVector{Script: hex.EncodeToString(prevScript), Value: amount},
			SpendTxHex: serializeTx(tx, true), Error: errText,
		})
	}

	for _, item := range []struct {
		isSeconds bool
		lockTime  uint32
	}{
		{false, 0}, {false, 1}, {false, 144}, {false, 0xffff},
		{true, 0}, {true, 511}, {true, 512}, {true, 1000}, {true, 20 * 512}, {true, 0xffff * 512},
	} {
		out.Sequences = append(out.Sequences, SequenceVector{
			IsSeconds: item.isSeconds, LockTime: item.lockTime,
			Sequence: blockchain.LockTimeToSequence(item.isSeconds, item.lockTime),
		})
	}

	// 17-of-18 multi_a over account/0/50..67, signed by the first 17 keys.
	const multiAKeys, multiAThreshold, multiAOffset = 18, 17, 50
	builder := txscript.NewScriptBuilder()
	privs := make([]*btcec.PrivateKey, multiAKeys)
	var keyIndices, signerIndices []uint32
	for i := 0; i < multiAKeys; i++ {
		privs[i], err = derive(account, 0, uint32(multiAOffset+i)).ECPrivKey()
		check(err)
		builder.AddData(schnorr.SerializePubKey(privs[i].PubKey()))
		if i == 0 {
			builder.AddOp(txscript.OP_CHECKSIG)
		} else {
			builder.AddOp(txscript.OP_CHECKSIGADD)
		}
		keyIndices = append(keyIndices, uint32(i))
		if i < multiAThreshold {
			signerIndices = append(signerIndices, uint32(i))
		}
	}
	leafScript, err := builder.AddInt64(multiAThreshold).AddOp(txscript.OP_NUMEQUAL).Script()
	check(err)
	leaf := txscript.NewBaseTapLeaf(leafScript)
	tree := txscript.AssembleTaprootScriptTree(leaf)
	root := tree.RootNode.TapHash()
	prevScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(internalPub, root[:]))
	check(err)
	block := tree.LeafMerkleProofs[0].ToControlBlock(internalPub)
	controlBlock, err := block.ToBytes()
	check(err)
	spendTx := wire.NewMsgTx(2)
	spendTx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x1e}, 0), nil, nil))
	spendTx.AddTxOut(wire.NewTxOut(amount-10_000, prevScript))
	unsignedHex := serializeTx(spendTx, false)
	packet, err := psbt.NewFromUnsignedTx(spendTx)
	check(err)
	packet.Inputs[0].WitnessUtxo = wire.NewTxOut(amount, prevScript)
	packet.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{{
		ControlBlock: controlBlock, Script: leafScript, LeafVersion: leaf.LeafVersion,
	}}
	fetcher := txscript.NewCannedPrevOutputFetcher(prevScript, amount)
	sigHashes := txscript.NewTxSigHashes(spendTx, fetcher)
	leafHash := leaf.TapHash()
	for _, index := range signerIndices {
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
	out.MultiA = MultiASpendVector{
		Name: "17-of-18-signed-by-first-17", KeyIndices: keyIndices, SignerIndices: signerIndices,
		Threshold: multiAThreshold, LeafScript: hex.EncodeToString(leafScript),
		InternalPubKey: hex.EncodeToString(schnorr.SerializePubKey(internalPub)), UnsignedTxHex: unsignedHex,
		Prevouts:   []PrevoutVector{{Script: hex.EncodeToString(prevScript), Value: amount}},
		FinalTxHex: serializeTx(finalTx, true), WitnessLengths: lengths,
	}
	return out
}

func htlcVectors(account *hdkeychain.ExtendedKey, internalPub *btcec.PublicKey) []HTLCSpendVector {
	const claimIndex, refundIndex = 70, 71
	const amount int64 = 100_000_000
	claimPriv, err := derive(account, 0, claimIndex).ECPrivKey()
	check(err)
	refundPriv, err := derive(account, 0, refundIndex).ECPrivKey()
	check(err)
	preimage := patternBytes(32, 0x5a)
	var out []HTLCSpendVector
	type spend struct {
		name     string
		leaf     int
		signer   *btcec.PrivateKey
		preimage []byte
		lockTime uint32
		sequence uint32
		fails    bool
	}
	for _, container := range []string{"p2tr", "p2mr"} {
		for _, lock := range []string{"cltv", "csv"} {
			for _, hashType := range []string{"sha256", "hash160"} {
				if hashType == "hash160" && (lock != "cltv") {
					continue
				}
				hashOp, hash := byte(txscript.OP_SHA256), chainhash.HashB(preimage)
				if hashType == "hash160" {
					hashOp, hash = txscript.OP_HASH160, btcutil.Hash160(preimage)
				}
				claimLeaf, err := txscript.NewScriptBuilder().AddOp(txscript.OP_SIZE).AddInt64(32).AddOp(txscript.OP_EQUALVERIFY).
					AddOp(hashOp).AddData(hash).AddOp(txscript.OP_EQUALVERIFY).
					AddData(schnorr.SerializePubKey(claimPriv.PubKey())).AddOp(txscript.OP_CHECKSIG).Script()
				check(err)
				lockOp, lockValue := byte(txscript.OP_CHECKLOCKTIMEVERIFY), int64(500)
				if lock == "csv" {
					lockOp, lockValue = txscript.OP_CHECKSEQUENCEVERIFY, 10
				}
				refundLeaf, err := txscript.NewScriptBuilder().AddInt64(lockValue).AddOp(lockOp).AddOp(txscript.OP_DROP).
					AddData(schnorr.SerializePubKey(refundPriv.PubKey())).AddOp(txscript.OP_CHECKSIG).Script()
				check(err)
				leaves := []txscript.TapLeaf{txscript.NewBaseTapLeaf(claimLeaf), txscript.NewBaseTapLeaf(refundLeaf)}
				tree := txscript.AssembleTaprootScriptTree(leaves...)
				root := tree.RootNode.TapHash()
				var prevScript []byte
				var address string
				if container == "p2tr" {
					prevScript, err = txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(internalPub, root[:]))
					check(err)
					addr, err := btcutil.NewAddressTaproot(prevScript[2:], &chaincfg.MainNetParams)
					check(err)
					address = addr.EncodeAddress()
				} else {
					addr, err := btcutil.NewAddressMerkleRoot(root[:], &chaincfg.MainNetParams)
					check(err)
					prevScript, err = txscript.PayToAddrScript(addr)
					check(err)
					address = addr.EncodeAddress()
				}
				refundLock, refundSeq := uint32(0), uint32(wire.MaxTxInSequenceNum)
				earlyLock, earlySeq := uint32(0), uint32(wire.MaxTxInSequenceNum)
				if lock == "cltv" {
					refundLock, refundSeq, earlyLock, earlySeq = 500, 0xfffffffe, 499, 0xfffffffe
				} else {
					refundSeq, earlySeq = 10, 9
				}
				wrong := append([]byte(nil), preimage...)
				wrong[0] ^= 1
				spends := []spend{
					{"claim", 0, claimPriv, preimage, 0, wire.MaxTxInSequenceNum, false},
					{"refund", 1, refundPriv, nil, refundLock, refundSeq, false},
				}
				if hashType == "sha256" {
					spends = append(spends,
						spend{"claim-wrong-preimage", 0, claimPriv, wrong, 0, wire.MaxTxInSequenceNum, true},
						spend{"claim-long-preimage", 0, claimPriv, append(append([]byte(nil), preimage...), 0), 0, wire.MaxTxInSequenceNum, true},
						spend{"claim-signed-by-refund-key", 0, refundPriv, preimage, 0, wire.MaxTxInSequenceNum, true},
						spend{"refund-early", 1, refundPriv, nil, earlyLock, earlySeq, true},
						spend{"refund-signed-by-claim-key", 1, claimPriv, nil, refundLock, refundSeq, true},
					)
				}
				for _, item := range spends {
					leaf := leaves[item.leaf]
					proof := tree.LeafMerkleProofs[item.leaf]
					var controlBlock []byte
					if container == "p2tr" {
						block := proof.ToControlBlock(internalPub)
						controlBlock, err = block.ToBytes()
					} else {
						block := txscript.MerkleRootControlBlock{LeafVersion: txscript.BaseLeafVersion, InclusionProof: proof.InclusionProof}
						controlBlock, err = block.ToBytes()
					}
					check(err)
					tx := wire.NewMsgTx(2)
					tx.LockTime = item.lockTime
					txIn := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x4c}, 0), nil, nil)
					txIn.Sequence = item.sequence
					tx.AddTxIn(txIn)
					tx.AddTxOut(wire.NewTxOut(amount-10_000, prevScript))
					unsigned := serializeTx(tx, false)
					fetcher := txscript.NewCannedPrevOutputFetcher(prevScript, amount)
					sigHashes := txscript.NewTxSigHashes(tx, fetcher)
					sighash, err := txscript.CalcTapscriptSignaturehash(sigHashes, txscript.SigHashDefault, tx, 0, fetcher, leaf)
					check(err)
					sig, err := txscript.RawTxInTapscriptSignature(tx, sigHashes, 0, amount, prevScript, leaf, txscript.SigHashDefault, item.signer)
					check(err)
					stack := wire.TxWitness{sig}
					if item.leaf == 0 {
						stack = append(stack, item.preimage)
					}
					tx.TxIn[0].SetWitness(append(append(wire.TxWitness{}, stack...), leaf.Script, controlBlock))
					errText := scriptError(tx, []*wire.TxOut{wire.NewTxOut(amount, prevScript)})
					if (errText != "") != item.fails {
						panic(fmt.Sprintf("htlc %s %s %s: unexpected script result %q", container, lock, item.name, errText))
					}
					var stackHex []string
					for _, part := range stack {
						stackHex = append(stackHex, hex.EncodeToString(part))
					}
					out = append(out, HTLCSpendVector{
						Name: fmt.Sprintf("%s-%s-%s-%s", container, lock, hashType, item.name), Container: container, Lock: lock,
						LockValue: lockValue, HashType: hashType, Preimage: hex.EncodeToString(preimage), Hash: hex.EncodeToString(hash),
						ClaimKey: claimIndex, RefundKey: refundIndex,
						ClaimLeaf: hex.EncodeToString(claimLeaf), RefundLeaf: hex.EncodeToString(refundLeaf),
						InternalPubKey: hex.EncodeToString(schnorr.SerializePubKey(internalPub)), Root: hex.EncodeToString(root[:]),
						Address: address, PrevScript: hex.EncodeToString(prevScript), Value: amount, LeafIndex: item.leaf,
						ControlBlock: hex.EncodeToString(controlBlock), UnsignedTxHex: unsigned, Sighash: hex.EncodeToString(sighash),
						Stack: stackHex, SpendTxHex: serializeTx(tx, true), Error: errText,
					})
				}
			}
		}
	}
	return out
}

// mempoolChain is the chain view behind the generator's TxPools, as in
// node/mempool's fakeChain: a fixed set of confirmed outputs at height 1 and
// a tip at height 1000 with sequence locks always met.
type mempoolChain struct {
	utxos *blockchain.UtxoViewpoint
}

func (c *mempoolChain) FetchUtxoView(tx *btcutil.Tx) (*blockchain.UtxoViewpoint, error) {
	view := blockchain.NewUtxoViewpoint()
	prevOut := wire.OutPoint{Hash: *tx.Hash()}
	for i := range tx.MsgTx().TxOut {
		prevOut.Index = uint32(i)
		view.Entries()[prevOut] = c.utxos.LookupEntry(prevOut).Clone()
	}
	for _, txIn := range tx.MsgTx().TxIn {
		view.Entries()[txIn.PreviousOutPoint] = c.utxos.LookupEntry(txIn.PreviousOutPoint).Clone()
	}
	return view, nil
}

type mempoolCoin struct {
	outPoint wire.OutPoint
	value    int64
}

func mempoolVectors() []MempoolScenarioVector {
	keyBytes := mustHex("700868df1838811ffbdf918fb482c1f7ead62db4b97bd7012c23e726485e577d")
	signKey, signPub := btcec.PrivKeyFromBytes(keyBytes)
	payScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(signPub))
	check(err)

	const fundingOutputs = 300
	funding := wire.NewMsgTx(2)
	funding.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0xee}, 0), nil, nil))
	for i := 0; i < fundingOutputs; i++ {
		funding.AddTxOut(wire.NewTxOut(1_000_000_000, payScript))
	}
	chain := &mempoolChain{utxos: blockchain.NewUtxoViewpoint()}
	chain.utxos.AddTxOuts(btcutil.NewTx(funding), 1)
	nextCoin := 0
	coin := func() mempoolCoin {
		c := mempoolCoin{wire.OutPoint{Hash: funding.TxHash(), Index: uint32(nextCoin)}, 1_000_000_000}
		nextCoin++
		return c
	}

	newPool := func(rejectReplacement bool) *mempool.TxPool {
		return mempool.New(&mempool.Config{
			Policy: mempool.Policy{
				DisableRelayPriority: true, FreeTxRelayLimit: 15, MaxOrphanTxs: 5, MaxOrphanTxSize: 1000,
				MinRelayTxFee: mempool.DefaultMinRelayTxFee, MaxTxVersion: 2, RejectReplacement: rejectReplacement,
				LimitAncestorCount:   mempool.DefaultAncestorCountLimit,
				LimitAncestorSize:    mempool.DefaultAncestorSizeLimit,
				LimitDescendantCount: mempool.DefaultDescendantCountLimit,
			},
			ChainParams:    &chaincfg.MainNetParams,
			FetchUtxoView:  chain.FetchUtxoView,
			BestHeight:     func() int32 { return 1000 },
			MedianTimePast: func() time.Time { return time.Unix(1_700_000_000, 0) },
			CalcSequenceLock: func(*btcutil.Tx, *blockchain.UtxoViewpoint) (*blockchain.SequenceLock, error) {
				return &blockchain.SequenceLock{Seconds: -1, BlockHeight: -1}, nil
			},
			HashCache: txscript.NewHashCache(1000),
		})
	}

	// spend pays the inputs less fee into outputs equal outputs, the last
	// taking the remainder.
	spend := func(inputs []mempoolCoin, outputs int, fee int64, sequence uint32) (*btcutil.Tx, []mempoolCoin) {
		tx := wire.NewMsgTx(2)
		fetcher := txscript.NewMultiPrevOutFetcher(nil)
		var total int64
		for _, input := range inputs {
			txIn := wire.NewTxIn(&input.outPoint, nil, nil)
			txIn.Sequence = sequence
			tx.AddTxIn(txIn)
			fetcher.AddPrevOut(input.outPoint, wire.NewTxOut(input.value, payScript))
			total += input.value
		}
		each := (total - fee) / int64(outputs)
		for i := 0; i < outputs; i++ {
			value := each
			if i == outputs-1 {
				value = total - fee - each*int64(outputs-1)
			}
			tx.AddTxOut(wire.NewTxOut(value, payScript))
		}
		sigHashes := txscript.NewTxSigHashes(tx, fetcher)
		for i, input := range inputs {
			witness, err := txscript.TaprootWitnessSignature(
				tx, sigHashes, i, input.value, payScript, txscript.SigHashDefault, signKey,
			)
			check(err)
			tx.TxIn[i].SetWitness(witness)
		}
		var coins []mempoolCoin
		for i, txOut := range tx.TxOut {
			coins = append(coins, mempoolCoin{wire.OutPoint{Hash: tx.TxHash(), Index: uint32(i)}, txOut.Value})
		}
		return btcutil.NewTx(tx), coins
	}
	vsizeOf := func(inputs, outputs int) int64 {
		tx, _ := spend(make([]mempoolCoin, inputs), outputs, 0, 0)
		return blockchain.GetTransactionVsize(tx)
	}
	const rbf, final = mempool.MaxRBFSequence, wire.MaxTxInSequenceNum

	var scenarios []MempoolScenarioVector
	scenario := func(name string, rejectReplacement bool, build func(offer func(string, *btcutil.Tx, int64, bool))) {
		pool := newPool(rejectReplacement)
		s := MempoolScenarioVector{Name: name, RejectReplacement: rejectReplacement}
		offer := func(txName string, tx *btcutil.Tx, fee int64, accept bool) {
			_, err := pool.ProcessTransaction(tx, false, false, 0)
			errText := ""
			if err != nil {
				errText = err.Error()
			}
			if (errText == "") != accept {
				panic(fmt.Sprintf("mempool %s/%s: unexpected result %q", name, txName, errText))
			}
			s.Transactions = append(s.Transactions, MempoolTxVector{
				Name: txName, TxHex: serializeTx(tx.MsgTx(), true), Fee: fee,
				Vsize: blockchain.GetTransactionVsize(tx), Error: errText,
			})
		}
		build(offer)
		scenarios = append(scenarios, s)
	}

	scenario("explicit-signal", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		c := coin()
		first, _ := spend([]mempoolCoin{c}, 1, 1000, rbf)
		offer("original", first, 1000, true)
		second, _ := spend([]mempoolCoin{c}, 1, 2000, final)
		offer("replacement", second, 2000, true)
		third, _ := spend([]mempoolCoin{c}, 1, 5000, final)
		offer("replacing-a-non-signalling-transaction", third, 5000, false)
	})
	scenario("inherited-signal", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		parent, coins := spend([]mempoolCoin{coin()}, 1, 1000, rbf)
		offer("signalling-parent", parent, 1000, true)
		child, _ := spend(coins, 1, 1000, final)
		offer("non-signalling-child", child, 1000, true)
		replacement, _ := spend(coins, 1, 3000, final)
		offer("child-replacement", replacement, 3000, true)
	})
	scenario("fee-rate-not-higher", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		c := coin()
		first, _ := spend([]mempoolCoin{c}, 1, 1000, rbf)
		offer("original", first, 1000, true)
		second, _ := spend([]mempoolCoin{c}, 2, 1100, rbf)
		offer("larger-replacement-at-a-lower-rate", second, 1100, false)
	})
	scenario("fee-rate-equal", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		c := coin()
		first, _ := spend([]mempoolCoin{c}, 1, 1000, rbf)
		offer("original", first, 1000, true)
		// Same size and fee, so the same rate; only the sequence differs.
		second, _ := spend([]mempoolCoin{c}, 1, 1000, final)
		offer("replacement-at-the-same-rate", second, 1000, false)
	})
	scenario("absolute-fee", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		c := coin()
		first, _ := spend([]mempoolCoin{c}, 2, 2000, rbf)
		offer("original", first, 2000, true)
		needed := 2000 + vsizeOf(1, 1)
		short, _ := spend([]mempoolCoin{c}, 1, needed-1, rbf)
		offer("one-grain-short", short, needed-1, false)
		exact, _ := spend([]mempoolCoin{c}, 1, needed, rbf)
		offer("exact-minimum", exact, needed, true)
	})
	scenario("spends-conflict-output", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		c := coin()
		first, coins := spend([]mempoolCoin{c}, 2, 1000, rbf)
		offer("original", first, 1000, true)
		bad, _ := spend([]mempoolCoin{c, coins[1]}, 1, 10_000, final)
		offer("replacement-spending-the-original", bad, 10_000, false)
	})
	scenario("new-unconfirmed-input", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		other, otherCoins := spend([]mempoolCoin{coin()}, 1, 1000, final)
		offer("unrelated", other, 1000, true)
		c := coin()
		first, _ := spend([]mempoolCoin{c}, 1, 1000, rbf)
		offer("original", first, 1000, true)
		bad, _ := spend([]mempoolCoin{c, otherCoins[0]}, 1, 10_000, final)
		offer("replacement-adding-an-unconfirmed-input", bad, 10_000, false)
	})
	scenario("reject-replacement", true, func(offer func(string, *btcutil.Tx, int64, bool)) {
		c := coin()
		first, _ := spend([]mempoolCoin{c}, 1, 1000, rbf)
		offer("original", first, 1000, true)
		second, _ := spend([]mempoolCoin{c}, 1, 5000, rbf)
		offer("replacement", second, 5000, false)
	})
	evictions := func(count int, accept bool) func(offer func(string, *btcutil.Tx, int64, bool)) {
		return func(offer func(string, *btcutil.Tx, int64, bool)) {
			var coins []mempoolCoin
			for i := 0; i < count; i++ {
				c := coin()
				coins = append(coins, c)
				tx, _ := spend([]mempoolCoin{c}, 1, 1000, rbf)
				offer(fmt.Sprintf("original-%d", i), tx, 1000, true)
			}
			fee := int64(count)*1000 + 2*vsizeOf(count, 1)
			replacement, _ := spend(coins, 1, fee, final)
			offer("replacement", replacement, fee, accept)
		}
	}
	scenario("evicts-100", false, evictions(100, true))
	scenario("evicts-101", false, evictions(101, false))
	scenario("evicts-101-with-descendants", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		var roots []mempoolCoin
		for i := 0; i < 5; i++ {
			c := coin()
			roots = append(roots, c)
			tx, coins := spend([]mempoolCoin{c}, 1, 1000, rbf)
			offer(fmt.Sprintf("root-%d", i), tx, 1000, true)
			for j := 0; j < 20; j++ {
				tx, coins = spend(coins, 1, 1000, final)
				offer(fmt.Sprintf("root-%d-descendant-%d", i, j), tx, 1000, true)
			}
		}
		fee := int64(200_000)
		replacement, _ := spend(roots, 1, fee, final)
		offer("replacement", replacement, fee, false)
	})
	scenario("ancestor-count", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		coins := []mempoolCoin{coin()}
		for i := 0; i < 26; i++ {
			var tx *btcutil.Tx
			tx, coins = spend(coins, 1, 1000, final)
			offer(fmt.Sprintf("chain-%d", i), tx, 1000, i < 25)
		}
	})
	scenario("ancestor-size", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		parent, coins := spend([]mempoolCoin{coin()}, 2000, 100_000, final)
		offer("fat-parent", parent, 100_000, true)
		child, _ := spend(coins[:1], 400, 20_000, final)
		offer("fat-child", child, 20_000, false)
	})
	scenario("descendant-count", false, func(offer func(string, *btcutil.Tx, int64, bool)) {
		parent, coins := spend([]mempoolCoin{coin()}, 25, 2000, final)
		offer("parent", parent, 2000, true)
		for i := 0; i < 25; i++ {
			child, _ := spend(coins[i:i+1], 1, 1000, final)
			offer(fmt.Sprintf("child-%d", i), child, 1000, i < 24)
		}
	})
	return scenarios
}

// difficultyRatio mirrors getDifficultyRatio in node/rpcserver.go, which is
// in package main.
func difficultyRatio(bits uint32, params *chaincfg.Params) float64 {
	max := blockchain.CompactToBig(params.PowLimitBits)
	target := blockchain.CompactToBig(bits)
	diff, err := strconv.ParseFloat(new(big.Rat).SetFrac(max, target).FloatString(8), 64)
	check(err)
	return diff
}

func consensusVectors(nets []*chaincfg.Params) ConsensusVectors {
	var out ConsensusVectors
	for _, net := range nets {
		v := ConsensusNetworkVector{
			Name: net.Name, MoEForkHeight: net.MoEForkHeight, DenseOnlyForkHeight: net.DenseOnlyForkHeight,
			RankPenaltyForkHeight: net.RankPenaltyForkHeight, SaltedSeedForkHeight: net.SaltedSeedForkHeight,
			Checkpoints: []CheckpointVector{}, DNSSeeds: []string{},
			TargetTimePerBlock: int64(net.TargetTimePerBlock / time.Second),
			WTEMAHalfLife:      int64(net.WTEMAHalfLife / time.Second),
			PowLimit:           net.PowLimit.String(), PowLimitBits: net.PowLimitBits,
			CoinbaseMaturity: net.CoinbaseMaturity,
		}
		for _, cp := range net.Checkpoints {
			v.Checkpoints = append(v.Checkpoints, CheckpointVector{cp.Height, cp.Hash.String()})
		}
		for _, seed := range net.DNSSeeds {
			v.DNSSeeds = append(v.DNSSeeds, seed.Host)
		}

		heights := map[int32]bool{0: true, 1: true, 2: true, 1000: true}
		for _, fork := range []int32{net.MoEForkHeight, net.DenseOnlyForkHeight, net.RankPenaltyForkHeight, net.SaltedSeedForkHeight} {
			if fork > 0 {
				heights[fork-1], heights[fork], heights[fork+1] = true, true, true
			}
		}
		var sorted []int32
		for h := range heights {
			sorted = append(sorted, h)
		}
		sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
		header := &wire.BlockHeader{}
		for _, height := range sorted {
			for _, cert := range []struct {
				version uint32
				size    int
			}{{1, wire.PublicDataSizeV1}, {2, wire.PublicDataSizeDenseV2}, {2, wire.PublicDataSizeDenseV2 + 1},
				{3, wire.PublicDataSizeDenseV2}, {3, wire.PublicDataSizeDenseV2 + 1}} {
				var c wire.BlockCertificate
				switch cert.version {
				case 1:
					c = &wire.CertificateV1{}
				case 2:
					c = &wire.CertificateV2{PublicDataLen: uint32(cert.size)}
				default:
					c = &wire.CertificateV3{CertificateV2: wire.CertificateV2{PublicDataLen: uint32(cert.size)}}
				}
				errText := ""
				if err := blockchain.CheckCertificateRules(header, c, height, net, blockchain.BFNoPoWCheck); err != nil {
					errText = err.Error()
				}
				v.CertRules = append(v.CertRules, CertRuleVector{
					Height: height, Version: cert.version, PublicDataLen: cert.size,
					Required: uint32(net.RequiredCertVersion(height)), Error: errText,
				})
			}
		}

		emission := int32((4 * 365 * 24 * 60 * 60) / int64(net.TargetTimePerBlock/time.Second))
		subsidyHeights := []int32{0, 1, 2, 3, 100, 1000, 10_000, 99_000, emission - 1, emission, emission + 1,
			1_000_000, 10_000_000, 1 << 30, 1<<31 - 1}
		for _, h := range subsidyHeights {
			v.Subsidies = append(v.Subsidies, HeightAmountVector{h, blockchain.CalcBlockSubsidy(h, net)})
		}
		supplyHeights := map[int32]bool{0: true, 1: true, 2: true, 100: true, 99_999: true, 130_000: true, emission: true}
		var supply int64
		for h := int32(0); h <= emission; h++ {
			supply += blockchain.CalcBlockSubsidy(h, net)
			if supplyHeights[h] {
				v.Supplies = append(v.Supplies, HeightAmountVector{h, supply})
			}
		}

		for _, bits := range []uint32{net.PowLimitBits, net.GenesisBlock.MsgHeader.BlockHeader.Bits, 0x1b00ffff, 0x1a7fffff,
			0x1a0a1b2c, 0x19012345, 0x1d00ffff, 0x0f123456} {
			v.Difficulties = append(v.Difficulties, DifficultyVector{bits, difficultyRatio(bits, net)})
		}
		out.Networks = append(out.Networks, v)
	}

	for _, bits := range []uint32{0, 0x00123456, 0x01003456, 0x01123456, 0x02008000, 0x02123456, 0x03123456,
		0x04123456, 0x04923456, 0x05009234, 0x20123456, 0x1d00ffff, 0x1b00ffff, 0x1e010000, 0x1a0a1b2c,
		0x01800000, 0xff7fffff} {
		target := blockchain.CompactToBig(bits)
		out.Compact = append(out.Compact, CompactVector{
			Bits: bits, Target: target.String(), Work: blockchain.CalcWork(bits).String(),
			Recompact: blockchain.BigToCompact(target),
		})
	}
	one := big.NewInt(1)
	for _, target := range []*big.Int{
		big.NewInt(0), big.NewInt(1), big.NewInt(0x7f), big.NewInt(0x80), big.NewInt(0xffff),
		big.NewInt(0x800000), big.NewInt(0x12345678), big.NewInt(-1), big.NewInt(-0x12345600),
		new(big.Int).Sub(new(big.Int).Lsh(one, 208), one), new(big.Int).Sub(new(big.Int).Lsh(one, 233), one),
		new(big.Int).Lsh(one, 255), new(big.Int).Sub(new(big.Int).Lsh(one, 256), one),
	} {
		out.Targets = append(out.Targets, TargetVector{target.String(), blockchain.BigToCompact(target)})
	}
	return out
}

// accumulatingInputSource is makeInputSource from wallet/wallet/createtx.go,
// which is unexported: it adds coins in order until the target is covered
// and keeps them across calls.
func accumulatingInputSource(eligible []wallet.Coin) txauthor.InputSource {
	currentTotal := btcutil.Amount(0)
	currentInputs := make([]*wire.TxIn, 0, len(eligible))
	currentScripts := make([][]byte, 0, len(eligible))
	currentInputValues := make([]btcutil.Amount, 0, len(eligible))

	return func(target btcutil.Amount) (btcutil.Amount, []*wire.TxIn,
		[]btcutil.Amount, [][]byte, error) {

		for currentTotal < target && len(eligible) != 0 {
			nextCredit := eligible[0]
			prevOut := nextCredit.TxOut
			outpoint := nextCredit.OutPoint
			eligible = eligible[1:]

			nextInput := wire.NewTxIn(&outpoint, nil, nil)
			currentTotal += btcutil.Amount(prevOut.Value)
			currentInputs = append(currentInputs, nextInput)
			currentScripts = append(currentScripts, prevOut.PkScript)
			currentInputValues = append(currentInputValues, btcutil.Amount(prevOut.Value))
		}

		return currentTotal, currentInputs, currentInputValues, currentScripts, nil
	}
}

// constantInputSource is the one in createtx.go, also unexported, over Coins:
// every selected output is spent whatever the target.
func constantInputSource(eligible []wallet.Coin) txauthor.InputSource {
	currentTotal := btcutil.Amount(0)
	currentInputs := make([]*wire.TxIn, 0, len(eligible))
	currentScripts := make([][]byte, 0, len(eligible))
	currentInputValues := make([]btcutil.Amount, 0, len(eligible))
	for _, coin := range eligible {
		outpoint := coin.OutPoint
		currentTotal += btcutil.Amount(coin.Value)
		currentInputs = append(currentInputs, wire.NewTxIn(&outpoint, nil, nil))
		currentScripts = append(currentScripts, coin.PkScript)
		currentInputValues = append(currentInputValues, btcutil.Amount(coin.Value))
	}
	return func(btcutil.Amount) (btcutil.Amount, []*wire.TxIn, []btcutil.Amount, [][]byte, error) {
		return currentTotal, currentInputs, currentInputValues, currentScripts, nil
	}
}

func coinSelectionVectors() CoinSelectionVectors {
	p2tr := func(b byte) []byte { return append([]byte{txscript.OP_1, 32}, bytes.Repeat([]byte{b}, 32)...) }
	p2mr := func(b byte) []byte { return append([]byte{txscript.OP_2, 32}, bytes.Repeat([]byte{b}, 32)...) }
	nullData, err := txscript.NullDataScript([]byte("pearljs"))
	check(err)
	changeScript := p2tr(0xcc)
	pay := func(script []byte, value int64) *wire.TxOut { return wire.NewTxOut(value, script) }

	out := CoinSelectionVectors{
		CoinbaseMaturity: chaincfg.MainNetParams.CoinbaseMaturity,
		MinInputVsize:    txsizes.GetMinInputVirtualSize(p2tr(0x01)),
	}
	for _, net := range []*chaincfg.Params{
		&chaincfg.TestNetParams, &chaincfg.TestNet2Params, &chaincfg.RegressionNetParams, &chaincfg.SimNetParams,
	} {
		if net.CoinbaseMaturity != out.CoinbaseMaturity {
			panic("coinbase maturity differs between networks")
		}
	}

	for _, outputs := range [][]*wire.TxOut{
		{pay(p2tr(0xa1), 1)},
		{pay(p2tr(0xa1), 1), pay(p2mr(0xa2), 1), pay(nullData, 0)},
	} {
		for _, inputs := range []int{0, 1, 2, 3, 4, 5, 6, 7, 252, 253, 254} {
			scripts := make([]string, len(outputs))
			for i, output := range outputs {
				scripts[i] = hex.EncodeToString(output.PkScript)
			}
			out.SizeEstimates = append(out.SizeEstimates, SizeEstimateVector{
				Inputs: inputs, Outputs: scripts,
				Vsize: txsizes.EstimateVirtualSize(0, inputs, 0, 0, outputs, txsizes.P2TRPkScriptSize),
			})
		}
	}

	type selectionCase struct {
		name       string
		strategy   string
		feeRate    int64
		coins      []int64
		coinScript func(i int) []byte
		outputs    []*wire.TxOut
		scriptSize int
	}
	keyPathCoin := func(i int) []byte { return p2tr(byte(i + 1)) }
	cases := []selectionCase{
		{name: "one input with change", strategy: "largest", feeRate: 1000,
			coins: []int64{50_000, 2_000_000, 300_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 1_500_000)}},
		{name: "three inputs", strategy: "largest", feeRate: 1000,
			coins: []int64{400_000, 100_000, 700_000, 250_000, 600_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 1_500_000)}},
		{name: "two inputs after the fee needs another coin", strategy: "largest", feeRate: 1000,
			coins: []int64{5_000, 10_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 9_900)}},
		{name: "six inputs", strategy: "largest", feeRate: 1000,
			coins: []int64{10_100, 10_200, 10_300, 10_400, 10_500, 10_600, 10_700}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 61_000)}},
		{name: "change of zero", strategy: "largest", feeRate: 1000,
			coins: []int64{10_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 9_845)}},
		{name: "change one grain under the dust limit", strategy: "largest", feeRate: 1000,
			coins: []int64{10_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 9_845-332)}},
		{name: "change at the dust limit", strategy: "largest", feeRate: 1000,
			coins: []int64{10_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 9_845-333)}},
		{name: "dust limit does not follow the fee rate", strategy: "largest", feeRate: 50_000,
			coins: []int64{100_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 100_000-7_750-400)}},
		{name: "fee rate that does not divide evenly", strategy: "largest", feeRate: 1234,
			coins: []int64{900_000, 800_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 1_000_000)}},
		{name: "fee rate under one grain per transaction", strategy: "largest", feeRate: 3,
			coins: []int64{900_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 100_000)}},
		{name: "several outputs with P2MR and OP_RETURN", strategy: "largest", feeRate: 2500,
			coins:   []int64{900_000, 800_000, 700_000},
			outputs: []*wire.TxOut{pay(p2tr(0xa1), 500_000), pay(p2mr(0xa2), 600_000), pay(nullData, 0)}},
		{name: "not enough coins", strategy: "largest", feeRate: 1000,
			coins: []int64{1_000, 2_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 5_000)}},
		{name: "enough for the output but not the fee", strategy: "largest", feeRate: 1000,
			coins: []int64{10_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 9_950)}},
		{name: "random skips coins that cost more than they add", strategy: "random", feeRate: 100_000,
			coins: []int64{5_800, 5_801, 3_000, 50_000, 80_000, 120_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 100_000)}},
		{name: "every selected coin is spent", strategy: "all", feeRate: 1000,
			coins: []int64{50_000, 60_000, 70_000}, outputs: []*wire.TxOut{pay(p2tr(0xa1), 20_000)}},
		{name: "sweep to one output", strategy: "all", feeRate: 1000,
			coins: []int64{50_000, 60_000, 70_000}},
		{name: "sweep as sweepaccount sizes it", strategy: "all", feeRate: 1000,
			coins: []int64{50_000, 60_000, 70_000}, scriptSize: txsizes.P2TROutputSize},
		{name: "P2MR coins priced as key paths", strategy: "largest", feeRate: 1000,
			coins: []int64{200_000, 300_000}, coinScript: func(i int) []byte { return p2mr(byte(i + 1)) },
			outputs: []*wire.TxOut{pay(p2tr(0xa1), 400_000)}},
	}

	for _, item := range cases {
		if item.coinScript == nil {
			item.coinScript = keyPathCoin
		}
		if item.scriptSize == 0 {
			item.scriptSize = txsizes.P2TRPkScriptSize
		}
		vector := CoinSelectionVector{
			Name: item.name, Strategy: item.strategy, FeeRate: item.feeRate,
			ChangeScript: hex.EncodeToString(changeScript), ChangeScriptSize: item.scriptSize,
			Outputs: []PrevoutVector{}, Arranged: []string{}, Inputs: []string{}, ChangeIndex: -1,
		}
		for _, output := range item.outputs {
			check(txrules.CheckOutput(output, txrules.DefaultRelayFeePerKb))
			vector.Outputs = append(vector.Outputs, PrevoutVector{
				Script: hex.EncodeToString(output.PkScript), Value: output.Value,
			})
		}
		coins := make([]wallet.Coin, len(item.coins))
		for i, value := range item.coins {
			hash := chainhash.HashH([]byte(fmt.Sprintf("pearljs coin %s %d", item.name, i)))
			coins[i] = wallet.Coin{
				TxOut:    wire.TxOut{Value: value, PkScript: item.coinScript(i)},
				OutPoint: wire.OutPoint{Hash: hash, Index: uint32(i)},
			}
			vector.Coins = append(vector.Coins, CoinVector{
				TxID: hash.String(), Vout: uint32(i), Value: value, Script: hex.EncodeToString(coins[i].PkScript),
			})
		}

		var source txauthor.InputSource
		arranged := coins
		switch item.strategy {
		case "largest":
			arranged, err = wallet.CoinSelectionLargest.ArrangeCoins(coins, btcutil.Amount(item.feeRate))
			check(err)
			source = accumulatingInputSource(arranged)
		case "random":
			arranged, err = wallet.CoinSelectionRandom.ArrangeCoins(coins, btcutil.Amount(item.feeRate))
			check(err)
			sort.Slice(arranged, func(i, j int) bool {
				return arranged[i].OutPoint.String() < arranged[j].OutPoint.String()
			})
			source = accumulatingInputSource(arranged)
		case "all":
			source = constantInputSource(coins)
		}
		for _, coin := range arranged {
			vector.Arranged = append(vector.Arranged, coin.OutPoint.String())
		}

		authored, err := txauthor.NewUnsignedTransaction(
			item.outputs, btcutil.Amount(item.feeRate), source,
			&txauthor.ChangeSource{
				NewScript:  func() ([]byte, error) { return changeScript, nil },
				ScriptSize: item.scriptSize,
			},
		)
		if err != nil {
			vector.Error = err.Error()
			out.Cases = append(out.Cases, vector)
			continue
		}
		spent := int64(0)
		for _, output := range authored.Tx.TxOut {
			spent += output.Value
		}
		for _, input := range authored.Tx.TxIn {
			vector.Inputs = append(vector.Inputs, input.PreviousOutPoint.String())
		}
		vector.TotalInput = int64(authored.TotalInput)
		vector.Fee = int64(authored.TotalInput) - spent
		vector.ChangeIndex = authored.ChangeIndex
		if authored.ChangeIndex >= 0 {
			vector.Change = authored.Tx.TxOut[authored.ChangeIndex].Value
		}
		vector.UnsignedTxHex = serializeTx(authored.Tx, false)
		out.Cases = append(out.Cases, vector)
	}
	return out
}

// tapscriptExtraVectors spends P2TR and P2MR leaves with an annex in the
// witness and with OP_CODESEPARATOR in the leaf. Each sighash comes from
// CalcTapscriptSignaturehash with WithAnnex and the code separator position
// the engine will have at that OP_CHECKSIG; the engine then runs the spend.
func tapscriptExtraVectors(account *hdkeychain.ExtendedKey, internalPub *btcec.PublicKey, payScript []byte) []TapscriptExtraVector {
	const blank = uint32(0xffffffff)
	keys := make([]*btcec.PrivateKey, 2)
	pubs := make([][]byte, 2)
	for i := range keys {
		priv, err := derive(account, 0, uint32(30+i)).ECPrivKey()
		check(err)
		keys[i] = priv
		pubs[i] = schnorr.SerializePubKey(priv.PubKey())
	}
	build := func(b *txscript.ScriptBuilder) []byte {
		out, err := b.Script()
		check(err)
		return out
	}
	single := build(txscript.NewScriptBuilder().AddData(pubs[0]).AddOp(txscript.OP_CHECKSIG))
	leading := build(txscript.NewScriptBuilder().AddOp(txscript.OP_CODESEPARATOR).AddData(pubs[0]).AddOp(txscript.OP_CHECKSIG))
	// The first check runs before the separator and the second after it.
	between := build(txscript.NewScriptBuilder().
		AddData(pubs[0]).AddOp(txscript.OP_CHECKSIGVERIFY).
		AddOp(txscript.OP_CODESEPARATOR).
		AddData(pubs[1]).AddOp(txscript.OP_CHECKSIG))
	// Only the last separator executed counts.
	twice := build(txscript.NewScriptBuilder().
		AddOp(txscript.OP_CODESEPARATOR).AddData([]byte{0x01, 0x02, 0x03}).AddOp(txscript.OP_DROP).
		AddOp(txscript.OP_CODESEPARATOR).AddData(pubs[1]).AddOp(txscript.OP_CHECKSIG))

	type sig struct {
		key int
		pos uint32
	}
	var out []TapscriptExtraVector
	for _, item := range []struct {
		name     string
		kind     string
		leaf     []byte
		hashType txscript.SigHashType
		annex    []byte
		// In witness order: the last one is checked first.
		sigs []sig
		// withP2TR adds a key-path input, which makes Pearl's signature
		// message cover input amounts.
		withP2TR bool
	}{
		{"p2tr-annex", "p2tr", single, txscript.SigHashDefault, []byte{0x50}, []sig{{0, blank}}, false},
		{"p2mr-annex", "p2mr", single, txscript.SigHashDefault, []byte{0x50, 0xde, 0xad, 0xbe, 0xef}, []sig{{0, blank}}, false},
		{"p2mr-annex-single-anyonecanpay", "p2mr", single, txscript.SigHashSingle | txscript.SigHashAnyOneCanPay, bytes.Repeat([]byte{0x50}, 300), []sig{{0, blank}}, false},
		{"p2mr-annex-with-p2tr-input", "p2mr", single, txscript.SigHashAll, []byte{0x50, 0x01}, []sig{{0, blank}}, true},
		{"p2tr-codesep-leading", "p2tr", leading, txscript.SigHashDefault, nil, []sig{{0, 0}}, false},
		{"p2mr-codesep-leading", "p2mr", leading, txscript.SigHashDefault, nil, []sig{{0, 0}}, false},
		{"p2mr-codesep-between-checks", "p2mr", between, txscript.SigHashDefault, nil, []sig{{1, 2}, {0, blank}}, false},
		{"p2tr-codesep-between-checks-all", "p2tr", between, txscript.SigHashAll, nil, []sig{{1, 2}, {0, blank}}, false},
		{"p2mr-codesep-twice", "p2mr", twice, txscript.SigHashNone, nil, []sig{{1, 3}}, false},
		{"p2mr-codesep-between-checks-annex", "p2mr", between, txscript.SigHashDefault, []byte{0x50, 0x00, 0xff}, []sig{{1, 2}, {0, blank}}, false},
		{"p2tr-codesep-leading-annex-none-anyonecanpay", "p2tr", leading, txscript.SigHashNone | txscript.SigHashAnyOneCanPay, []byte{0x50, 0x07}, []sig{{0, 0}}, false},
	} {
		leaf := txscript.NewBaseTapLeaf(item.leaf)
		tree := txscript.AssembleTaprootScriptTree(leaf)
		root := tree.RootNode.TapHash()
		proof := tree.LeafMerkleProofs[0]
		var prevScript, controlBlock []byte
		var err error
		if item.kind == "p2tr" {
			prevScript, err = txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(internalPub, root[:]))
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

		const amount int64 = 90000000
		tx := wire.NewMsgTx(2)
		var prevOuts []*wire.TxOut
		var keyPathPriv *btcec.PrivateKey
		if item.withP2TR {
			keyPathPriv, err = derive(account, 1, 2).ECPrivKey()
			check(err)
			keyPathScript, err := txscript.PayToTaprootScript(txscript.ComputeTaprootKeyNoScript(keyPathPriv.PubKey()))
			check(err)
			tx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0a}, 0), nil, nil))
			prevOuts = append(prevOuts, wire.NewTxOut(40000000, keyPathScript))
		}
		inputIndex := len(tx.TxIn)
		tx.AddTxIn(wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0b}, 3), nil, nil))
		prevOuts = append(prevOuts, wire.NewTxOut(amount, prevScript))
		for len(tx.TxOut) <= inputIndex {
			tx.AddTxOut(wire.NewTxOut(amount/2-3000, payScript))
		}

		fetcher := txscript.NewMultiPrevOutFetcher(nil)
		var prevoutVectors []PrevoutVector
		for i, txIn := range tx.TxIn {
			fetcher.AddPrevOut(txIn.PreviousOutPoint, prevOuts[i])
			prevoutVectors = append(prevoutVectors, PrevoutVector{Script: hex.EncodeToString(prevOuts[i].PkScript), Value: prevOuts[i].Value})
		}
		sigHashes := txscript.NewTxSigHashes(tx, fetcher)
		leafHash := leaf.TapHash()

		vector := TapscriptExtraVector{
			Name: item.name, Kind: item.kind, HashType: uint32(item.hashType), Prevouts: prevoutVectors,
			LeafScript: hex.EncodeToString(item.leaf), ControlBlock: hex.EncodeToString(controlBlock),
			Annex: hex.EncodeToString(item.annex), CodeSepPositions: []int32{},
			UnsignedTxHex: serializeTx(tx, false),
		}
		tokenizer := txscript.MakeScriptTokenizer(0, item.leaf)
		for tokenizer.Next() {
			if tokenizer.Opcode() == txscript.OP_CODESEPARATOR {
				vector.CodeSepPositions = append(vector.CodeSepPositions, tokenizer.OpcodePosition())
			}
		}
		check(tokenizer.Err())

		var witness wire.TxWitness
		for _, s := range item.sigs {
			opts := []txscript.TaprootSigHashOption{txscript.WithBaseTapscriptVersion(s.pos, leafHash[:])}
			if item.annex != nil {
				opts = append(opts, txscript.WithAnnex(item.annex))
			}
			sighash, err := txscript.CalcTapscriptSignaturehash(sigHashes, item.hashType, tx, inputIndex, fetcher, leaf, opts...)
			check(err)
			signed, err := schnorr.Sign(keys[s.key], sighash)
			check(err)
			signature := signed.Serialize()
			if item.hashType != txscript.SigHashDefault {
				signature = append(signature, byte(item.hashType))
			}
			witness = append(witness, signature)
			vector.Signatures = append(vector.Signatures, TapscriptSignatureVector{
				KeyIndex: 30 + s.key, CodeSepPos: s.pos,
				Sighash: hex.EncodeToString(sighash), Signature: hex.EncodeToString(signature),
			})
		}
		witness = append(witness, item.leaf, controlBlock)
		if item.annex != nil {
			witness = append(witness, item.annex)
		}
		tx.TxIn[inputIndex].SetWitness(witness)
		if keyPathPriv != nil {
			keySig, err := txscript.RawTxInTaprootSignature(
				tx, txscript.NewTxSigHashes(tx, fetcher), 0, prevOuts[0].Value,
				prevOuts[0].PkScript, nil, txscript.SigHashDefault, keyPathPriv,
			)
			check(err)
			tx.TxIn[0].SetWitness(wire.TxWitness{keySig})
		}
		verifyInputs(tx, prevOuts)
		vector.FinalTxHex = serializeTx(tx, true)
		vector.TxID = tx.TxID()
		out = append(out, vector)
	}
	return out
}

// customLeafVectors spends leaves whose witness holds more than signatures: a
// hash lock with a signature, a timelock with a preimage and an OP_CAT
// leaf, each under P2TR and P2MR. The P2TR outputs use the BIP341 NUMS point
// as their internal key, so only the script path can spend them.
func customLeafVectors(account *hdkeychain.ExtendedKey, payScript []byte) []CustomLeafVector {
	const keyIndex = 40
	priv, err := derive(account, 0, keyIndex).ECPrivKey()
	check(err)
	pub := schnorr.SerializePubKey(priv.PubKey())
	nums, err := schnorr.ParsePubKey(mustHex("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"))
	check(err)
	build := func(b *txscript.ScriptBuilder) []byte {
		out, err := b.Script()
		check(err)
		return out
	}
	secret := []byte("pearl swap secret")
	secretHash := chainhash.HashB(secret)
	blob := []byte("pearl-covenant")
	blobHash := chainhash.HashB(blob)
	const lockHeight = 700000
	hashLock := build(txscript.NewScriptBuilder().
		AddOp(txscript.OP_SHA256).AddData(secretHash).AddOp(txscript.OP_EQUALVERIFY).
		AddData(pub).AddOp(txscript.OP_CHECKSIG))
	timelock := build(txscript.NewScriptBuilder().
		AddInt64(lockHeight).AddOp(txscript.OP_CHECKLOCKTIMEVERIFY).AddOp(txscript.OP_DROP).
		AddOp(txscript.OP_SHA256).AddData(secretHash).AddOp(txscript.OP_EQUAL))
	cat := build(txscript.NewScriptBuilder().
		AddOp(txscript.OP_CAT).AddOp(txscript.OP_SHA256).AddData(blobHash).AddOp(txscript.OP_EQUAL))

	var out []CustomLeafVector
	for _, item := range []struct {
		name string
		leaf []byte
		// A nil item stands for the signature.
		stack    [][]byte
		lockTime uint32
	}{
		{"hashlock-checksig", hashLock, [][]byte{nil, secret}, 0},
		{"timelock-preimage", timelock, [][]byte{secret}, lockHeight},
		{"cat", cat, [][]byte{blob[:5], blob[5:]}, 0},
	} {
		for _, kind := range []string{"p2tr", "p2mr"} {
			leaf := txscript.NewBaseTapLeaf(item.leaf)
			tree := txscript.AssembleTaprootScriptTree(leaf)
			root := tree.RootNode.TapHash()
			proof := tree.LeafMerkleProofs[0]
			var prevScript, controlBlock []byte
			if kind == "p2tr" {
				prevScript, err = txscript.PayToTaprootScript(txscript.ComputeTaprootOutputKey(nums, root[:]))
				check(err)
				block := proof.ToControlBlock(nums)
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

			const amount int64 = 100000000
			tx := wire.NewMsgTx(2)
			tx.LockTime = item.lockTime
			txIn := wire.NewTxIn(wire.NewOutPoint(&chainhash.Hash{0x0c}, 1), nil, nil)
			txIn.Sequence = 0xfffffffd
			tx.AddTxIn(txIn)
			tx.AddTxOut(wire.NewTxOut(amount-10000, payScript))
			prevOut := wire.NewTxOut(amount, prevScript)
			fetcher := txscript.NewCannedPrevOutputFetcher(prevScript, amount)
			sigHashes := txscript.NewTxSigHashes(tx, fetcher)

			vector := CustomLeafVector{
				Name: kind + "-" + item.name, Kind: kind, KeyIndex: keyIndex, SignatureAt: -1,
				InternalPubKey: hex.EncodeToString(schnorr.SerializePubKey(nums)),
				Prevouts:       []PrevoutVector{{Script: hex.EncodeToString(prevScript), Value: amount}},
				LeafScript:     hex.EncodeToString(item.leaf), ControlBlock: hex.EncodeToString(controlBlock),
				UnsignedTxHex: serializeTx(tx, false),
			}
			var witness wire.TxWitness
			for i, element := range item.stack {
				if element == nil {
					sighash, err := txscript.CalcTapscriptSignaturehash(sigHashes, txscript.SigHashDefault, tx, 0, fetcher, leaf)
					check(err)
					signed, err := schnorr.Sign(priv, sighash)
					check(err)
					element = signed.Serialize()
					vector.SignatureAt = i
					vector.Sighash = hex.EncodeToString(sighash)
				}
				witness = append(witness, element)
				vector.Stack = append(vector.Stack, hex.EncodeToString(element))
			}
			tx.TxIn[0].SetWitness(append(witness, item.leaf, controlBlock))
			verifyInputs(tx, []*wire.TxOut{prevOut})
			vector.FinalTxHex = serializeTx(tx, true)
			vector.TxID = tx.TxID()
			out = append(out, vector)
		}
	}
	return out
}

#!/bin/bash
# Rehearses the funded testnet tests on a local regtest pearld with a block
# every minute: starts the node in $PEARL_DRYRUN_DIR (~/pearl-work/testnet2/dryrun),
# makes and funds a rehearsal wallet, mines in the background, runs
# run.sh with the given arguments, and stops what it started, by PID.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="${PEARL_DRYRUN_DIR:-$HOME/pearl-work/testnet2/dryrun}"
bin="${PEARLD:-$HOME/pearl-work/regtest-fp8/bin/pearld}"
chain="${PEARL_DRYRUN_CHAIN:-$HOME/pearl-work/regtest-fp8/chain/setup-blocks.json}"
port=44190
rm -rf "$dir"; mkdir -p "$dir/wallet"; chmod 700 "$dir" "$dir/wallet"
openssl rand -hex 24 > "$dir/rpc.pass"; chmod 600 "$dir/rpc.pass"
miner=$(cd "$here/../.." && node -e "import('pearljs').then(p=>console.log(p.deriveSigningAccountFromSeed(p.mnemonicToSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),p.networks.regtest).deriveAddress(0)))")
"$bin" --regtest --datadir="$dir/data" --logdir="$dir/logs" --rpcuser=pearljs --rpcpass="$(cat "$dir/rpc.pass")" \
  --rpclisten=127.0.0.1:$port --rpccert="$dir/rpc.cert" --rpckey="$dir/rpc.key" --nolisten --nodnsseed \
  --txindex --addrindex --rejectnonstd --rpcmaxclients=64 --miningaddr="$miner" >"$dir/pearld.out" 2>&1 &
node_pid=$!
miner_pid=""
cleanup() { [ -n "$miner_pid" ] && kill "$miner_pid" 2>/dev/null; kill "$node_pid" 2>/dev/null; wait "$node_pid" 2>/dev/null || true; }
trap cleanup EXIT
export PEARL_TESTNET_DIR="$dir" PEARL_TESTNET_NETWORK=regtest PEARL_TESTNET_RPC_URL=https://127.0.0.1:$port PEARL_TESTNET_BLOCKBOOK=off
for _ in $(seq 1 60); do [ -f "$dir/rpc.cert" ] && "$here/../../node_modules/.bin/vitest" --version >/dev/null && break; sleep 1; done
sleep 3
node "$here/wallet.mjs" create
first=$(node "$here/wallet.mjs" address)
node "$here/dryrun.mjs" setup "$chain" "$first"
node "$here/dryrun.mjs" mine >"$dir/miner.log" 2>&1 &
miner_pid=$!
PEARL_TESTNET_BLOCK_WAIT_MS=${PEARL_TESTNET_BLOCK_WAIT_MS:-900000} "$here/run.sh" "$@"

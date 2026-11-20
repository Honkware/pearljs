#!/bin/bash
# Runs the public-network tests in test-testnet/ against the testnet2 node
# that ~/pearl-work/testnet2/start-node.sh runs, with the wallet in its
# wallet/ folder. Arguments go to vitest, so `run.sh relay` runs one file.
# Set PEARL_TESTNET_BLOCKBOOK=off to leave the public Blockbook alone.
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
dir="${PEARL_TESTNET_DIR:-$HOME/pearl-work/testnet2}"
export PEARL_TESTNET_RPC_URL="${PEARL_TESTNET_RPC_URL:-https://127.0.0.1:44114}"
export PEARL_TESTNET_RPC_USER="${PEARL_TESTNET_RPC_USER:-pearljs}"
export PEARL_TESTNET_RPC_PASS_FILE="${PEARL_TESTNET_RPC_PASS_FILE:-$dir/rpc.pass}"
export PEARL_TESTNET_RPC_CA="${PEARL_TESTNET_RPC_CA:-$dir/rpc.cert}"
export PEARL_TESTNET_WALLET_DIR="${PEARL_TESTNET_WALLET_DIR:-$dir/wallet}"
export PEARL_TESTNET_DIR="$dir"
case "${PEARL_TESTNET_BLOCKBOOK:-}" in
  off) unset PEARL_TESTNET_BLOCKBOOK ;;
  '') export PEARL_TESTNET_BLOCKBOOK=https://blockbook.testnet2.pearlnetwork.net ;;
esac
if [ -f "$dir/oyster/rpc.cert" ] && [ -z "${PEARL_TESTNET_OYSTER_URL:-}" ]; then
  export PEARL_TESTNET_OYSTER_URL=https://127.0.0.1:44215 PEARL_TESTNET_OYSTER_CA="$dir/oyster/rpc.cert"
fi
cd "$here"
mkdir -p "$dir/logs"
npx vitest run --config test-testnet/vitest.config.ts "$@" 2>&1 | tee "$dir/logs/tests-$(date +%Y%m%d-%H%M%S).log"
exit "${PIPESTATUS[0]}"

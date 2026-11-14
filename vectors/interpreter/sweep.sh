#!/bin/sh
# A larger differential run than the checked-in vectors: generates random
# scripts under another seed, has Pearl's engine judge them, and runs the
# interpreter's vector test over the result.
#
#   vectors/interpreter/sweep.sh /path/to/pearl [scripts] [seed]
#
# The Pearl checkout needs its XMSS library built: make -C /path/to/pearl/xmss
set -eu

pearl=${1:?usage: sweep.sh /path/to/pearl [scripts] [seed]}
scripts=${2:-50000}
seed=${3:-$(date +%s)}
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)/sweep-$seed.json.gz

echo "seed $seed, $scripts random scripts"
go -C "$pearl" run -tags xmss "$here/generate.go" -random-only -random "$scripts" -seed "$seed" -out "$out"
cd "$here/../.."
PEARLJS_INTERPRETER_VECTORS=$out npx vitest run test/interpreter-vectors.test.ts
rm -f "$out"

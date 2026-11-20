#!/bin/sh
# Runs one mainnet check with the dashboard user's password in the environment
# and nothing else from secrets.env: scripts/mainnet/run.sh walk.mjs [args]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
: "${PEARL_WORK_DIR:?set PEARL_WORK_DIR to the folder that holds mainnet/secrets.env}"
PEARLD_PASS="$(sed -n 's/^PEARLD_PASS=//p' "$PEARL_WORK_DIR/mainnet/secrets.env" | tr -d "\"'")"
export PEARLD_PASS
script="$1"; shift
case "$script" in /*) ;; *) script="$here/$script" ;; esac
exec node --max-old-space-size=24576 "$script" "$@"

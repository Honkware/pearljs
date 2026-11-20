# The miner's side of gateway.test.ts: mines a plain proof for a job's
# 76-byte header with Pearl's own pearl_mining.mine and prints it in base64.
#
#   python gateway-mine.py <incomplete header, hex> <certificate version>
import sys

import pearl_mining as pm

config = pm.MiningConfiguration(
    common_dim=2048,
    rank=128,
    mma_type=pm.MMAType.Int7xInt7ToInt32,
    rows_pattern=pm.PeriodicPattern.from_list([0, 8, 64, 72]),
    cols_pattern=pm.PeriodicPattern.from_list([0, 1, 8, 9, 32, 33, 40, 41]),
    moe=None,
)
proof = pm.mine(
    256,
    256,
    2048,
    pm.IncompleteBlockHeader.from_bytes(bytes.fromhex(sys.argv[1])),
    config,
    cert_version=int(sys.argv[2]),
)
print(proof.to_base64())

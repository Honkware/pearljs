"""Frames of the miner-to-gateway protocol, written by pearl-gateway's own code.

The miner's lines come from JSONRPCClient.call, the client the miners use,
writing into a buffer instead of a socket. The gateway's replies come from
MinerRpcServer._process_request, the handler behind every line a miner sends,
over a work cache holding MiningJob values, encoded as the server encodes
them (json.dumps plus a newline). The modules none of this reaches (torch,
numpy and the Rust pearl_mining extension) are replaced by stand-ins;
PlainProof decoding is one of them, so a proof is carried as opaque base64.
Malformed requests are written by hand. Run it against a Pearl checkout,
master or fp8-scheme:

    python3 vectors/mining/gateway_frames.py /path/to/pearl <commit> > vectors/mining/gateway-<branch>.json
"""

import asyncio
import base64
import json
import sys
import types

root, commit = sys.argv[1], sys.argv[2]
sys.path[:0] = [f"{root}/miner/pearl-gateway/src", f"{root}/miner/miner-utils/src"]


class _Anything:
    def __init__(self, *args, **kwargs):
        self.args = args

    def __getattr__(self, name):
        return _Anything()

    def __call__(self, *args, **kwargs):
        return _Anything()

    @classmethod
    def from_base64(cls, data):
        base64.b64decode(data, validate=True)
        return cls(data)


def _stub(name, **values):
    module = types.ModuleType(name)
    module.__dict__.update(values)
    module.__getattr__ = lambda attr: _Anything
    sys.modules[name] = module


_stub("torch")
_stub("numpy", dtype=lambda *a, **k: _Anything())
_stub("pearl_mining", PENALTY_BASE_RANK=128, PUBLICDATA_SIZE=164, CERT_VERSION_PLAIN_FP8=4)
for name in ["bitcoinutils", "bitcoinutils.transactions", "bitcoinutils.script", "bitcoinutils.bech32", "bitcoinutils.utils"]:
    _stub(name)

import io  # noqa: E402

from pearl_gateway.comm.dataclasses import MiningJob, MiningPausedError  # noqa: E402
from pearl_gateway.comm.json_rpc_client import JSONRPCClient  # noqa: E402
from pearl_gateway.blockchain_utils.blockchain_utils import bits_to_target  # noqa: E402
from pearl_gateway.blockchain_utils.zk_certificate import CertificateVersion  # noqa: E402
from pearl_gateway.miner_rpc.server import ClientInfo, MinerRpcServer  # noqa: E402

fp8 = "ancestor_headers" in MiningJob.__dataclass_fields__


def header_bytes(seed):
    return bytes((seed * 37 + i * 11) % 256 for i in range(76))


def full_header(seed):
    return bytes((seed * 53 + i * 7) % 256 for i in range(108))


jobs = [
    {"incomplete_header_bytes": header_bytes(1), "target": 0x7FFFFF << 232, "cert_version": CertificateVersion(3)},
    {"incomplete_header_bytes": header_bytes(2), "target": 0xFFFF << 208, "cert_version": CertificateVersion(1)},
    {"incomplete_header_bytes": header_bytes(3), "target": 0x1234, "cert_version": CertificateVersion(2)},
]
if fp8:
    jobs.append({"incomplete_header_bytes": header_bytes(4), "target": 0x1FFFF << 216, "cert_version": CertificateVersion(4),
                 "ancestor_headers": [full_header(5), full_header(6), full_header(7), full_header(8)]})


class Cache:
    def __init__(self, job):
        self.job = job
        self.current_template = None

    async def get_mining_job(self):
        if self.job is None:
            raise MiningPausedError("no block template available")
        return self.job


class Config:
    transport = "tcp"


def client_line(method, params=None):
    client = JSONRPCClient.__new__(JSONRPCClient)
    client._request_id = 0
    client._writer = io.StringIO()
    client._reader = io.StringIO('{"jsonrpc": "2.0", "result": null, "id": 1}\n')
    client.call(method, params)
    return client._writer.getvalue()


async def frames():
    out = []

    async def exchange(name, line, job):
        server = MinerRpcServer(Cache(job), None, Config())

        async def submitted(plain_proof, mining_job):
            return None

        server.handle_submit_plain_proof = submitted
        reply = await server._process_request(line.strip(), ClientInfo(0, None))
        await asyncio.sleep(0)
        out.append({"name": name, "request": line, "response": json.dumps(reply) + "\n"})

    for i, fields in enumerate(jobs):
        job = MiningJob(**fields)
        await exchange(f"getMiningInfo {i}", client_line("getMiningInfo"), job)
        proof = base64.b64encode(bytes(range(40 + i))).decode()
        submit = client_line("submitPlainProof", {"plain_proof": proof, "mining_job": job.to_dict()})
        await exchange(f"submitPlainProof {i}", submit, job)

    job = MiningJob(**jobs[0])
    await exchange("getMiningInfo without params", json.dumps({"jsonrpc": "2.0", "method": "getMiningInfo", "id": 7}), job)
    await exchange("mining paused", json.dumps({"jsonrpc": "2.0", "method": "getMiningInfo", "params": {}, "id": 8}), None)
    await exchange("unknown method", json.dumps({"jsonrpc": "2.0", "method": "getwork", "params": {}, "id": 9}), job)
    await exchange("params on getMiningInfo", json.dumps({"jsonrpc": "2.0", "method": "getMiningInfo", "params": {"x": 1}, "id": 10}), job)
    await exchange("missing jsonrpc", json.dumps({"method": "getMiningInfo", "id": 11}), job)
    await exchange("not json", "{getMiningInfo", job)
    bad = {"jsonrpc": "2.0", "method": "submitPlainProof", "id": 12,
           "params": {"plain_proof": "not base64!", "mining_job": job.to_dict()}}
    await exchange("proof not base64", json.dumps(bad), job)
    missing = {"jsonrpc": "2.0", "method": "submitPlainProof", "id": 13,
               "params": {"plain_proof": "AA==", "mining_job": {"target": 1, "cert_version": 3}}}
    await exchange("job without header", json.dumps(missing), job)
    return out


result = {
    "source": "github.com/pearl-research-labs/pearl miner/pearl-gateway" + (" (fp8-scheme)" if fp8 else " (master)"),
    "commit": commit,
    "jobs": [MiningJob(**fields).to_dict() for fields in jobs],
    "targets": [{"bits": bits, "target": str(bits_to_target(bits))}
                for bits in [0x1D00FFFF, 0x207FFFFF, 0x1E010000, 0x1B00FFFF, 0x03123456, 0x04923456, 0x22000001, 0xFF7FFFFF]],
    "frames": asyncio.run(frames()),
}
json.dump(result, sys.stdout, indent=2)
sys.stdout.write("\n")

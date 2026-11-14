// A minimal JSON-RPC client over fetch for the live tests, kept local so it
// can be replaced by a typed client without touching the tests.

export interface RpcEndpoint {
  url: string;
  user: string;
  pass: string;
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export type Rpc = <T = unknown>(method: string, ...params: unknown[]) => Promise<T>;

export function rpcClient(endpoint: RpcEndpoint): Rpc {
  const authorization = `Basic ${Buffer.from(`${endpoint.user}:${endpoint.pass}`).toString('base64')}`;
  let id = 0;
  return async <T>(method: string, ...params: unknown[]): Promise<T> => {
    id += 1;
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id, method, params }),
    });
    const text = await response.text();
    let body: { result?: T; error?: { code: number; message: string } | null };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      throw new RpcError(method, response.status, `HTTP ${response.status}: ${text.trim()}`);
    }
    if (body.error) throw new RpcError(method, body.error.code, body.error.message);
    return body.result as T;
  };
}

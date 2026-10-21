/**
 * ReadOnlyRpc — a minimal Stellar RPC JSON-RPC client for forking a network.
 *
 * A rehearsal must never submit anything, so this client refuses every method
 * outside {@link READ_ONLY_RPC_METHODS}: `sendTransaction` is not merely
 * unused, it cannot be called. Public RPCs rate-limit, so HTTP 429 and 5xx
 * answers are retried with exponential backoff (1 s, 2 s, … 32 s), and the
 * calls and retries are counted for the session report.
 */

/** The only methods this client will call. */
export const READ_ONLY_RPC_METHODS = [
  "getNetwork",
  "getLatestLedger",
  "getLedgerEntries",
  "getVersionInfo",
  "getHealth",
] as const;

export type ReadOnlyRpcMethod = (typeof READ_ONLY_RPC_METHODS)[number];

export interface ReadOnlyRpcOptions {
  /** `fetch` to use (tests inject one). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Retries after a throttled or failed (5xx) answer. Default 6 (1 s … 32 s). */
  maxRetries?: number;
  /** First backoff delay; doubles each retry. Default 1000 ms. */
  baseDelayMs?: number;
  /** Tests replace the timer. */
  sleep?: (ms: number) => Promise<void>;
}

export class RpcRequestError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "RpcRequestError";
  }
}

export interface RpcLedgerEntry {
  key: string;
  xdr: string;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number;
  extXdr?: string;
}

export interface RpcLatestLedger {
  id?: string;
  sequence: number;
  protocolVersion: number;
  headerXdr?: string;
  closeTime?: string;
}

export class ReadOnlyRpc {
  /** Calls made, retries included. */
  calls = 0;
  /** Retries after HTTP 429 or a 5xx. */
  throttled = 0;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private nextId = 1;

  constructor(
    readonly url: string,
    options: ReadOnlyRpcOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxRetries = options.maxRetries ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async call<T>(method: ReadOnlyRpcMethod, params: unknown = {}): Promise<T> {
    if (!(READ_ONLY_RPC_METHODS as readonly string[]).includes(method)) {
      throw new RpcRequestError(
        `refusing RPC method ${method}: a rehearsal only reads from the network`,
      );
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params });
    for (let attempt = 0; ; attempt += 1) {
      this.calls += 1;
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
        this.throttled += 1;
        await this.sleep(this.baseDelayMs * 2 ** attempt);
        continue;
      }
      if (!response.ok) {
        throw new RpcRequestError(`${method} to ${this.url}: HTTP ${response.status}`);
      }
      const json = (await response.json()) as {
        result?: T;
        error?: { code?: number; message?: string };
      };
      if (json.error) {
        throw new RpcRequestError(
          `${method}: ${json.error.message ?? JSON.stringify(json.error)}`,
          json.error.code,
        );
      }
      if (json.result === undefined) throw new RpcRequestError(`${method}: no result`);
      return json.result;
    }
  }

  network(): Promise<{ passphrase: string; protocolVersion: number }> {
    return this.call("getNetwork");
  }

  latestLedger(): Promise<RpcLatestLedger> {
    return this.call("getLatestLedger");
  }

  /** At most 200 base64 LedgerKey XDR strings per call (RPC's cap). */
  ledgerEntries(
    keys: string[],
  ): Promise<{ latestLedger: number; entries: RpcLedgerEntry[] | null }> {
    return this.call("getLedgerEntries", { keys });
  }
}

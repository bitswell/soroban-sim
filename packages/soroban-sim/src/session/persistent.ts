/**
 * PersistentSession — a {@link SorobanSession} whose log and fork cache live in
 * a {@link SessionStore}, so it survives a reload.
 *
 * Every base batch the session fetches is cached; every JSON-RPC body that
 * changed the session is appended to the log once the session has answered
 * it. Resuming forks the same ledger again, hands the component the whole
 * cache, and replays the log: the same envelopes over the same base give the
 * same session, without touching the network.
 *
 * Two things stay live only. An envelope a real key signed (a signature the
 * real network would accept, refused or applied) is never logged: it could
 * be submitted there. Nor is `fork_allowRealSigners`: the allowance covers
 * the submissions made while it is on, so a resumed session refuses real
 * signers again.
 */
import { RpcBaseLedger, type BaseBatch, type BaseLedger } from "./base.js";
import { forkConfigFromRpc, type ForkFromRpcOptions } from "./fork.js";
import { ReadOnlyRpc, type ReadOnlyRpcOptions } from "./rpc.js";
import {
  bodyChangesSession,
  bodyMethods,
  type NetworkSessionModule,
  SessionRpcError,
  SorobanSession,
  type SorobanSessionOptions,
} from "./session.js";
import { loadForkConfig, type SessionRecord, SessionStore, storeForkConfig } from "./store.js";

export interface StartSessionOptions extends ForkFromRpcOptions {
  store: SessionStore;
  module: NetworkSessionModule;
  /** The base RPC to fork (read only). */
  rpcUrl: string;
  title?: string;
  /** A fixed id (tests); a random one by default. */
  id?: string;
  rpcOptions?: ReadOnlyRpcOptions;
  sessionOptions?: Omit<SorobanSessionOptions, "onBatch">;
}

export interface ResumeSessionOptions {
  store: SessionStore;
  module: NetworkSessionModule;
  id: string;
  rpcOptions?: ReadOnlyRpcOptions;
  sessionOptions?: Omit<SorobanSessionOptions, "onBatch">;
  /** Called after each replayed body: `(done, total)`. */
  onReplay?: (done: number, total: number) => void;
}

/** JSON-RPC errors that never change a session; such bodies are not logged. */
const NO_OP_ERRORS = new Set([-32700, -32600, -32601, -32602]);

/** Methods whose bodies are never logged (see above). */
const LIVE_ONLY_METHODS = ["fork_allowRealSigners"];

export class PersistentSession {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly store: SessionStore,
    readonly record: SessionRecord,
    readonly session: SorobanSession,
    /** The base RPC client (read only), for its call counters. */
    readonly baseRpc: ReadOnlyRpc,
  ) {}

  get id(): string {
    return this.record.id;
  }

  /** Fork `rpcUrl` at its latest ledger and start a new logged session. */
  static async start(options: StartSessionOptions): Promise<PersistentSession> {
    const rpc = new ReadOnlyRpc(options.rpcUrl, options.rpcOptions);
    const fork = await forkConfigFromRpc(rpc, options);
    const record = await options.store.create({
      id: options.id ?? randomId(),
      title: options.title ?? `${options.networkName} at ledger ${fork.forkLedger}`,
      createdAt: Date.now(),
      rpcUrl: options.rpcUrl,
      fork: storeForkConfig(fork),
    });
    const persistent = PersistentSession.wrap(options.store, record, options.module, rpc, options.sessionOptions);
    try {
      // Open now: reads the network settings and checks the protocol.
      await persistent.session.call("fork_info");
    } catch (e) {
      await options.store.delete(record.id);
      persistent.session.dispose();
      throw e;
    }
    return persistent;
  }

  /** Rebuild a stored session from its fork cache and log. */
  static async resume(options: ResumeSessionOptions): Promise<PersistentSession> {
    const record = await options.store.get(options.id);
    if (!record) throw new Error(`no stored session ${options.id}`);
    const rpc = new ReadOnlyRpc(record.rpcUrl, options.rpcOptions);
    const persistent = PersistentSession.wrap(options.store, record, options.module, rpc, options.sessionOptions);
    for (const batch of await options.store.base(record.id)) persistent.session.provide(batch);
    const ops = await options.store.ops(record.id);
    for (const [i, body] of ops.entries()) {
      await persistent.session.rpc(body);
      options.onReplay?.(i + 1, ops.length);
    }
    return persistent;
  }

  private static wrap(
    store: SessionStore,
    record: SessionRecord,
    module: NetworkSessionModule,
    rpc: ReadOnlyRpc,
    sessionOptions: Omit<SorobanSessionOptions, "onBatch"> = {},
  ): PersistentSession {
    const base: BaseLedger = new RpcBaseLedger(rpc);
    const session = SorobanSession.fork(module, loadForkConfig(record.fork), base, {
      ...sessionOptions,
      onBatch: async (batch: BaseBatch) => {
        await store.putBase(record.id, batch);
        session.setRpcCounters(rpc.calls, rpc.throttled);
      },
    });
    return new PersistentSession(store, record, session, rpc);
  }

  /**
   * Answer a JSON-RPC body, logging it if it changed the session and holds no
   * real-signed envelope. One body at a time, so the log keeps the session's
   * order.
   */
  rpc(body: string): Promise<string | undefined> {
    const run = () => this.answer(body);
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async answer(body: string): Promise<string | undefined> {
    const methods = bodyMethods(body);
    const sends = methods.includes("sendTransaction");
    const before = sends ? await this.realSignatures() : 0;
    const response = await this.session.rpc(body);
    if (!bodyChangesSession(body) || isNoOpError(response)) return response;
    if (methods.some((m) => LIVE_ONLY_METHODS.includes(m))) return response;
    if (sends && (await this.realSignatures()) > before) return response;
    await this.store.appendOp(this.record.id, body);
    return response;
  }

  /** Signatures valid on the real network the session has seen so far. */
  private async realSignatures(): Promise<number> {
    return (await this.session.call<{ replayable: number }>("fork_info")).replayable;
  }

  /** Call one method through {@link rpc}, so it is logged the same way. */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const response = await this.rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    if (response === undefined) throw new Error("the session sent no response");
    const parsed = JSON.parse(response) as { result?: T; error?: { code: number; message: string } };
    if (parsed.error) throw new SessionRpcError(parsed.error.code, parsed.error.message);
    return parsed.result as T;
  }

  dispose(): void {
    this.session.dispose();
  }
}

function isNoOpError(response: string | undefined): boolean {
  if (response === undefined) return false;
  try {
    const parsed = JSON.parse(response) as unknown;
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    return replies.every((r) => NO_OP_ERRORS.has((r as { error?: { code?: number } })?.error?.code ?? 0));
  } catch {
    return false;
  }
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

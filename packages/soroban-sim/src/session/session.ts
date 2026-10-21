/**
 * SorobanSession — the TypeScript side of the component's `network-session`
 * resource: a fork of a real network that applies signed transactions in
 * order, each seeing every earlier write, behind stellar-rpc's JSON-RPC
 * methods plus `fork_*` admin methods (the same facade `soroban-sim serve`
 * runs; see docs/rpc-facade.md).
 *
 * The component reads the base lazily through its caller. Every call runs the
 * same loop the simulator runs for one transaction:
 *
 *   call ─▶ needs-state(keys) ─▶ BaseLedger.fetch(keys) ─▶ provide ─▶ call again
 *
 * The component undoes a call that needed state before returning the keys, so
 * repeating it is safe. Calls are serialized: a session is one ordered
 * history, and a call waiting on the network must not let a later one jump
 * the queue.
 */
import type {
  LedgerOverride,
  Reply,
} from "../generated/interfaces/theahaco-soroban-sim-network-session.js";
import type { BaseBatch, BaseLedger } from "./base.js";

export type { LedgerOverride, Reply };

/** WIT `base-batch`: what the component's `provide` takes. */
export interface ComponentBaseBatch {
  servedAtLedger: number;
  entries: Array<{ entryXdr: Uint8Array; liveUntilLedger?: number }>;
  absentKeys: Uint8Array[];
}

/** The component resource, structurally (tests inject a fake). */
export interface ComponentSession {
  provide(batch: ComponentBaseBatch): void;
  rpc(body: string): Reply;
  submit(envelopeXdr: Uint8Array): Reply;
  advance(ledgers: number, seconds: bigint | undefined): Reply;
  setTime(time: bigint): Reply;
  applyOverride(change: LedgerOverride): Reply;
  snapshot(label: string): Reply;
  revert(id: number): Reply;
  allowRealSigners(allow: boolean): Reply;
  steps(): Reply;
  debugContext(step: number): Reply;
  report(): Reply;
  setRpcCounters(calls: number, throttledRetries: number): void;
  [Symbol.dispose]?(): void;
}

/** What the component's constructor takes (WIT `fork-config`). */
export interface ForkConfig {
  networkName: string;
  networkPassphrase: string;
  baseDescription: string;
  forkLedger: number;
  forkCloseTime: bigint;
  protocolVersion: number;
  baseReserve: number;
  baseFee: number;
  headerXdr?: Uint8Array;
  secondsPerLedger: number;
  allowRealSigners: boolean;
  servedBy: string;
}

/** The generated module's `networkSession` export, structurally. */
export interface NetworkSessionModule {
  Session: new (config: ForkConfig) => ComponentSession;
}

export interface SorobanSessionOptions {
  /** Needs-state rounds one call may take before giving up. Default 64. */
  maxRounds?: number;
  /** Called with every batch fetched from the base (persistence hooks in). */
  onBatch?: (batch: BaseBatch) => void | Promise<void>;
}

/** A JSON-RPC error the session answered with. */
export class SessionRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SessionRpcError";
  }
}

/** The facade refused an envelope a real mainnet signer signed. */
export const REFUSED_REAL_SIGNER = -32001;

/** The JSON-RPC methods that only read (the facade's `READ_ONLY_METHODS`). */
export const READ_ONLY_SESSION_METHODS: readonly string[] = [
  "getHealth",
  "getNetwork",
  "getVersionInfo",
  "getLatestLedger",
  "getFeeStats",
  "getLedgerEntries",
  "simulateTransaction",
  "getTransaction",
  "getEvents",
  "fork_info",
  "fork_steps",
  "fork_debugContext",
  "fork_report",
];

/** The methods a JSON-RPC body (a call or a batch) calls. */
export function bodyMethods(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  return calls.flatMap((c) => {
    const method = (c as { method?: unknown } | null)?.method;
    return typeof method === "string" ? [method] : [];
  });
}

/** Whether a JSON-RPC body (a call or a batch) can change the session. */
export function bodyChangesSession(body: string): boolean {
  return bodyMethods(body).some((method) => !READ_ONLY_SESSION_METHODS.includes(method));
}

export class SorobanSession {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxRounds: number;
  /** Needs-state rounds so far. */
  rounds = 0;

  constructor(
    readonly component: ComponentSession,
    readonly base: BaseLedger,
    private readonly options: SorobanSessionOptions = {},
  ) {
    this.maxRounds = options.maxRounds ?? 64;
  }

  /** Fork a network: `module` is the generated `networkSession` export. */
  static fork(
    module: NetworkSessionModule,
    config: ForkConfig,
    base: BaseLedger,
    options?: SorobanSessionOptions,
  ): SorobanSession {
    return new SorobanSession(new module.Session(config), base, options);
  }

  /** Hand the component base entries fetched elsewhere (a cache). */
  provide(batch: BaseBatch): void {
    this.component.provide(componentBatch(batch));
  }

  /** Answer a JSON-RPC body; `undefined` when it held notifications only. */
  rpc(body: string): Promise<string | undefined> {
    return this.drive(() => this.component.rpc(body));
  }

  /** Call one method; throws {@link SessionRpcError} on a JSON-RPC error. */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const response = await this.rpc(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    return unwrap<T>(response);
  }

  submit(envelope: Uint8Array): Promise<SendResult> {
    return this.typed(() => this.component.submit(envelope));
  }

  advance(ledgers: number, seconds?: number): Promise<SessionClock> {
    return this.typed(() =>
      this.component.advance(ledgers, seconds === undefined ? undefined : BigInt(seconds)),
    );
  }

  setTime(time: number | bigint): Promise<SessionClock> {
    return this.typed(() => this.component.setTime(BigInt(time)));
  }

  applyOverride(change: LedgerOverride): Promise<{ override: string }> {
    return this.typed(() => this.component.applyOverride(change));
  }

  snapshot(label = ""): Promise<SessionClock & { id: number }> {
    return this.typed(() => this.component.snapshot(label));
  }

  revert(id: number): Promise<SessionClock & { id: number; reverted: number }> {
    return this.typed(() => this.component.revert(id));
  }

  allowRealSigners(allow: boolean): Promise<{ allowRealSigners: boolean }> {
    return this.typed(() => this.component.allowRealSigners(allow));
  }

  steps(): Promise<SessionSteps> {
    return this.typed(() => this.component.steps());
  }

  debugContext(step: number): Promise<StepDebugContext> {
    return this.typed(() => this.component.debugContext(step));
  }

  report(): Promise<SessionReportResult> {
    return this.typed(() => this.component.report());
  }

  setRpcCounters(calls: number, throttledRetries: number): void {
    this.component.setRpcCounters(calls, throttledRetries);
  }

  dispose(): void {
    this.component[Symbol.dispose]?.();
  }

  private async typed<T>(op: () => Reply): Promise<T> {
    return unwrap<T>(await this.drive(op));
  }

  /** Run `op` until it answers, fetching what it needs; one call at a time. */
  private drive(op: () => Reply): Promise<string | undefined> {
    const run = async (): Promise<string | undefined> => {
      for (let round = 0; ; round += 1) {
        const reply = op();
        if (reply.tag === "response") return reply.val;
        if (round >= this.maxRounds) {
          throw new Error(
            `the session still needed ${reply.val.length} base entries after ${this.maxRounds} rounds`,
          );
        }
        this.rounds += 1;
        const batch = await this.base.fetch(reply.val);
        this.component.provide(componentBatch(batch));
        await this.options.onBatch?.(batch);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function componentBatch(batch: BaseBatch): ComponentBaseBatch {
  return {
    servedAtLedger: batch.servedAtLedger,
    entries: batch.entries.map((e) => ({
      entryXdr: e.entryXdr,
      ...(e.liveUntilLedger !== undefined ? { liveUntilLedger: e.liveUntilLedger } : {}),
    })),
    absentKeys: batch.absentKeys,
  };
}

function unwrap<T>(response: string | undefined): T {
  if (response === undefined) throw new Error("the session sent no response");
  const parsed = JSON.parse(response) as {
    result?: T;
    error?: { code: number; message: string };
  };
  if (parsed.error) throw new SessionRpcError(parsed.error.code, parsed.error.message);
  return parsed.result as T;
}

// --- result shapes (the facade's JSON) -------------------------------------

export interface SessionClock {
  latestLedger: number;
  latestLedgerCloseTime: number;
  next: { ledger: number; closeTime: number };
}

export interface SendResult {
  status: "PENDING" | "ERROR" | "DUPLICATE";
  hash: string;
  errorResultXdr?: string;
  latestLedger: number;
}

/** One transaction's row (the report's `TxReport`). */
export interface TxReport {
  hash: string;
  source: string;
  fee_bid: number;
  resource_fee: number;
  non_refundable_fee: number;
  refundable_fee: number;
  inclusion_fee: number;
  fee_charged: number;
  refunded: number;
  rent_fee: number;
  events_fee: number;
  cpu_insns: number;
  declared_cpu_insns: number;
  mem_bytes: number;
  write_bytes: number;
  declared_write_bytes: number;
  entries_written: number;
  restored: number;
  events: number;
  contract_errors: number[];
  signers: string[];
  replayable: string[];
}

/** One entry a step changed. */
export interface StepChange {
  key: string;
  key_type: string;
  entry: string;
  change: "created" | "updated" | "deleted" | "ttl extended" | "restored";
  before: string | null;
  after: string | null;
  live_until_before: number | null;
  live_until_after: number | null;
}

/** One authorization entry of a step's envelope. */
export interface StepAuth {
  credentials: "source_account" | "address" | "address_v2" | "address_with_delegates";
  address?: string;
  nonce?: string;
  expiration_ledger?: number;
  signed: boolean;
  invocation: string;
  delegates?: number;
}

/** One state change: a transaction, an override, a clock move, a snapshot. */
export interface SessionStep {
  index: number;
  name: string;
  kind: "transaction" | "override" | "advance" | "snapshot" | "revert" | "safety" | string;
  ledger: number;
  close_time: number;
  outcome: "applied" | "failed" | "rejected" | "refused" | "ok" | string;
  detail: string;
  passed: boolean;
  value: string | null;
  tx: TxReport | null;
  reverted: boolean;
  failure: string | null;
  envelope_xdr: string | null;
  changes: StepChange[];
  auth: StepAuth[];
  debuggable: boolean;
}

export interface SessionSteps {
  steps: SessionStep[];
  clock: SessionClock;
}

/** What the time-travel debugger needs to trace one step again. */
export interface StepDebugContext {
  step: number;
  networkPassphrase: string;
  ledgerContext: {
    protocolVersion: number;
    sequenceNumber: number;
    timestamp: string;
    networkId: string;
    baseReserve: number;
    minTempEntryTtl: number;
    minPersistentEntryTtl: number;
    maxEntryTtl: number;
  };
  hostFunctionXdr: string;
  sourceAccountXdr: string;
  entries: Array<{ keyXdr: string; entryXdr: string; liveUntilLedger: number | null }>;
}

/** `soroban-sim-session-report/1`, as `soroban-sim session run` writes it. */
export interface SessionReport {
  format: string;
  plan: { path: string; name: string | null; description: string | null };
  network: { name: string; passphrase: string; base: string };
  fork: { ledger: number; close_time: number; protocol_version: number; base_fee: number; base_reserve: number };
  host: { protocol_version: number; soroban_env_host: string };
  fidelity: string[];
  end: { ledger: number; close_time: number };
  passed: boolean;
  failures: string[];
  steps: Array<Omit<SessionStep, "reverted" | "failure" | "envelope_xdr" | "changes" | "auth" | "debuggable">>;
  overrides: Array<{ kind: string; entry: string; label: string; detail: string; at_ledger: number }>;
  fees: {
    transactions: number;
    applied: number;
    failed: number;
    rejected: number;
    total_charged: number;
    total_refunded: number;
    by_payer: Array<{ account: string; transactions: number; charged: number; refunded: number; max_fee_bid: number }>;
  };
  accounts: Array<{
    account: string;
    balance_before: number | null;
    balance_after: number | null;
    seq_before: number | null;
    seq_after: number | null;
    overridden: boolean;
  }>;
  diff: {
    total: number;
    by_type: Record<string, number>;
    entries: Array<{
      key_type: string;
      key: string;
      change: string;
      overridden: boolean;
      live_until_before: number | null;
      live_until_after: number | null;
    }>;
  };
  drift: {
    fork_ledger: number;
    served_at_min: number | null;
    served_at_max: number | null;
    modified_after_fork: Array<{ key: string; last_modified: number; served_at: number }>;
  };
  fetch: {
    rpc_calls: number;
    throttled_retries: number;
    base_fetch_calls: number;
    keys_fetched: number;
    keys_present: number;
    local_answers: number;
  };
  safety: { replayable: string[]; note: string };
}

export interface SessionReportResult {
  passed: boolean;
  failures: string[];
  report: SessionReport;
  markdown: string;
}

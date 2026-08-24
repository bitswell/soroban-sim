/**
 * Worker <-> main message protocol (Topology A).
 *
 * The worker owns the SorobanSimulator, the StateProvider, all XDR decoding, and
 * the rerun loop. The main thread only renders. Two independent flows share the
 * worker:
 *
 *   1. The M0 golden path (`run-fixture` -> `result`). Its shape is a frozen
 *      contract read by the Playwright gate — do not change `result`'s fields.
 *   2. The interactive demo (`simulate` -> `round`* -> `sim-result` | `sim-error`).
 */

export type DemoMode = "offline" | "live";

/** One requested LedgerKey, decoded for display, with its resolution. */
export interface RoundKey {
  /** Full human label, e.g. "ContractData CDLZ…CYSC · persistent". */
  label: string;
  /** Coarse arm class for coloring/grouping: ContractData, ConfigSetting, … */
  kind: string;
  /** Short discriminator (address tail, code hash, setting id). */
  detail: string;
  /** Whether the provider resolved the key present or absent. */
  status: "present" | "absent";
  /** liveUntilLedger TTL, present entries only. */
  ttl?: number;
}

// ---- main -> worker -------------------------------------------------------

export interface RunFixtureMsg {
  type: "run-fixture";
}
export interface SimulateMsg {
  type: "simulate";
  id: number;
  mode: DemoMode;
  fixtureId: string;
  /** Wrap the live RPC provider in the IndexedDB CachingStateProvider. */
  cache: boolean;
}
export interface CancelMsg {
  type: "cancel";
  id: number;
}
export type MainToWorker = RunFixtureMsg | SimulateMsg | CancelMsg;

/** A footprint LedgerKey, decoded for display (same shape as a RoundKey label). */
export interface FootprintKey {
  /** Coarse arm class: ContractData, ContractCode, Account, … */
  kind: string;
  /** Short discriminator (address tail, code hash, setting id). */
  detail: string;
  /** Full human label, e.g. "ContractData CDLZ…CYSC · persistent". */
  label: string;
}

/** A contract event the run emitted, decoded for display. */
export interface EventLabel {
  /** Event type: contract | system | diagnostic. */
  type: string;
  /** Emitting contract (C… address), when present. */
  contractId?: string;
  /** Topic ScVals, decoded to short printable form. */
  topics: string[];
  /** Data ScVal, decoded to short printable form. */
  data: string;
}

/** A recorded authorization entry, decoded for display. */
export interface AuthEntryLabel {
  /** Credentials kind: SourceAccount | Address. */
  credentials: string;
  /** Invoked contract (C… address), for a contract-fn root invocation. */
  contract?: string;
  /** Invoked function name, for a contract-fn root invocation. */
  fn?: string;
  /** Count of sub-invocations under the root. */
  subInvocations: number;
}

/** A tagged span of the SSIM result envelope, for the byte-map view. */
export interface ByteRegion {
  /** Stable kind slug for coloring: magic | budget | result | auth | events | diagnostics | txdata | modified. */
  kind: string;
  /** Human label for the region. */
  label: string;
  /** Half-open byte range within the envelope. */
  start: number;
  end: number;
}

/** Declared transaction resources + resource fee from SorobanTransactionData. */
export interface ResourceInfo {
  /** Adjusted CPU instructions declared in the transaction resources. */
  instructions: number;
  /** Disk read bytes declared in the transaction resources. */
  readBytes: number;
  /** Write bytes declared in the transaction resources. */
  writeBytes: number;
  /** Resource fee in stroops (string preserves the i64 range). */
  resourceFee: string;
}

// ---- worker -> main -------------------------------------------------------

export interface ReadyMsg {
  type: "ready";
}
/** M0 golden result — FROZEN SHAPE (Playwright reads len/sha256/elapsedMs). */
export interface ResultMsg {
  type: "result";
  len: number;
  sha256: string;
  elapsedMs: number;
}
/** Emitted once per resolved needs-state round. */
export interface RoundMsg {
  type: "round";
  id: number;
  /** 1-based round index (component run that produced the needs-state). */
  roundIndex: number;
  /** Reruns triggered so far (from onProgress). */
  rerunCount: number;
  /** Distinct keys requested so far. */
  requestedKeyCount: number;
  /** Keys resolved in this round (usually one; the component asks incrementally). */
  keys: RoundKey[];
  /** Wall time the provider took to resolve this batch. */
  roundMs: number;
}
export interface SimResultMsg {
  type: "sim-result";
  id: number;
  rounds: number;
  requestedKeyCount: number;
  elapsedMs: number;
  resultLen: number;
  sha256: string;
  /** Decoded return value. */
  scValType: string;
  scValDisplay: string;
  /** Whether the simulation returned a value (vs. an inline host error). */
  ok: boolean;
  /** Inline host/contract error string, when ok === false. */
  errorText?: string;
  /** Snapshot tallies the loop accumulated. */
  present: number;
  absent: number;
  /** Raw metering the component reported (adjustment-independent). */
  instructions: number;
  memoryBytes: number;
  /** Whether a SorobanTransactionData (footprint/fee) was produced. */
  hasTxData: boolean;
  /** Read-only footprint keys the run touched (from transaction_data). */
  readOnly?: FootprintKey[];
  /** Read-write footprint keys the run may have modified. */
  readWrite?: FootprintKey[];
  /** Declared resources + resource fee (from transaction_data). */
  resources?: ResourceInfo;
  /** Contract events the run emitted. */
  contractEvents?: EventLabel[];
  /** Authorization entries the run recorded. */
  auth?: AuthEntryLabel[];
  /** Count of diagnostic events (populated only when diagnostics are enabled). */
  diagnosticEventCount?: number;
  /** Count of post-invocation ledger-entry diffs the run produced. */
  modifiedCount?: number;
  /** Region map of the SSIM envelope, for the byte-map view. */
  regions?: ByteRegion[];
  /** Lowercase hex of the SSIM envelope (omitted for very large envelopes). */
  resultHex?: string;
}
export interface SimErrorMsg {
  type: "sim-error";
  id: number;
  message: string;
}
export type WorkerToMain =
  | ReadyMsg
  | ResultMsg
  | RoundMsg
  | SimResultMsg
  | SimErrorMsg;

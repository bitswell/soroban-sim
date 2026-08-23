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
  /** Metering the component reported. */
  instructions: number;
  memoryBytes: number;
  /** Whether a SorobanTransactionData (footprint/fee) was produced. */
  hasTxData: boolean;
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

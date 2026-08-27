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
  /** Semantic identity used to explain contract loading vs. contract storage. */
  role?: "contract-storage" | "contract-instance" | "contract-code";
  /** Decoded storage key or full code hash, when one exists. */
  key?: string;
  /** Whether the provider resolved the key present or absent. */
  status: "present" | "absent";
  /** liveUntilLedger TTL, present entries only. */
  ttl?: number;
  /** Decoded value for a present ContractData storage entry. */
  value?: {
    type: string;
    display: string;
  };
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
/**
 * Debug the completed run `id`: the worker re-invokes the two-pass
 * `simulate-trace` component export over the entries the run accumulated
 * (all state known by then, so no network) and posts a `debug-result`.
 */
export interface DebugMsg {
  type: "debug";
  id: number;
}
/** Parse an uploaded contract wasm: hash it, extract the spec, list functions. */
export interface UploadParseMsg {
  type: "upload-parse";
  id: number;
  fileName: string;
  bytes: Uint8Array;
}
/**
 * Invoke a function on the previously parsed uploaded contract. `args` are the
 * raw user-entered strings, one per argument; the worker converts them using
 * the contract spec (spec ladder) or decodes them as base64 ScVal XDR (`raw`).
 */
export interface SimulateUploadMsg {
  type: "simulate-upload";
  id: number;
  fn: string;
  args: string[];
  /** true => free-form fn + base64-ScVal-XDR args (the no-spec floor). */
  raw: boolean;
}
/** Read a deployed Testnet contract instance/code and extract its callable spec. */
export interface LoadContractMsg {
  type: "load-contract";
  id: number;
  contractId: string;
}
/** Invoke a deployed Testnet contract using ledger state resolved through RPC. */
export interface SimulateContractMsg {
  type: "simulate-contract";
  id: number;
  contractId: string;
  fn: string;
  args: string[];
  /** true => args are base64 ScVal XDR instead of spec-typed values. */
  raw: boolean;
  /** Real Testnet fee payer used to build the exact envelope, when available. */
  sourceAccount?: string;
  /** Current on-chain sequence of `sourceAccount`, before this transaction. */
  sourceAccountSequence?: string;
}
/** Simulate a caller-supplied transaction envelope locally against Testnet state. */
export interface SimulateXdrMsg {
  type: "simulate-xdr";
  id: number;
  /** Base64 stellar-xdr TransactionEnvelope. */
  transactionXdr: string;
}
export type MainToWorker =
  | RunFixtureMsg
  | SimulateMsg
  | CancelMsg
  | DebugMsg
  | UploadParseMsg
  | SimulateUploadMsg
  | LoadContractMsg
  | SimulateContractMsg
  | SimulateXdrMsg;

/** A footprint LedgerKey, decoded for display (same shape as a RoundKey label). */
export interface FootprintKey {
  /** Coarse arm class: ContractData, ContractCode, Account, … */
  kind: string;
  /** Human discriminator (storage key, contract address, code hash, setting id). */
  detail: string;
  /** Full human label, e.g. "ContractData CDLZ…CYSC · persistent". */
  label: string;
  /** Semantic identity used to separate contract access from host support. */
  role?: "contract-storage" | "contract-instance" | "contract-code";
  /** Decoded storage key or code hash, when one exists. */
  key?: string;
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
  /** G- or C-address that must authorize address credentials. */
  address?: string;
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

/** One transaction-wide ledger change decoded into a before/after summary. */
export interface StateChangeLabel {
  kind: string;
  key: string;
  change: "created" | "updated" | "deleted" | "restored";
  /** Contract business state vs. host-managed archival restoration. */
  category?: "contract" | "maintenance" | "transaction";
  before?: string;
  after?: string;
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
  /** Return type declared by the loaded contract spec, when available. */
  declaredResultType?: string;
  /** A successful Option<T> invocation returned None (raw ScVal::Void). */
  emptyResult?: boolean;
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
  /** Decoded before/after ledger changes produced by the invocation. */
  stateChanges?: StateChangeLabel[];
  /** Which input surface produced this result. */
  requestKind?: "fixture" | "upload" | "contract" | "xdr";
  /** Ledger snapshot used for a live Testnet run. */
  ledgerSequence?: number;
  /** Source G account carried by the invocation/envelope, when decodable. */
  sourceAccount?: string;
  /** Operation count for a supplied transaction envelope. */
  operationCount?: number;
  /**
   * Exact unsigned envelope with local transaction data + recorded auth applied.
   * Present only when the contract run supplied a real, funded source account.
   */
  preparedTransactionXdr?: string;
  /** Region map of the SSIM envelope, for the byte-map view. */
  regions?: ByteRegion[];
  /** Lowercase hex of the SSIM envelope (omitted for very large envelopes). */
  resultHex?: string;
  /** True when the worker stashed a trace-replay context for this run. */
  debuggable?: boolean;
}
export interface SimErrorMsg {
  type: "sim-error";
  id: number;
  message: string;
}

// ---- visual debugger ------------------------------------------------------

/** One semantic step of the recorded execution, display-ready. */
export interface DebugStep {
  /** 0-based position in the trace. */
  seq: number;
  /** TraceEvent variant: begin | push-ctx | pop-ctx | env-call | env-ret | end. */
  kind: string;
  /** Short name (env fn or frame label). */
  name: string;
  /** Full Display rendering, e.g. `call put_contract_data(U32(7), U32(99), Temporary)`. */
  display: string;
  /** Cumulative CPU instructions / memory bytes at this step. */
  cpu: number;
  mem: number;
  /** Delta vs the previous step. */
  dCpu: number;
  dMem: number;
  /** True for env-calls that touch contract storage (the ledger lane). */
  storage: boolean;
  /** Index into `DebugResultMsg.frames` of the innermost enclosing call-tree frame; -1 outside all frames. */
  frame: number;
  /** For push-ctx: seq of the matching pop-ctx (step-over target); -1 otherwise. */
  matchPop: number;
}

/** One call-tree frame, built from Tier-1 fn_call/fn_return diagnostics. */
export interface DebugFrame {
  /** Index of the parent frame, -1 for roots. */
  parent: number;
  depth: number;
  /** Invoked contract (C… address), when decodable. */
  contract?: string;
  fn: string;
  /** Decoded call arguments, printable form. */
  args: string[];
  /** Decoded return value (absent when the frame never returned). */
  ret?: string;
  /** Trace-step range [pushSeq, popSeq] this frame covers; -1 when uncorrelated. */
  pushSeq: number;
  popSeq: number;
}

export interface DebugResultMsg {
  type: "debug-result";
  id: number;
  /**
   * Set when the enforcing trace replay was unavailable (e.g. address-credential
   * auth); `steps` is empty and the call tree (Tier 1) is all we can show.
   */
  reason?: string;
  steps: DebugStep[];
  frames: DebugFrame[];
  /** Budget totals of the traced run (last step's cumulative counters). */
  totalCpu: number;
  totalMem: number;
  elapsedMs: number;
}
export interface DebugErrorMsg {
  type: "debug-error";
  id: number;
  message: string;
}

// ---- upload-any-contract --------------------------------------------------

/** Input widget class for one spec-typed argument. */
export type UploadArgInput =
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "bool"
  | "string"
  | "symbol"
  | "address"
  | "xdr";

export interface UploadFnArg {
  name: string;
  /** Spec type name, e.g. scSpecTypeU32 (or "scval-xdr" on the raw rungs). */
  type: string;
  input: UploadArgInput;
}
export interface UploadFnInfo {
  name: string;
  args: UploadFnArg[];
  /** Human-readable declared return types, e.g. Option<String>. */
  outputs?: string[];
}
export interface UploadInfoMsg {
  type: "upload-info";
  id: number;
  ok: boolean;
  error?: string;
  fileName: string;
  size: number;
  /** Deterministic contract id derived from the code hash (C… address). */
  contractId: string;
  /** sha-256 of the uploaded code (the ContractCode ledger key). */
  codeHash: string;
  /**
   * Labeling ladder rung: `spec` = typed args from contractspecv0;
   * `names` = wasm export names only (args as raw ScVal XDR);
   * `raw` = free-form fn + raw ScVal XDR args.
   */
  ladder: "spec" | "names" | "raw";
  fns: UploadFnInfo[];
}

/** Metadata/spec discovered from a deployed Testnet contract. */
export interface ContractInfoMsg {
  type: "contract-info";
  id: number;
  ok: boolean;
  error?: string;
  contractId: string;
  executable?: "wasm" | "stellar-asset";
  codeHash?: string;
  ledgerSequence?: number;
  protocolVersion?: number;
  ladder: "spec" | "raw";
  fns: UploadFnInfo[];
}

export type WorkerToMain =
  | ReadyMsg
  | ResultMsg
  | RoundMsg
  | SimResultMsg
  | SimErrorMsg
  | DebugResultMsg
  | DebugErrorMsg
  | UploadInfoMsg
  | ContractInfoMsg;

// Component boundary (jco-generated).
export {
  runFixture,
  simulate,
  simulateTrace,
  simulateTransaction,
} from "./generated/soroban-sim-component.js";
export type {
  LedgerContext,
  LedgerEntry,
  Outcome,
  Request,
  TraceOutcome,
  TransactionRequest,
} from "./generated/soroban-sim-component.js";

// STRC trace decoding (visual debugger).
export { decodeTrace, TRACE_MAGIC } from "./trace.js";
export type { TraceStep, TraceStepKind } from "./trace.js";

// State provider contract (#8 ships concrete providers).
export type { EntryResolution, StateProvider } from "./state-provider.js";

// Loop safety limits + enforcement (#10).
export {
  assertEntrySize,
  DEFAULT_LIMITS,
  LimitTracker,
  SimulationLimitError,
} from "./limits.js";
export type { Limits, LimitViolation } from "./limits.js";

// Simulator driver (Topology A rerun loop).
export { SorobanSimulator } from "./simulator.js";
export type {
  Component,
  ComponentSimulate,
  ComponentSimulateTrace,
  ComponentSimulateTransaction,
  SimulateInput,
  SimulateProgress,
  SimulateResult,
  SimulateRunOptions,
  SimulateTraceResult,
  SimulateTransactionInput,
  SimulatorOptions,
  StateCache,
} from "./simulator.js";

// --- Intended stable export paths for later M2 stages ---------------------
// These files arrive in #8/#9; the lines are pre-declared here (commented) so
// those stages need not edit this barrel again — just uncomment.
//
// #8 StateProvider implementations:
export { InMemoryStateProvider } from "./providers/in-memory.js";
export type {
  InMemoryEntry,
  InMemoryStateProviderOptions,
} from "./providers/in-memory.js";
export { RpcStateProvider } from "./providers/rpc.js";
export type {
  LedgerEntriesServer,
  RpcStateProviderConfig,
} from "./providers/rpc.js";
//
// #9 IndexedDB cache:
export { CachingStateProvider } from "./cache/caching-provider.js";
export type {
  CacheContext,
  CachingStateProviderOptions,
} from "./cache/caching-provider.js";
export { CACHE_SCHEMA_VERSION, IndexedDbEntryCache } from "./cache/indexeddb.js";
export type {
  CacheAbsentRecord,
  CachePresentRecord,
  CacheRecord,
  IndexedDbEntryCacheOptions,
} from "./cache/indexeddb.js";

// Network sessions (#23 phase 4): the component's network-session resource,
// its base ledger, the IndexedDB log and the virtual RPC protocol.
export { networkSession } from "./generated/soroban-sim-component.js";
export {
  base64ToBytes,
  bytesToBase64,
  ledgerEntryXdr,
  RPC_KEYS_PER_CALL,
  RpcBaseLedger,
  StaticBaseLedger,
} from "./session/base.js";
export type { BaseBatch, BaseEntry, BaseLedger } from "./session/base.js";
export {
  forkConfigFromRpc,
  MAINNET_PASSPHRASE,
  MAINNET_RPC_URL,
  parseLedgerHeader,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
} from "./session/fork.js";
export type { ForkFromRpcOptions, LedgerHeaderFields } from "./session/fork.js";
export { PersistentSession } from "./session/persistent.js";
export type { ResumeSessionOptions, StartSessionOptions } from "./session/persistent.js";
export { READ_ONLY_RPC_METHODS, ReadOnlyRpc, RpcRequestError } from "./session/rpc.js";
export type { ReadOnlyRpcOptions, RpcLatestLedger, RpcLedgerEntry } from "./session/rpc.js";
export {
  bodyChangesSession,
  READ_ONLY_SESSION_METHODS,
  REFUSED_REAL_SIGNER,
  SessionRpcError,
  SorobanSession,
} from "./session/session.js";
export type {
  ComponentBaseBatch,
  ComponentSession,
  ForkConfig,
  LedgerOverride,
  NetworkSessionModule,
  Reply,
  SendResult,
  SessionClock,
  SessionReport,
  SessionReportResult,
  SessionStep,
  SessionSteps,
  SorobanSessionOptions,
  StepAuth,
  StepChange,
  StepDebugContext,
  TxReport,
} from "./session/session.js";
export {
  loadForkConfig,
  SESSION_DB_SCHEMA_VERSION,
  SessionStore,
  storeForkConfig,
} from "./session/store.js";
export type { SessionRecord, SessionStoreOptions, StoredForkConfig } from "./session/store.js";
export { throwawayKeypair } from "./session/throwaway.js";

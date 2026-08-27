/**
 * Simulation worker (Topology A). Owns the SorobanSimulator, the StateProvider,
 * all XDR decoding, and the rerun loop. Posts progress + results to the main
 * thread, which only renders.
 *
 * Two flows share this worker:
 *   - run-fixture -> result   (M0 golden path; frozen shape for the Playwright gate)
 *   - simulate    -> round* -> sim-result | sim-error   (the interactive demo)
 */
import {
  CachingStateProvider,
  IndexedDbEntryCache,
  InMemoryStateProvider,
  RpcStateProvider,
  runFixture,
  SorobanSimulator,
} from "@theahaco/soroban-sim";
import type {
  EntryResolution,
  LedgerContext,
  LedgerEntry,
  SimulateResult,
  StateProvider,
  TraceStep,
} from "@theahaco/soroban-sim";
import {
  Account,
  Address,
  BASE_FEE,
  contract,
  Operation,
  rpc,
  StrKey,
  type Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  authLabel,
  buildCallFrames,
  type CallFrame,
  contractEventLabel,
  footprintLabels,
  ledgerChangeLabel,
  ledgerKeyLabel,
  scValLabel,
} from "./decode.js";
import { decodeSsim, ssimRegions } from "./ssim.js";
import {
  fixtureById,
  type RawFixture,
  TESTNET_RPC_URL,
} from "./fixtures.js";
import type {
  DebugFrame,
  DebugMsg,
  DebugStep,
  LoadContractMsg,
  MainToWorker,
  RoundKey,
  StateChangeLabel,
  SimulateContractMsg,
  SimulateMsg,
  SimulateUploadMsg,
  SimulateXdrMsg,
  UploadArgInput,
  UploadFnInfo,
  UploadParseMsg,
  WorkerToMain,
} from "./protocol.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
/** The linked soroban-env-host runs protocol 27; the host rejects anything else. */
const HOST_PROTOCOL_VERSION = 27;
const DEFAULT_SIMULATION_SOURCE =
  "GALD63KYDPYZLJLY2VD722RI6HAW3RIKU5AROSPAXTL5JRDJB5NGOJIX";
const CONFIG_SETTING_IDS = [
  "configSettingContractComputeV0",
  "configSettingContractLedgerCostV0",
  "configSettingContractLedgerCostExtV0",
  "configSettingContractHistoricalDataV0",
  "configSettingContractEventsV0",
  "configSettingContractBandwidthV0",
  "configSettingStateArchival",
  "configSettingContractCostParamsCpuInstructions",
  "configSettingContractCostParamsMemoryBytes",
  "configSettingLiveSorobanStateSizeWindow",
] as const;

function post(msg: WorkerToMain): void {
  self.postMessage(msg);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function hexToBytes(hexStr: string): Uint8Array {
  const out = new Uint8Array(hexStr.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hexStr.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

/**
 * Access a js-xdr arm field that this SDK build exposes as either a method or a
 * bare property (v17 decodes unions to plain structs).
 */
function xf(obj: unknown, name: string): unknown {
  const rec = obj as Record<string, unknown>;
  const v = rec?.[name];
  return typeof v === "function" ? (v as () => unknown).call(obj) : v;
}

function xdrBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  const raw = (value as { value?: unknown })?.value;
  if (raw instanceof Uint8Array) return raw;
  const encoded = (value as { toXdr?: () => Uint8Array })?.toXdr?.();
  return encoded ? new Uint8Array(encoded) : new Uint8Array();
}

/** A present ledger entry the run resolved, kept for the debug trace rerun. */
interface AccumulatedEntry {
  keyXdr: Uint8Array;
  entryXdr: Uint8Array;
  liveUntilLedger?: number;
}

/**
 * A StateProvider decorator that decodes each resolved batch and streams a
 * `round` message per resolution. This is the "provider tap" that turns the
 * loop's needs-state/resolve cadence into the visible timeline — it never alters
 * what the loop sees (it forwards the inner resolutions verbatim).
 */
class RecordingProvider implements StateProvider {
  private round = 0;
  private cumulativeKeys = 0;
  present = 0;
  absent = 0;
  /** Accumulated present entries (key + entry XDR) for the debug trace rerun. */
  readonly entries: AccumulatedEntry[] = [];
  constructor(
    private readonly inner: StateProvider,
    private readonly id: number,
  ) {}

  async resolve(keyXdrs: Uint8Array[]): Promise<EntryResolution[]> {
    const startedAt = performance.now();
    const resolutions = await this.inner.resolve(keyXdrs);
    const roundMs = performance.now() - startedAt;
    this.round += 1;
    this.cumulativeKeys += keyXdrs.length;

    const keys: RoundKey[] = keyXdrs.map((keyXdr, i) => {
      const { kind, detail, label, role, key: decodedKey } = ledgerKeyLabel(keyXdr);
      const res = resolutions[i]!;
      if (res.status === "present") {
        this.present += 1;
        this.entries.push({
          keyXdr,
          entryXdr: res.entry.entryXdr,
          liveUntilLedger: res.entry.liveUntilLedger,
        });
      } else {
        this.absent += 1;
      }
      const key: RoundKey = {
        label,
        kind,
        detail,
        status: res.status,
      };
      if (role !== undefined) key.role = role;
      if (decodedKey !== undefined) key.key = decodedKey;
      if (res.status === "present" && res.entry.liveUntilLedger !== undefined) {
        key.ttl = res.entry.liveUntilLedger;
      }
      return key;
    });

    post({
      type: "round",
      id: this.id,
      roundIndex: this.round,
      rerunCount: this.round,
      requestedKeyCount: this.cumulativeKeys,
      keys,
      roundMs,
    });
    return resolutions;
  }
}

/** Build the present-entry resolution map from a fixture's committed snapshot. */
function fixtureEntryMap(fixture: RawFixture): Map<string, EntryResolution> {
  const entries = new Map<string, EntryResolution>();
  for (const e of fixture.snapshot) {
    const resolution: EntryResolution = {
      status: "present",
      entry: {
        entryXdr: b64ToBytes(e.entryXdr),
        ...(e.liveUntilLedger !== null
          ? { liveUntilLedger: e.liveUntilLedger }
          : {}),
      },
    };
    entries.set(bytesToHex(b64ToBytes(e.keyXdr)), resolution);
  }
  return entries;
}

/** Build the in-memory provider from a fixture's committed snapshot. */
function offlineProvider(fixture: RawFixture): StateProvider {
  // unmappedPolicy "absent": any key outside the snapshot resolves absent
  // honestly, so the loop's known-absent path is exercised too.
  return new InMemoryStateProvider(fixtureEntryMap(fixture), {
    unmappedPolicy: "absent",
  });
}

/** Build the live testnet provider (optionally IndexedDB-cached). */
async function liveProvider(
  fixture: RawFixture,
  networkId: Uint8Array,
  ledgerSeq: number,
  useCache: boolean,
): Promise<StateProvider> {
  const inner = new RpcStateProvider({
    rpcUrl: TESTNET_RPC_URL,
    networkPassphrase: fixture.networkPassphrase,
  });
  if (!useCache) return inner;
  const db = await IndexedDbEntryCache.open({ dbName: "soroban-sim-demo" });
  return new CachingStateProvider({
    inner,
    db,
    context: { networkId, ledgerSeq },
  });
}

/**
 * Best-effort refresh of the ledger sequence/timestamp so live archival checks
 * evaluate against current testnet state. Falls back to the captured context.
 */
async function liveLedgerHead(
  fixture: RawFixture,
): Promise<{ sequenceNumber: number; timestamp: number }> {
  const fallback = {
    sequenceNumber: fixture.ledgerContext.sequenceNumber,
    timestamp: fixture.ledgerContext.timestamp,
  };
  try {
    const server = new rpc.Server(TESTNET_RPC_URL);
    const latest = await server.getLatestLedger();
    return { sequenceNumber: latest.sequence, timestamp: fallback.timestamp };
  } catch {
    return fallback;
  }
}

function rpcResolution(result: rpc.Api.LedgerEntryResult): EntryResolution {
  const entry = new xdr.LedgerEntry({
    lastModifiedLedgerSeq: result.lastModifiedLedgerSeq ?? 0,
    data: result.val,
    ext: xdr.LedgerEntryExt.v0(),
  });
  return {
    status: "present",
    entry: {
      entryXdr: new Uint8Array(entry.toXdr()),
      ...(result.liveUntilLedgerSeq !== undefined
        ? { liveUntilLedger: result.liveUntilLedgerSeq }
        : {}),
    },
  };
}

/**
 * RPC-backed state pinned to one Testnet ledger. If Testnet closes a new ledger
 * while a run is resolving entries, fail instead of silently mixing snapshots.
 */
class PinnedRpcProvider implements StateProvider {
  constructor(
    private readonly server: rpc.Server,
    readonly ledgerSequence: number,
    private readonly cache: Map<string, EntryResolution>,
  ) {}

  async resolve(keyXdrs: Uint8Array[]): Promise<EntryResolution[]> {
    const keys = keyXdrs.map((bytes) => xdr.LedgerKey.fromXdr(bytes));
    const missing = keys.filter((key) => !this.cache.has(key.toXdr("base64")));
    if (missing.length > 0) {
      const response = await this.server.getLedgerEntries(...missing);
      if (response.latestLedger !== this.ledgerSequence) {
        throw new Error(
          `Testnet advanced from ledger ${this.ledgerSequence} to ${response.latestLedger} while resolving state; rerun for a coherent snapshot`,
        );
      }
      const found = new Map(
        response.entries.map((entry) => [entry.key.toXdr("base64"), entry]),
      );
      for (const key of missing) {
        const canonical = key.toXdr("base64");
        const result = found.get(canonical);
        this.cache.set(
          canonical,
          result ? rpcResolution(result) : { status: "absent" },
        );
      }
    }
    return keys.map(
      (key) => this.cache.get(key.toXdr("base64")) ?? { status: "absent" },
    );
  }
}

interface TestnetSnapshot {
  ledgerContext: LedgerContext;
  provider: StateProvider;
  ledgerSequence: number;
}

/**
 * Fetch network configuration first, then pin the freshest ledger head for all
 * contract/account reads. Configuration changes only at protocol boundaries;
 * the exact protocol check below prevents crossing one with stale settings.
 */
async function testnetSnapshot(): Promise<TestnetSnapshot> {
  const server = new rpc.Server(TESTNET_RPC_URL);
  const configKeys = CONFIG_SETTING_IDS.map((name) =>
    xdr.LedgerKey.configSetting(
      new xdr.LedgerKeyConfigSetting({
        configSettingId: xdr.ConfigSettingId[name],
      }),
    ),
  );

  const config = await server.getLedgerEntries(...configKeys);
  const latest = await server.getLatestLedger();
  const protocolVersion = Number(latest.protocolVersion);
  if (protocolVersion !== HOST_PROTOCOL_VERSION) {
    throw new Error(
      `this browser host supports protocol ${HOST_PROTOCOL_VERSION}, but Testnet is on protocol ${protocolVersion}; exact protocol parity is required for preflight`,
    );
  }

  const cache = new Map<string, EntryResolution>();
  for (const result of config.entries) {
    cache.set(result.key.toXdr("base64"), rpcResolution(result));
  }
  if (cache.size !== configKeys.length) {
    throw new Error(
      `Testnet returned ${cache.size}/${configKeys.length} required network settings`,
    );
  }

  const archival = config.entries.find(
    (entry) =>
      (entry.val as { type?: string; value?: { type?: string } }).value?.type ===
      "configSettingStateArchival",
  );
  const settings = (
    archival?.val as { value?: { value?: Record<string, number> } }
  )?.value?.value;
  if (!settings) throw new Error("Testnet StateArchival settings were unavailable");

  const networkId = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(NETWORK_PASSPHRASE),
    ),
  );
  return {
    ledgerSequence: latest.sequence,
    ledgerContext: {
      protocolVersion: HOST_PROTOCOL_VERSION,
      sequenceNumber: latest.sequence,
      timestamp: BigInt(latest.closeTime),
      networkId,
      baseReserve: latest.headerXdr.baseReserve,
      minTempEntryTtl: settings.minTemporaryTtl!,
      minPersistentEntryTtl: settings.minPersistentTtl!,
      maxEntryTtl: settings.maxEntryTtl!,
    },
    provider: new PinnedRpcProvider(server, latest.sequence, cache),
  };
}

// ---- visual debugger ------------------------------------------------------

/** Everything needed to replay a completed run under the tracing entry point. */
interface DebugContext {
  networkPassphrase: string;
  ledgerContext: LedgerContext;
  hostFunctionXdr: Uint8Array;
  sourceAccountXdr: Uint8Array;
  /** All present entries the run resolved, in resolution order. */
  entries: AccumulatedEntry[];
}
/** Only the most recent completed run stays debuggable. */
const debugContexts = new Map<number, DebugContext>();
function stashDebugContext(id: number, ctx: DebugContext): void {
  debugContexts.clear();
  debugContexts.set(id, ctx);
}

/**
 * Extract the InvokeHostFunction op's HostFunction and the source AccountId
 * from a v1 transaction envelope — the shape the tracing entry point needs.
 */
function invokeFromEnvelope(txXdr: Uint8Array): {
  hostFunctionXdr: Uint8Array;
  sourceAccountXdr: Uint8Array;
  sourceAccount: string;
  operationCount: number;
} {
  const env = xdr.TransactionEnvelope.fromXdr(txXdr as unknown as Buffer);
  const v1 = xf(env, "v1");
  if (!v1) throw new Error("only v1 transaction envelopes are debuggable");
  const tx = xf(v1, "tx");
  const ed = xf(xf(tx, "sourceAccount"), "ed25519");
  if (!ed) throw new Error("only ed25519 source accounts are debuggable");
  const edBytes = xdrBytes(ed);
  if (edBytes.length !== 32) throw new Error("source account key is not 32 bytes");
  const accountId = xdr.AccountId.publicKeyTypeEd25519(
    edBytes as Parameters<typeof xdr.AccountId.publicKeyTypeEd25519>[0],
  );
  const ops = (xf(tx, "operations") as unknown[]) ?? [];
  for (const op of ops) {
    const body = xf(op, "body");
    const ihf = xf(body, "invokeHostFunctionOp");
    if (!ihf) continue;
    const hf = xf(ihf, "hostFunction") as { toXdr: () => Uint8Array };
    return {
      hostFunctionXdr: new Uint8Array(hf.toXdr()),
      sourceAccountXdr: new Uint8Array(accountId.toXdr()),
      sourceAccount: StrKey.encodeEd25519PublicKey(edBytes as unknown as Buffer),
      operationCount: ops.length,
    };
  }
  throw new Error("no InvokeHostFunction operation in the envelope");
}

const STORAGE_ENV_CALL = /contract_data|storage/i;

/**
 * Correlate the semantic trace (Tier 2) with the diagnostic call tree (Tier 1).
 * Both streams are strictly nested: trace push-ctx/pop-ctx pairs bracket every
 * frame (host-fn frames like `InvokeContract:` plus one `VM:<id>:<fn>` frame
 * per contract invocation), while fn_call/fn_return diagnostics fire only for
 * contract frames. Binding walks both preorders and matches a diag frame to the
 * next push-ctx whose label ends with `:<fn>` — unmatched frames keep -1 and the
 * UI simply skips highlighting them.
 */
function correlateTrace(
  trace: TraceStep[],
  callFrames: CallFrame[],
): { steps: DebugStep[]; frames: DebugFrame[] } {
  // 1. matching pop-ctx for every push-ctx (the step-over target)
  const matchPop = new Array<number>(trace.length).fill(-1);
  {
    const stack: number[] = [];
    trace.forEach((s, i) => {
      if (s.kind === "push-ctx") stack.push(i);
      else if (s.kind === "pop-ctx") {
        const j = stack.pop();
        if (j !== undefined) matchPop[j] = i;
      }
    });
  }

  // 2. bind diag frames (preorder) to contract push-ctx steps (preorder)
  const frames: DebugFrame[] = callFrames.map((f) => ({
    parent: f.parent,
    depth: f.depth,
    ...(f.contract !== undefined ? { contract: f.contract } : {}),
    fn: f.fn,
    args: f.args,
    ...(f.ret !== undefined ? { ret: f.ret } : {}),
    pushSeq: -1,
    popSeq: -1,
  }));
  let cursor = 0;
  for (let i = 0; i < trace.length && cursor < frames.length; i += 1) {
    const s = trace[i]!;
    if (s.kind !== "push-ctx") continue;
    const f = frames[cursor]!;
    if (s.name === f.fn || s.name.endsWith(`:${f.fn}`)) {
      f.pushSeq = i;
      f.popSeq = matchPop[i]!;
      cursor += 1;
    }
  }

  // 3. per-step innermost bound frame
  const frameByPush = new Map<number, number>();
  frames.forEach((f, idx) => {
    if (f.pushSeq >= 0) frameByPush.set(f.pushSeq, idx);
  });
  const stepFrame = new Array<number>(trace.length).fill(-1);
  {
    const stack: number[] = [];
    for (let i = 0; i < trace.length; i += 1) {
      const bound = frameByPush.get(i);
      if (bound !== undefined) stack.push(bound);
      stepFrame[i] = stack.length > 0 ? stack[stack.length - 1]! : -1;
      // the pop-ctx step still belongs to the frame it closes; pop after
      if (stack.length > 0 && frames[stack[stack.length - 1]!]!.popSeq === i) {
        stack.pop();
      }
    }
  }

  const steps: DebugStep[] = trace.map((s, i) => {
    const prev = i > 0 ? trace[i - 1]! : undefined;
    return {
      seq: s.seq,
      kind: s.kind,
      name: s.name,
      display: s.display,
      cpu: Number(s.cpu),
      mem: Number(s.mem),
      dCpu: Number(prev ? s.cpu - prev.cpu : s.cpu),
      dMem: Number(prev ? s.mem - prev.mem : s.mem),
      storage: s.kind === "env-call" && STORAGE_ENV_CALL.test(s.name),
      frame: stepFrame[i]!,
      matchPop: matchPop[i]!,
    };
  });
  return { steps, frames };
}

async function handleDebug(msg: DebugMsg): Promise<void> {
  const started = performance.now();
  try {
    const ctx = debugContexts.get(msg.id);
    if (!ctx) {
      throw new Error("this run is no longer debuggable — run it again first");
    }
    // Everything the run needed is accumulated; seed it all so the trace pass
    // replays without touching the network. Any residual absent keys resolve
    // instantly from the in-memory provider's absent policy.
    const map = new Map<string, EntryResolution>();
    for (const e of ctx.entries) {
      map.set(bytesToHex(e.keyXdr), {
        status: "present",
        entry: {
          entryXdr: e.entryXdr,
          ...(e.liveUntilLedger !== undefined
            ? { liveUntilLedger: e.liveUntilLedger }
            : {}),
        },
      });
    }
    const provider = new InMemoryStateProvider(map, {
      unmappedPolicy: "absent",
    });
    const sim = await SorobanSimulator.create({
      networkPassphrase: ctx.networkPassphrase,
      provider,
    });
    const traced = await sim.simulateTrace({
      hostFunctionXdr: ctx.hostFunctionXdr,
      sourceAccountXdr: ctx.sourceAccountXdr,
      ledgerContext: ctx.ledgerContext,
      seedEntries: ctx.entries.map((e) => ({
        entryXdr: e.entryXdr,
        ...(e.liveUntilLedger !== undefined
          ? { liveUntilLedger: e.liveUntilLedger }
          : {}),
      })),
      basePrngSeed: new Uint8Array(32),
      enableDiagnostics: true,
    });
    const decoded = decodeSsim(traced.resultXdr);
    const callFrames = buildCallFrames(decoded.diagnosticEvents);
    const { steps, frames } = correlateTrace(traced.trace, callFrames);
    const last = steps.length > 0 ? steps[steps.length - 1]! : undefined;
    post({
      type: "debug-result",
      id: msg.id,
      ...(traced.traceUnavailableReason !== undefined
        ? { reason: traced.traceUnavailableReason }
        : {}),
      steps,
      frames,
      totalCpu: last ? last.cpu : decoded.simulatedInstructions,
      totalMem: last ? last.mem : decoded.simulatedMemory,
      elapsedMs: performance.now() - started,
    });
  } catch (error) {
    post({
      type: "debug-error",
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const controllers = new Map<number, AbortController>();

async function handleSimulate(msg: SimulateMsg): Promise<void> {
  const started = performance.now();
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  try {
    const fixture = fixtureById(msg.fixtureId).raw;
    const ctx = fixture.ledgerContext;
    const networkId = hexToBytes(ctx.networkId);

    let sequenceNumber = ctx.sequenceNumber;
    let timestamp = ctx.timestamp;
    let provider: StateProvider;

    if (msg.mode === "live") {
      const head = await liveLedgerHead(fixture);
      sequenceNumber = head.sequenceNumber;
      timestamp = head.timestamp;
      provider = await liveProvider(
        fixture,
        networkId,
        sequenceNumber,
        msg.cache,
      );
    } else {
      provider = offlineProvider(fixture);
    }

    const ledgerContext: LedgerContext = {
      protocolVersion: HOST_PROTOCOL_VERSION,
      sequenceNumber,
      timestamp: BigInt(timestamp),
      networkId,
      baseReserve: ctx.baseReserve,
      minTempEntryTtl: ctx.minTempEntryTtl,
      minPersistentEntryTtl: ctx.minPersistentEntryTtl,
      maxEntryTtl: ctx.maxEntryTtl,
    };

    const recording = new RecordingProvider(provider, msg.id);
    const sim = await SorobanSimulator.create({
      networkPassphrase: fixture.networkPassphrase,
      provider: recording,
    });

    const result = await sim.simulateTransaction(
      {
        transactionXdr: b64ToBytes(fixture.txXdr),
        ledgerContext,
        basePrngSeed: new Uint8Array(32),
        enableDiagnostics: false,
        applyRpcAdjustments: false,
      },
      { signal: controller.signal },
    );

    // Make the completed run debuggable: the tracing entry point takes the
    // bare host function + source account, so extract them from the envelope.
    let debuggable = false;
    try {
      const { hostFunctionXdr, sourceAccountXdr } = invokeFromEnvelope(
        b64ToBytes(fixture.txXdr),
      );
      stashDebugContext(msg.id, {
        networkPassphrase: fixture.networkPassphrase,
        ledgerContext,
        hostFunctionXdr,
        sourceAccountXdr,
        entries: recording.entries,
      });
      debuggable = true;
    } catch {
      debuggable = false;
    }

    await postSimResult(msg.id, result, recording, started, debuggable, {
      requestKind: "fixture",
    });
  } catch (error) {
    post({
      type: "sim-error",
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    controllers.delete(msg.id);
  }
}

/**
 * Decode a completed run's SSIM envelope into the display-ready `sim-result`
 * message. Shared by the fixture flow and the uploaded-contract flow.
 */
interface RunMeta {
  requestKind: "fixture" | "upload" | "contract" | "xdr";
  ledgerSequence?: number;
  sourceAccount?: string;
  operationCount?: number;
  /** Initial exact envelope, before local transaction data + auth are applied. */
  rawTransaction?: Transaction;
}

function assemblePreparedTransaction(
  raw: Transaction,
  transactionData: Uint8Array,
  authEntries: Uint8Array[],
): string {
  const operation = raw.operations[0];
  if (!operation || operation.type !== "invokeHostFunction") {
    throw new Error("only a single contract invocation can be prepared");
  }
  const sorobanData = xdr.SorobanTransactionData.fromXdr(
    transactionData as unknown as Buffer,
  );
  const auth = authEntries.map((entry) =>
    xdr.SorobanAuthorizationEntry.fromXdr(entry as unknown as Buffer),
  );
  const builder = TransactionBuilder.cloneFrom(raw, {
    fee: raw.fee,
    networkPassphrase: NETWORK_PASSPHRASE,
    sorobanData,
  });
  builder.clearOperations();
  builder.addOperation(
    Operation.invokeHostFunction({
      source: operation.source,
      func: operation.func,
      auth,
    }),
  );
  return builder.build().toEnvelope().toXdr("base64");
}

async function postSimResult(
  id: number,
  result: SimulateResult,
  recording: RecordingProvider,
  started: number,
  debuggable: boolean,
  meta: RunMeta,
): Promise<void> {
  {
    const decoded = decodeSsim(result.resultXdr);
    const sha256 = await sha256Hex(result.resultXdr);
    const scv =
      decoded.result.ok && decoded.result.scValXdr.length > 0
        ? scValLabel(decoded.result.scValXdr)
        : { type: "Void", display: "void" };

    // Turn the decoded XDR slices into display-ready state, all worker-side.
    // Each label helper is internally guarded (returns undefined / a "—" marker
    // on failure) so a display glitch never aborts the interactive run.
    const footprint = decoded.transactionData
      ? footprintLabels(decoded.transactionData)
      : undefined;
    const contractEvents = decoded.contractEvents.map((e) => contractEventLabel(e));
    const auth = decoded.auth.map((a) => authLabel(a));
    const preparedTransactionXdr =
      meta.rawTransaction && decoded.transactionData && decoded.result.ok
        ? assemblePreparedTransaction(
            meta.rawTransaction,
            decoded.transactionData,
            decoded.auth,
          )
        : undefined;
    let stateChanges: StateChangeLabel[] = decoded.modifiedEntries.map((change) =>
      ledgerChangeLabel(change.before, change.after),
    );
    if (meta.requestKind === "contract") {
      stateChanges = stateChanges.map((change) => {
        const restoration =
          change.kind === "ContractCode" ||
          (change.kind === "ContractData" && change.after === "contract instance");
        return restoration
          ? {
              ...change,
              change: "restored" as const,
              category: "maintenance" as const,
              before: "archived",
            }
          : { ...change, category: "contract" as const };
      });
    } else if (meta.requestKind === "xdr") {
      stateChanges = stateChanges.map((change) => ({
        ...change,
        category: "transaction" as const,
      }));
    }

    // Byte map of the SSIM envelope so the "everything is bytes" story is
    // tangible. The hex is only shipped for small envelopes (these fixtures are
    // a few hundred bytes to a few KB); the region map is always cheap.
    const regions = ssimRegions(result.resultXdr);
    let resultHex: string | undefined;
    if (result.resultXdr.length <= 4096) {
      let h = "";
      for (const b of result.resultXdr) h += b.toString(16).padStart(2, "0");
      resultHex = h;
    }

    post({
      type: "sim-result",
      id,
      rounds: result.rounds,
      requestedKeyCount: result.requestedKeyCount,
      elapsedMs: performance.now() - started,
      resultLen: result.resultXdr.length,
      sha256,
      scValType: scv.type,
      scValDisplay: scv.display,
      ok: decoded.result.ok,
      errorText: decoded.result.ok ? undefined : decoded.result.error,
      present: recording.present,
      absent: recording.absent,
      instructions: decoded.simulatedInstructions,
      memoryBytes: decoded.simulatedMemory,
      hasTxData: decoded.transactionData !== undefined,
      readOnly: footprint?.readOnly,
      readWrite: footprint?.readWrite,
      resources: footprint
        ? {
            instructions: footprint.instructions,
            readBytes: footprint.readBytes,
            writeBytes: footprint.writeBytes,
            resourceFee: footprint.resourceFee,
          }
        : undefined,
      contractEvents: contractEvents.length > 0 ? contractEvents : undefined,
      auth: auth.length > 0 ? auth : undefined,
      diagnosticEventCount: decoded.diagnosticEvents.length,
      modifiedCount: decoded.modifiedEntries.length,
      stateChanges: stateChanges.length > 0 ? stateChanges : undefined,
      requestKind: meta.requestKind,
      ledgerSequence: meta.ledgerSequence,
      sourceAccount: meta.sourceAccount,
      operationCount: meta.operationCount,
      preparedTransactionXdr,
      regions,
      resultHex,
      debuggable: debuggable && decoded.result.ok,
    });
  }
}

// ---- upload-any-contract --------------------------------------------------

/** The offline fixture whose snapshot seeds every uploaded-contract run: it
 * carries the full ConfigSetting set the host needs plus a source account. */
const UPLOAD_BASE_FIXTURE = "add_i32";

interface UploadState {
  bytes: Uint8Array;
  spec?: InstanceType<typeof contract.Spec>;
  fns: UploadFnInfo[];
  ladder: "spec" | "names" | "raw";
  contractId: string;
  codeHash: Uint8Array;
}
let upload: UploadState | undefined;

/** Map a decoded ScSpec type to the arg-input widget class. */
function specTypeToInput(typeName: string): UploadArgInput {
  switch (typeName) {
    case "scSpecTypeU32":
      return "u32";
    case "scSpecTypeI32":
      return "i32";
    case "scSpecTypeU64":
      return "u64";
    case "scSpecTypeI64":
      return "i64";
    case "scSpecTypeBool":
      return "bool";
    case "scSpecTypeString":
      return "string";
    case "scSpecTypeSymbol":
      return "symbol";
    case "scSpecTypeAddress":
      return "address";
    default:
      return "xdr";
  }
}

async function handleUploadParse(msg: UploadParseMsg): Promise<void> {
  try {
    const bytes = msg.bytes;
    const codeHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
    );
    // Deterministic demo contract id: any 32 bytes works offline; deriving it
    // from the code hash keeps re-uploads of the same file stable.
    const tag = new TextEncoder().encode("soroban-sim-upload:");
    const preimage = new Uint8Array(tag.length + codeHash.length);
    preimage.set(tag, 0);
    preimage.set(codeHash, tag.length);
    const cid = new Uint8Array(
      await crypto.subtle.digest("SHA-256", preimage.slice().buffer),
    );
    const contractId = StrKey.encodeContract(cid as unknown as Buffer);

    // Labeling ladder: spec (typed args) -> export names -> raw XDR floor.
    let ladder: UploadState["ladder"] = "raw";
    let fns: UploadFnInfo[] = [];
    let spec: UploadState["spec"];
    try {
      const parsed = contract.Spec.fromWasm(bytes);
      const funcs = parsed.funcs();
      if (funcs.length > 0) {
        ladder = "spec";
        spec = parsed;
        fns = funcs.map((f) => ({
          name: String(xf(f, "name")),
          args: ((xf(f, "inputs") as unknown[]) ?? []).map((inp) => {
            const t = xf(inp, "type");
            const typeName =
              (t as { type?: string })?.type ?? (t != null ? String(t) : "unknown");
            return {
              name: String(xf(inp, "name")),
              type: typeName,
              input: specTypeToInput(typeName),
            };
          }),
        }));
      }
    } catch {
      spec = undefined;
    }
    if (ladder !== "spec") {
      try {
        const mod = await WebAssembly.compile(
          bytes.slice().buffer as ArrayBuffer,
        );
        const names = WebAssembly.Module.exports(mod)
          .filter((e) => e.kind === "function")
          .map((e) => e.name)
          .filter((n) => !n.startsWith("_"));
        if (names.length > 0) {
          ladder = "names";
          fns = names.map((n) => ({ name: n, args: [] }));
        }
      } catch {
        // not even a valid module — leave the raw floor
      }
    }

    upload = { bytes, spec, fns, ladder, contractId, codeHash };
    post({
      type: "upload-info",
      id: msg.id,
      ok: true,
      fileName: msg.fileName,
      size: bytes.length,
      contractId,
      codeHash: bytesToHex(codeHash),
      ladder,
      fns,
    });
  } catch (error) {
    post({
      type: "upload-info",
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      fileName: msg.fileName,
      size: msg.bytes.length,
      contractId: "",
      codeHash: "",
      ladder: "raw",
      fns: [],
    });
  }
}

interface CallableState {
  spec?: InstanceType<typeof contract.Spec>;
  fns: UploadFnInfo[];
  ladder: "spec" | "names" | "raw";
}

/** Convert raw arg strings into ScVals via a discovered spec (or b64 XDR). */
function buildContractArgs(
  fn: string,
  args: string[],
  raw: boolean,
  state: CallableState,
): unknown[] {
  if (raw || state.ladder !== "spec") {
    return args
      .map((a) => a.trim())
      .filter((a) => a.length > 0)
      .map((a, i) => {
        try {
          return xdr.ScVal.fromXdr(b64ToBytes(a) as unknown as Buffer);
        } catch (e) {
          throw new Error(
            `arg ${i + 1}: not valid base64 ScVal XDR (${(e as Error).message})`,
          );
        }
      });
  }
  const fnInfo = state.fns.find((f) => f.name === fn);
  if (!fnInfo) throw new Error(`unknown function ${fn}`);
  if (args.length !== fnInfo.args.length) {
    throw new Error(
      `${fn} takes ${fnInfo.args.length} argument(s), got ${args.length}`,
    );
  }
  const specFn = state
    .spec!.funcs()
    .find((f) => String(xf(f, "name")) === fn);
  const inputs = specFn ? ((xf(specFn, "inputs") as unknown[]) ?? []) : [];
  return fnInfo.args.map((arg, i) => {
    const rawArg = args[i]!;
    const label = `${arg.name} (${arg.input})`;
    try {
      if (arg.input === "xdr") {
        return xdr.ScVal.fromXdr(
          b64ToBytes(rawArg.trim()) as unknown as Buffer,
        );
      }
      let native: unknown;
      switch (arg.input) {
        case "u32":
        case "i32": {
          const n = Number(rawArg.trim());
          if (!Number.isInteger(n)) throw new Error("not an integer");
          native = n;
          break;
        }
        case "u64":
        case "i64":
          native = BigInt(rawArg.trim());
          break;
        case "bool":
          native = rawArg.trim() === "true";
          break;
        case "address":
          native = rawArg.trim();
          break;
        default:
          native = rawArg;
      }
      const typeDef = inputs[i] !== undefined ? xf(inputs[i], "type") : undefined;
      return state.spec!.nativeToScVal(
        native,
        typeDef as Parameters<InstanceType<typeof contract.Spec>["nativeToScVal"]>[1],
      );
    } catch (e) {
      throw new Error(`argument ${label}: ${(e as Error).message}`);
    }
  });
}

async function handleSimulateUpload(msg: SimulateUploadMsg): Promise<void> {
  const started = performance.now();
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  try {
    const state = upload;
    if (!state) throw new Error("no uploaded contract — upload a .wasm first");
    if (!msg.fn.trim()) throw new Error("enter a function name to invoke");

    const fixture = fixtureById(UPLOAD_BASE_FIXTURE).raw;
    const ctx = fixture.ledgerContext;
    const ledgerContext: LedgerContext = {
      protocolVersion: HOST_PROTOCOL_VERSION,
      sequenceNumber: ctx.sequenceNumber,
      timestamp: BigInt(ctx.timestamp),
      networkId: hexToBytes(ctx.networkId),
      baseReserve: ctx.baseReserve,
      minTempEntryTtl: ctx.minTempEntryTtl,
      minPersistentEntryTtl: ctx.minPersistentEntryTtl,
      maxEntryTtl: ctx.maxEntryTtl,
    };

    // Seed the ledger with the uploaded code + a fresh contract instance that
    // points at it, on top of the fixture snapshot (ConfigSettings etc.).
    const scaddr = new Address(state.contractId).toScAddress();
    const codeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({
        hash: state.codeHash as unknown as Buffer,
      }),
    );
    const codeEntry = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 0,
      data: xdr.LedgerEntryData.contractCode(
        new xdr.ContractCodeEntry({
          ext: xdr.ContractCodeEntryExt.v0(),
          hash: state.codeHash as unknown as Buffer,
          code: state.bytes as unknown as Buffer,
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    });
    const instKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scaddr,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.fromName("persistent"),
      }),
    );
    const instEntry = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 0,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.v0(),
          contract: scaddr,
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.fromName("persistent"),
          val: xdr.ScVal.scvContractInstance(
            new xdr.ScContractInstance({
              executable: xdr.ContractExecutable.contractExecutableWasm(
                state.codeHash as unknown as Buffer,
              ),
              storage: null,
            }),
          ),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    });

    const ttl = ctx.sequenceNumber + ctx.minPersistentEntryTtl;
    const map = fixtureEntryMap(fixture);
    for (const [key, entry] of [
      [codeKey, codeEntry],
      [instKey, instEntry],
    ] as const) {
      map.set(bytesToHex(new Uint8Array(key.toXdr())), {
        status: "present",
        entry: {
          entryXdr: new Uint8Array(entry.toXdr()),
          liveUntilLedger: ttl,
        },
      });
    }
    const provider = new InMemoryStateProvider(map, {
      unmappedPolicy: "absent",
    });
    const recording = new RecordingProvider(provider, msg.id);

    const scArgs = buildContractArgs(msg.fn, msg.args, msg.raw, state);
    const invokeArgs = new xdr.InvokeContractArgs({
      contractAddress: scaddr,
      functionName: msg.fn.trim(),
      args: scArgs as ConstructorParameters<
        typeof xdr.InvokeContractArgs
      >[0]["args"],
    });
    const hf = xdr.HostFunction.hostFunctionTypeInvokeContract(invokeArgs);
    const hostFunctionXdr = new Uint8Array(hf.toXdr());
    const { sourceAccountXdr } = invokeFromEnvelope(b64ToBytes(fixture.txXdr));

    const sim = await SorobanSimulator.create({
      networkPassphrase: fixture.networkPassphrase,
      provider: recording,
    });
    const result = await sim.simulate(
      {
        hostFunctionXdr,
        sourceAccountXdr,
        ledgerContext,
        basePrngSeed: new Uint8Array(32),
        enableDiagnostics: false,
        applyRpcAdjustments: false,
      },
      { signal: controller.signal },
    );

    stashDebugContext(msg.id, {
      networkPassphrase: fixture.networkPassphrase,
      ledgerContext,
      hostFunctionXdr,
      sourceAccountXdr,
      entries: recording.entries,
    });
    await postSimResult(msg.id, result, recording, started, true, {
      requestKind: "upload",
      sourceAccount: DEFAULT_SIMULATION_SOURCE,
      operationCount: 1,
    });
  } catch (error) {
    post({
      type: "sim-error",
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    controllers.delete(msg.id);
  }
}

// ---- deployed Testnet contract / transaction workbench -------------------

interface DeployedContractState extends CallableState {
  contractId: string;
  executable: "wasm" | "stellar-asset";
  codeHash?: Uint8Array;
}
let deployedContract: DeployedContractState | undefined;

function specFunctions(
  spec: InstanceType<typeof contract.Spec>,
): UploadFnInfo[] {
  return spec.funcs().map((fn) => ({
    name: String(xf(fn, "name")),
    args: ((xf(fn, "inputs") as unknown[]) ?? []).map((input) => {
      const typeDef = xf(input, "type");
      const typeName =
        (typeDef as { type?: string })?.type ??
        (typeDef != null ? String(typeDef) : "unknown");
      return {
        name: String(xf(input, "name")),
        type: typeName,
        input: specTypeToInput(typeName),
      };
    }),
  }));
}

async function handleLoadContract(msg: LoadContractMsg): Promise<void> {
  try {
    let address: Address;
    try {
      address = Address.fromString(msg.contractId.trim());
    } catch {
      throw new Error("enter a valid C… contract address");
    }
    if (address.type !== "contract") throw new Error("enter a C… contract address");
    const contractId = address.toString();
    const server = new rpc.Server(TESTNET_RPC_URL);
    const latest = await server.getLatestLedger();
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: address.toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.fromName("persistent"),
      }),
    );
    const instanceResponse = await server.getLedgerEntries(instanceKey);
    const instanceEntry = instanceResponse.entries[0];
    if (!instanceEntry) throw new Error("contract instance not found on Testnet");
    const instanceData = instanceEntry.val as {
      type?: string;
      value?: { val?: { type?: string; value?: { executable?: unknown } } };
    };
    const instance = instanceData.value?.val;
    if (instanceData.type !== "contractData" || instance?.type !== "scvContractInstance") {
      throw new Error("ledger entry is not a contract instance");
    }
    const executable = instance.value?.executable as {
      type?: string;
      wasmHash?: unknown;
    };

    let executableLabel: DeployedContractState["executable"];
    let codeHash: Uint8Array | undefined;
    let spec: InstanceType<typeof contract.Spec> | undefined;
    let fns: UploadFnInfo[] = [];
    let ladder: DeployedContractState["ladder"] = "raw";
    let ledgerSequence = instanceResponse.latestLedger;

    if (executable?.type === "contractExecutableWasm") {
      executableLabel = "wasm";
      codeHash = xdrBytes(executable.wasmHash);
      const codeKey = xdr.LedgerKey.contractCode(
        new xdr.LedgerKeyContractCode({
          hash: codeHash as unknown as Buffer,
        }),
      );
      const codeResponse = await server.getLedgerEntries(codeKey);
      const codeEntry = codeResponse.entries[0];
      if (!codeEntry) throw new Error("contract Wasm entry not found on Testnet");
      ledgerSequence = codeResponse.latestLedger;
      const codeData = codeEntry.val as {
        type?: string;
        value?: { code?: Uint8Array };
      };
      const wasm = codeData.value?.code;
      if (codeData.type !== "contractCode" || !wasm) {
        throw new Error("contract code entry did not contain Wasm");
      }
      try {
        spec = contract.Spec.fromWasm(wasm);
        fns = specFunctions(spec);
        if (fns.length > 0) ladder = "spec";
      } catch {
        spec = undefined;
      }
    } else if (executable?.type === "contractExecutableStellarAsset") {
      executableLabel = "stellar-asset";
    } else {
      throw new Error(`unsupported contract executable ${executable?.type ?? "unknown"}`);
    }

    deployedContract = {
      contractId,
      executable: executableLabel,
      ...(codeHash ? { codeHash } : {}),
      ...(spec ? { spec } : {}),
      fns,
      ladder,
    };
    post({
      type: "contract-info",
      id: msg.id,
      ok: true,
      contractId,
      executable: executableLabel,
      ...(codeHash ? { codeHash: bytesToHex(codeHash) } : {}),
      ledgerSequence,
      protocolVersion: Number(latest.protocolVersion),
      ladder: ladder === "spec" ? "spec" : "raw",
      fns,
    });
  } catch (error) {
    deployedContract = undefined;
    post({
      type: "contract-info",
      id: msg.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      contractId: msg.contractId.trim(),
      ladder: "raw",
      fns: [],
    });
  }
}

function defaultSourceAccountXdr(): Uint8Array {
  const raw = StrKey.decodeEd25519PublicKey(DEFAULT_SIMULATION_SOURCE);
  return new Uint8Array(
    xdr.AccountId.publicKeyTypeEd25519(raw as unknown as Buffer).toXdr(),
  );
}

async function handleSimulateContract(msg: SimulateContractMsg): Promise<void> {
  const started = performance.now();
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  try {
    const state = deployedContract;
    if (!state || state.contractId !== msg.contractId.trim()) {
      throw new Error("load this deployed contract before simulating it");
    }
    if (!msg.fn.trim()) throw new Error("choose a contract function");
    const snapshot = await testnetSnapshot();
    const recording = new RecordingProvider(snapshot.provider, msg.id);
    const args = buildContractArgs(msg.fn, msg.args, msg.raw, state);
    const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(state.contractId).toScAddress(),
        functionName: msg.fn.trim(),
        args: args as ConstructorParameters<
          typeof xdr.InvokeContractArgs
        >[0]["args"],
      }),
    );
    const hostFunctionXdr = new Uint8Array(hostFunction.toXdr());
    let sourceAccountXdr = defaultSourceAccountXdr();
    let rawTransaction: Transaction | undefined;
    if (msg.sourceAccount && msg.sourceAccountSequence !== undefined) {
      rawTransaction = new TransactionBuilder(
        new Account(msg.sourceAccount, msg.sourceAccountSequence),
        {
          fee: BASE_FEE,
          networkPassphrase: NETWORK_PASSPHRASE,
        },
      )
        .addOperation(Operation.invokeHostFunction({ func: hostFunction }))
        .setTimeout(300)
        .build();
      sourceAccountXdr = invokeFromEnvelope(
        new Uint8Array(rawTransaction.toEnvelope().toXdr()),
      ).sourceAccountXdr;
    }
    const sim = await SorobanSimulator.create({
      networkPassphrase: NETWORK_PASSPHRASE,
      provider: recording,
    });
    const result = rawTransaction
      ? await sim.simulateTransaction(
          {
            transactionXdr: new Uint8Array(rawTransaction.toEnvelope().toXdr()),
            ledgerContext: snapshot.ledgerContext,
            basePrngSeed: new Uint8Array(32),
            enableDiagnostics: false,
            applyRpcAdjustments: true,
          },
          { signal: controller.signal },
        )
      : await sim.simulate(
          {
            hostFunctionXdr,
            sourceAccountXdr,
            ledgerContext: snapshot.ledgerContext,
            basePrngSeed: new Uint8Array(32),
            enableDiagnostics: false,
            applyRpcAdjustments: true,
          },
          { signal: controller.signal },
        );
    stashDebugContext(msg.id, {
      networkPassphrase: NETWORK_PASSPHRASE,
      ledgerContext: snapshot.ledgerContext,
      hostFunctionXdr,
      sourceAccountXdr,
      entries: recording.entries,
    });
    await postSimResult(msg.id, result, recording, started, true, {
      requestKind: "contract",
      ledgerSequence: snapshot.ledgerSequence,
      sourceAccount: msg.sourceAccount ?? DEFAULT_SIMULATION_SOURCE,
      operationCount: 1,
      rawTransaction,
    });
  } catch (error) {
    post({
      type: "sim-error",
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    controllers.delete(msg.id);
  }
}

async function handleSimulateXdr(msg: SimulateXdrMsg): Promise<void> {
  const started = performance.now();
  const controller = new AbortController();
  controllers.set(msg.id, controller);
  try {
    const transactionXdr = b64ToBytes(msg.transactionXdr.trim());
    const invocation = invokeFromEnvelope(transactionXdr);
    const snapshot = await testnetSnapshot();
    const recording = new RecordingProvider(snapshot.provider, msg.id);
    const sim = await SorobanSimulator.create({
      networkPassphrase: NETWORK_PASSPHRASE,
      provider: recording,
    });
    const result = await sim.simulateTransaction(
      {
        transactionXdr,
        ledgerContext: snapshot.ledgerContext,
        basePrngSeed: new Uint8Array(32),
        enableDiagnostics: false,
        applyRpcAdjustments: true,
      },
      { signal: controller.signal },
    );
    stashDebugContext(msg.id, {
      networkPassphrase: NETWORK_PASSPHRASE,
      ledgerContext: snapshot.ledgerContext,
      hostFunctionXdr: invocation.hostFunctionXdr,
      sourceAccountXdr: invocation.sourceAccountXdr,
      entries: recording.entries,
    });
    await postSimResult(msg.id, result, recording, started, true, {
      requestKind: "xdr",
      ledgerSequence: snapshot.ledgerSequence,
      sourceAccount: invocation.sourceAccount,
      operationCount: invocation.operationCount,
    });
  } catch (error) {
    post({
      type: "sim-error",
      id: msg.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    controllers.delete(msg.id);
  }
}

// M0 golden path — FROZEN. The Playwright gate reads #result JSON for
// { len, sha256, elapsedMs } against the committed add_i32 golden.
async function handleRunFixture(): Promise<void> {
  const started = performance.now();
  const output = runFixture();
  const sha256 = await sha256Hex(output);
  post({
    type: "result",
    len: output.length,
    sha256,
    elapsedMs: performance.now() - started,
  });
}

post({ type: "ready" });

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  const msg = event.data;
  switch (msg?.type) {
    case "simulate":
      void handleSimulate(msg);
      return;
    case "cancel":
      controllers.get(msg.id)?.abort();
      return;
    case "debug":
      void handleDebug(msg);
      return;
    case "upload-parse":
      void handleUploadParse(msg);
      return;
    case "simulate-upload":
      void handleSimulateUpload(msg);
      return;
    case "load-contract":
      void handleLoadContract(msg);
      return;
    case "simulate-contract":
      void handleSimulateContract(msg);
      return;
    case "simulate-xdr":
      void handleSimulateXdr(msg);
      return;
    case "run-fixture":
    default:
      void handleRunFixture();
  }
};

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
  StateProvider,
} from "@theahaco/soroban-sim";
import { rpc } from "@stellar/stellar-sdk";
import {
  authLabel,
  contractEventLabel,
  footprintLabels,
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
  MainToWorker,
  RoundKey,
  SimulateMsg,
  WorkerToMain,
} from "./protocol.js";

const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
/** The linked soroban-env-host runs protocol 28; the host rejects anything else. */
const HOST_PROTOCOL_VERSION = 28;

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
      const { kind, detail, label } = ledgerKeyLabel(keyXdr);
      const res = resolutions[i]!;
      if (res.status === "present") this.present += 1;
      else this.absent += 1;
      const key: RoundKey = {
        label,
        kind,
        detail,
        status: res.status,
      };
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

/** Build the in-memory provider from a fixture's committed snapshot. */
function offlineProvider(fixture: RawFixture): StateProvider {
  const entries = new Map<string, EntryResolution>();
  for (const e of fixture.snapshot) {
    const keyBytes = b64ToBytes(e.keyXdr);
    let keyHex = "";
    for (const b of keyBytes) keyHex += b.toString(16).padStart(2, "0");
    const resolution: EntryResolution = {
      status: "present",
      entry: {
        entryXdr: b64ToBytes(e.entryXdr),
        ...(e.liveUntilLedger !== null
          ? { liveUntilLedger: e.liveUntilLedger }
          : {}),
      },
    };
    entries.set(keyHex, resolution);
  }
  // unmappedPolicy "absent": any key outside the snapshot resolves absent
  // honestly, so the loop's known-absent path is exercised too.
  return new InMemoryStateProvider(entries, { unmappedPolicy: "absent" });
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
      id: msg.id,
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
      regions,
      resultHex,
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
    case "run-fixture":
    default:
      void handleRunFixture();
  }
};

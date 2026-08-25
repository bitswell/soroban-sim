import { describe, expect, it, vi } from "vitest";
import type {
  LedgerContext,
  Outcome,
  Request,
  TraceOutcome,
  TransactionRequest,
} from "./generated/soroban-sim-component.js";
import type { EntryResolution, StateProvider } from "./state-provider.js";
import {
  type Component,
  type SimulateInput,
  type SimulateTransactionInput,
  SorobanSimulator,
} from "./simulator.js";

const CTX: LedgerContext = {
  protocolVersion: 22,
  sequenceNumber: 100,
  timestamp: 0n,
  networkId: new Uint8Array(32),
  baseReserve: 0,
  minTempEntryTtl: 16,
  minPersistentEntryTtl: 120960,
  maxEntryTtl: 3110400,
};

const INPUT: SimulateInput = {
  hostFunctionXdr: new Uint8Array([0xaa]),
  sourceAccountXdr: new Uint8Array([0xbb]),
  ledgerContext: CTX,
};

const keyHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** In-memory provider stub: hex(keyXdr) -> resolution; unknown keys -> absent. */
function inMemoryProvider(
  table: Record<string, EntryResolution>,
): StateProvider {
  return {
    resolve: (keys) =>
      Promise.resolve(keys.map((k) => table[keyHex(k)] ?? { status: "absent" })),
  };
}

/** Component whose simulate() replays a scripted sequence of outcomes. */
function scriptedComponent(
  script: (request: Request, call: number) => Outcome,
): Component & { calls: Request[] } {
  const calls: Request[] = [];
  return {
    calls,
    simulate(request: Request): Outcome {
      const snapshot: Request = {
        ...request,
        ledgerEntries: [...request.ledgerEntries],
        knownAbsentKeys: [...request.knownAbsentKeys],
      };
      calls.push(snapshot);
      return script(request, calls.length - 1);
    },
  };
}

const complete = (val: Uint8Array): Outcome => ({ tag: "complete", val });
const needs = (val: Uint8Array[]): Outcome => ({ tag: "needs-state", val });

describe("SorobanSimulator loop", () => {
  it("returns complete on the first round with no provider round-trips", async () => {
    const component = scriptedComponent(() => complete(new Uint8Array([1, 2, 3])));
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      component,
    });
    const result = await sim.simulate(INPUT);
    expect(result.resultXdr).toEqual(new Uint8Array([1, 2, 3]));
    expect(result.rounds).toBe(1);
    expect(result.requestedKeyCount).toBe(0);
    expect(component.calls).toHaveLength(1);
  });

  it("folds present entries and absent keys, then completes", async () => {
    const keyA = new Uint8Array([0x01]);
    const keyB = new Uint8Array([0x02]);
    const entryA = new Uint8Array([0xde, 0xad]);

    const component = scriptedComponent((_req, call) =>
      call === 0 ? needs([keyA, keyB]) : complete(new Uint8Array([0x42])),
    );
    const provider = inMemoryProvider({
      [keyHex(keyA)]: {
        status: "present",
        entry: { entryXdr: entryA, liveUntilLedger: 500 },
      },
      [keyHex(keyB)]: { status: "absent" },
    });
    const onProgress = vi.fn();

    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      provider,
      component,
    });
    const result = await sim.simulate(INPUT, { onProgress });

    expect(result.resultXdr).toEqual(new Uint8Array([0x42]));
    expect(result.rounds).toBe(2);
    expect(result.requestedKeyCount).toBe(2);

    // Second request must carry the resolved present entry and the absent key.
    const second = component.calls[1]!;
    expect(second.ledgerEntries).toEqual([
      { entryXdr: entryA, liveUntilLedger: 500 },
    ]);
    expect(second.knownAbsentKeys.map(keyHex)).toEqual([keyHex(keyB)]);

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress.mock.calls[0]![0]).toMatchObject({
      rerunCount: 1,
      requestedKeyCount: 2,
    });
  });

  it("throws a stall error when a key is re-requested after being attempted", async () => {
    const keyA = new Uint8Array([0x07]);
    // Always asks for keyA; after it is resolved absent, re-asking stalls.
    const component = scriptedComponent(() => needs([keyA]));
    const provider = inMemoryProvider({ [keyHex(keyA)]: { status: "absent" } });
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      provider,
      component,
    });
    await expect(sim.simulate(INPUT)).rejects.toThrow(/stalled/);
  });

  it("throws when needs-state occurs without a provider", async () => {
    const component = scriptedComponent(() => needs([new Uint8Array([9])]));
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      component,
    });
    await expect(sim.simulate(INPUT)).rejects.toThrow(/no StateProvider/);
  });

  it("enforces maxRounds", async () => {
    let n = 0;
    const component = scriptedComponent(() => needs([new Uint8Array([++n])]));
    const provider = inMemoryProvider({}); // everything absent -> new key each round
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      provider,
      component,
      limits: { maxRounds: 3 },
    });
    await expect(sim.simulate(INPUT)).rejects.toThrow(/maxRounds/);
  });

  it("aborts via AbortSignal", async () => {
    const controller = new AbortController();
    const component = scriptedComponent(() => {
      controller.abort();
      return needs([new Uint8Array([1])]);
    });
    const provider = inMemoryProvider({});
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      provider,
      component,
    });
    await expect(
      sim.simulate(INPUT, { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

const TX_INPUT: SimulateTransactionInput = {
  transactionXdr: new Uint8Array([0xcc]),
  ledgerContext: CTX,
};

/** Component whose simulate-transaction() replays a scripted sequence. */
function scriptedTxComponent(
  script: (request: TransactionRequest, call: number) => Outcome,
): Component & { txCalls: TransactionRequest[] } {
  const txCalls: TransactionRequest[] = [];
  return {
    txCalls,
    // simulate() is unused on this path but required by the interface.
    simulate(): Outcome {
      throw new Error("simulate() should not be called on the tx path");
    },
    simulateTransaction(request: TransactionRequest): Outcome {
      txCalls.push({
        ...request,
        ledgerEntries: [...request.ledgerEntries],
        knownAbsentKeys: [...request.knownAbsentKeys],
      });
      return script(request, txCalls.length - 1);
    },
  };
}

describe("SorobanSimulator.simulateTransaction loop", () => {
  it("drives the transaction export and returns complete", async () => {
    const component = scriptedTxComponent(() =>
      complete(new Uint8Array([0x2a])),
    );
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      component,
    });
    const result = await sim.simulateTransaction(TX_INPUT);
    expect(result.resultXdr).toEqual(new Uint8Array([0x2a]));
    expect(result.rounds).toBe(1);
    expect(component.txCalls).toHaveLength(1);
    expect(component.txCalls[0]!.transactionXdr).toEqual(
      new Uint8Array([0xcc]),
    );
  });

  it("reruns on needs-state, folding entries and absent keys", async () => {
    const keyA = new Uint8Array([0x01]);
    const keyB = new Uint8Array([0x02]);
    const entryA = new Uint8Array([0xde, 0xad]);
    const component = scriptedTxComponent((_req, call) =>
      call === 0 ? needs([keyA, keyB]) : complete(new Uint8Array([0x42])),
    );
    const provider = inMemoryProvider({
      [keyHex(keyA)]: {
        status: "present",
        entry: { entryXdr: entryA, liveUntilLedger: 500 },
      },
      [keyHex(keyB)]: { status: "absent" },
    });
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      provider,
      component,
    });
    const result = await sim.simulateTransaction(TX_INPUT);
    expect(result.resultXdr).toEqual(new Uint8Array([0x42]));
    expect(result.rounds).toBe(2);
    expect(result.requestedKeyCount).toBe(2);
    const second = component.txCalls[1]!;
    expect(second.ledgerEntries).toEqual([
      { entryXdr: entryA, liveUntilLedger: 500 },
    ]);
    expect(second.knownAbsentKeys.map(keyHex)).toEqual([keyHex(keyB)]);
  });

  it("throws when the component lacks simulate-transaction", async () => {
    // A host-function-only component (no simulateTransaction export).
    const component = scriptedComponent(() => complete(new Uint8Array([1])));
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      component,
    });
    await expect(sim.simulateTransaction(TX_INPUT)).rejects.toThrow(
      /simulate-transaction/,
    );
  });
});

/**
 * Minimal STRC buffer (crates/soroban-sim-core/src/trace.rs layout): one
 * `begin` step with cpu=7, mem=3. Hand-assembled so the test pins the wire
 * format rather than trusting a TS encoder.
 */
function strcOneBegin(): Uint8Array {
  const name = "begin";
  const display = "begin";
  const bytes = [
    0x53, 0x54, 0x52, 0x43, 0x30, 0x00, // "STRC0\0"
    0, 0, 0, 1, // count = 1
    0, 0, 0, 0, // seq = 0
    0, // kind = Begin
    0, 0, 0, name.length, ...[...name].map((c) => c.charCodeAt(0)),
    0, 0, 0, display.length, ...[...display].map((c) => c.charCodeAt(0)),
    0, 0, 0, 0, 0, 0, 0, 7, // cpu = 7
    0, 0, 0, 0, 0, 0, 0, 3, // mem = 3
  ];
  return new Uint8Array(bytes);
}

/** Component whose simulate-trace() replays a scripted sequence. */
function scriptedTraceComponent(
  script: (request: Request, call: number) => TraceOutcome,
): Component & { traceCalls: Request[] } {
  const traceCalls: Request[] = [];
  return {
    traceCalls,
    // simulate() is unused on this path but required by the interface.
    simulate(): Outcome {
      throw new Error("simulate() should not be called on the trace path");
    },
    simulateTrace(request: Request): TraceOutcome {
      traceCalls.push({
        ...request,
        ledgerEntries: [...request.ledgerEntries],
        knownAbsentKeys: [...request.knownAbsentKeys],
      });
      return script(request, traceCalls.length - 1);
    },
  };
}

describe("SorobanSimulator.simulateTrace loop", () => {
  it("reruns on needs-state, then returns the decoded trace + ssim", async () => {
    const keyA = new Uint8Array([0x01]);
    const keyB = new Uint8Array([0x02]);
    const entryA = new Uint8Array([0xde, 0xad]);
    const ssim = new Uint8Array([0x2a, 0x2b]);
    const component = scriptedTraceComponent((_req, call) =>
      call === 0
        ? { tag: "needs-state", val: [keyA, keyB] }
        : { tag: "complete", val: { ssim, trace: strcOneBegin() } },
    );
    const provider = inMemoryProvider({
      [keyHex(keyA)]: {
        status: "present",
        entry: { entryXdr: entryA, liveUntilLedger: 500 },
      },
      [keyHex(keyB)]: { status: "absent" },
    });
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      provider,
      component,
    });
    const result = await sim.simulateTrace(INPUT);
    expect(result.resultXdr).toEqual(ssim);
    expect(result.traceUnavailableReason).toBeUndefined();
    expect(result.trace).toEqual([
      { seq: 0, kind: "begin", name: "begin", display: "begin", cpu: 7n, mem: 3n },
    ]);
    expect(result.rounds).toBe(2);
    expect(result.requestedKeyCount).toBe(2);
    // The rerun folded the resolved entry + absent key like the plain loop.
    const second = component.traceCalls[1]!;
    expect(second.ledgerEntries).toEqual([
      { entryXdr: entryA, liveUntilLedger: 500 },
    ]);
    expect(second.knownAbsentKeys.map(keyHex)).toEqual([keyHex(keyB)]);
  });

  it("surfaces trace-unavailable as ssim + reason with an empty trace", async () => {
    const ssim = new Uint8Array([0x11]);
    const component = scriptedTraceComponent(() => ({
      tag: "trace-unavailable",
      val: { ssim, reason: "pass 1 failed; no recorded footprint to replay" },
    }));
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      component,
    });
    const result = await sim.simulateTrace(INPUT);
    expect(result.resultXdr).toEqual(ssim);
    expect(result.trace).toEqual([]);
    expect(result.traceUnavailableReason).toMatch(/no recorded footprint/);
    expect(result.rounds).toBe(1);
  });

  it("throws when the component lacks simulate-trace", async () => {
    const component = scriptedComponent(() => complete(new Uint8Array([1])));
    const sim = await SorobanSimulator.create({
      networkPassphrase: "Test",
      component,
    });
    await expect(sim.simulateTrace(INPUT)).rejects.toThrow(/simulate-trace/);
  });
});

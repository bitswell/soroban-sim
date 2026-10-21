import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  ledgerEntryXdr,
  RpcBaseLedger,
  StaticBaseLedger,
  type BaseEntry,
} from "./base.js";
import { forkConfigFromRpc, parseLedgerHeader, TESTNET_PASSPHRASE } from "./fork.js";
import { PersistentSession } from "./persistent.js";
import { ReadOnlyRpc } from "./rpc.js";
import {
  bodyChangesSession,
  type ComponentBaseBatch,
  type ComponentSession,
  type ForkConfig,
  type NetworkSessionModule,
  type Reply,
  SessionRpcError,
  SorobanSession,
} from "./session.js";
import { SessionStore } from "./store.js";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * A component that answers only once it has been given every key a method
 * needs: `needs[method]` lists them (as text), the way a fork needs the
 * entries a transaction reads. Mutating calls are recorded in `applied`.
 * A `sendTransaction` with `real` (or `refuse`) params stands for an envelope
 * a real key signed: it counts in `fork_info`'s `replayable`, and `refuse`
 * answers -32001 the way a mainnet fork does.
 */
class FakeComponent implements ComponentSession {
  known = new Map<string, Uint8Array | null>();
  provided: ComponentBaseBatch[] = [];
  calls: string[] = [];
  applied: string[] = [];
  replayable = 0;

  constructor(private readonly needs: Record<string, string[]> = {}) {}

  provide(batch: ComponentBaseBatch): void {
    this.provided.push(batch);
    // Entries are LedgerEntry-wrapped `key=value` text.
    for (const e of batch.entries) this.known.set(dec(e.entryXdr.subarray(4, -4)).split("=")[0]!, e.entryXdr);
    for (const k of batch.absentKeys) this.known.set(dec(k), null);
  }

  rpc(body: string): Reply {
    const call = JSON.parse(body) as { id?: unknown; method: string; params?: unknown };
    this.calls.push(call.method);
    const missing = (this.needs[call.method] ?? []).filter((k) => !this.known.has(k));
    if (missing.length > 0) return { tag: "needs-state", val: missing.map(enc) };
    if (call.method === "bad") {
      return response({ jsonrpc: "2.0", id: call.id, error: { code: -32602, message: "bad params" } });
    }
    const real = (call.params ?? {}) as { real?: boolean; refuse?: boolean };
    if (call.method === "sendTransaction" && (real.real || real.refuse)) this.replayable += 1;
    if (call.method === "sendTransaction" && real.refuse) {
      return response({ jsonrpc: "2.0", id: call.id, error: { code: -32001, message: "valid on mainnet" } });
    }
    if (!["fork_info", "getNetwork", "fork_steps"].includes(call.method)) this.applied.push(call.method);
    return response({
      jsonrpc: "2.0",
      id: call.id,
      result: {
        method: call.method,
        applied: this.applied.length,
        ...(call.method === "fork_info" ? { replayable: this.replayable } : {}),
      },
    });
  }

  submit(envelopeXdr: Uint8Array): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "sendTransaction", params: { envelope: dec(envelopeXdr) } }));
  }
  advance(ledgers: number): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_advanceLedgers", params: { ledgers } }));
  }
  setTime(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_setTime" }));
  }
  applyOverride(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_setBalance" }));
  }
  snapshot(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_snapshot" }));
  }
  revert(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_revert" }));
  }
  allowRealSigners(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_allowRealSigners" }));
  }
  steps(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_steps" }));
  }
  debugContext(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_debugContext" }));
  }
  report(): Reply {
    return this.rpc(JSON.stringify({ id: 1, method: "fork_report" }));
  }
  setRpcCounters(): void {}
}

function response(v: unknown): Reply {
  return { tag: "response", val: JSON.stringify(v) };
}

/** A base whose entries are `key=value` text, so the fake can read them. */
function textBase(entries: Record<string, string>, ledger = 100): StaticBaseLedger {
  return new StaticBaseLedger(
    ledger,
    Object.entries(entries).map(([k, v]): BaseEntry => ({ keyXdr: enc(k), entryXdr: ledgerEntryXdr(0, enc(`${k}=${v}`)) })),
  );
}

describe("SorobanSession", () => {
  it("fetches what a call needs, provides it, and repeats the call", async () => {
    const component = new FakeComponent({ sendTransaction: ["alice", "code"] });
    const base = textBase({ alice: "1000" });
    const session = new SorobanSession(component, base);
    const sent = await session.submit(enc("envelope"));
    expect(sent).toEqual({ method: "sendTransaction", applied: 1 });
    expect(session.rounds).toBe(1);
    expect(component.calls).toEqual(["sendTransaction", "sendTransaction"]);
    // The component gets the WIT shape: no keyXdr, absent keys separate.
    expect(component.provided).toHaveLength(1);
    expect(Object.keys(component.provided[0]!.entries[0]!)).toEqual(["entryXdr"]);
    expect(component.provided[0]!.absentKeys.map(dec)).toEqual(["code"]);
  });

  it("turns a JSON-RPC error into a SessionRpcError with its code", async () => {
    const session = new SorobanSession(new FakeComponent(), textBase({}));
    const error = await session.call("bad").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionRpcError);
    expect((error as SessionRpcError).code).toBe(-32602);
  });

  it("runs one call at a time, in the order they were made", async () => {
    const component = new FakeComponent({ sendTransaction: ["slow"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const base = {
      async fetch(keys: Uint8Array[]) {
        await gate;
        return { servedAtLedger: 1, entries: [], absentKeys: keys };
      },
    };
    const session = new SorobanSession(component, base);
    const first = session.submit(enc("first"));
    const second = session.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(component.calls).toEqual(["sendTransaction"]);
    release();
    await Promise.all([first, second]);
    expect(component.applied).toEqual(["sendTransaction", "fork_advanceLedgers"]);
  });

  it("gives up after maxRounds", async () => {
    const component = new FakeComponent();
    component.rpc = () => ({ tag: "needs-state", val: [enc("never")] });
    const session = new SorobanSession(component, textBase({}), { maxRounds: 3 });
    await expect(session.rpc("{}")).rejects.toThrow(/after 3 rounds/);
    // A failed call does not wedge the queue.
    component.rpc = () => response({ jsonrpc: "2.0", id: 1, result: "ok" });
    await expect(session.call("getNetwork")).resolves.toBe("ok");
  });

  it("knows which bodies can change a session", () => {
    expect(bodyChangesSession('{"method":"getLedgerEntries"}')).toBe(false);
    expect(bodyChangesSession('[{"method":"getNetwork"},{"method":"fork_steps"}]')).toBe(false);
    expect(bodyChangesSession('{"method":"sendTransaction"}')).toBe(true);
    expect(bodyChangesSession('[{"method":"getNetwork"},{"method":"fork_revert"}]')).toBe(true);
    expect(bodyChangesSession("not json")).toBe(false);
  });
});

describe("ReadOnlyRpc", () => {
  it("refuses to send a transaction", async () => {
    const rpc = new ReadOnlyRpc("https://rpc.invalid", { fetch: () => Promise.reject(new Error("no network")) });
    await expect(rpc.call("sendTransaction" as "getNetwork")).rejects.toThrow(/only reads/);
    expect(rpc.calls).toBe(0);
  });

  it("backs off on 429 and counts the retries", async () => {
    const answers = [429, 503, 200];
    const slept: number[] = [];
    const rpc = new ReadOnlyRpc("https://rpc.invalid", {
      fetch: async () => {
        const status = answers.shift()!;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { passphrase: "p" } }), { status });
      },
      sleep: async (ms) => void slept.push(ms),
    });
    await expect(rpc.network()).resolves.toEqual({ passphrase: "p" });
    expect(slept).toEqual([1000, 2000]);
    expect([rpc.calls, rpc.throttled]).toEqual([3, 2]);
  });

  it("surfaces a JSON-RPC error", async () => {
    const rpc = new ReadOnlyRpc("https://rpc.invalid", {
      fetch: async () => new Response(JSON.stringify({ error: { code: -32602, message: "bad key" } })),
    });
    await expect(rpc.ledgerEntries(["x"])).rejects.toThrow(/bad key/);
  });
});

describe("RpcBaseLedger", () => {
  it("returns every key, present or absent, as LedgerEntry XDR", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => enc(`k${i}`));
    const calls: string[][] = [];
    const rpc = new ReadOnlyRpc("https://rpc.invalid", {
      fetch: async (_url, init) => {
        const { params } = JSON.parse(String(init!.body)) as { params: { keys: string[] } };
        calls.push(params.keys);
        const entries = params.keys
          .filter((k) => dec(base64ToBytes(k)) === "k7")
          .map((k) => ({ key: k, xdr: bytesToBase64(Uint8Array.of(9, 9)), lastModifiedLedgerSeq: 0x01020304, liveUntilLedgerSeq: 42 }));
        return new Response(JSON.stringify({ result: { latestLedger: 500 + calls.length, entries } }));
      },
    });
    const batch = await new RpcBaseLedger(rpc).fetch(keys);
    expect(calls.map((c) => c.length)).toEqual([200, 50]);
    expect(batch.servedAtLedger).toBe(502);
    expect(batch.absentKeys).toHaveLength(249);
    expect(batch.entries).toHaveLength(1);
    const [e] = batch.entries;
    expect(dec(e!.keyXdr)).toBe("k7");
    expect([...e!.entryXdr]).toEqual([1, 2, 3, 4, 9, 9, 0, 0, 0, 0]);
    expect(e!.liveUntilLedger).toBe(42);
  });

  it("wraps LedgerEntryData with a big-endian last-modified ledger and a v0 extension", () => {
    expect([...ledgerEntryXdr(258, Uint8Array.of(7))]).toEqual([0, 0, 1, 2, 7, 0, 0, 0, 0]);
  });
});

/** LedgerHeader XDR with one upgrade and a signed StellarValue. */
function headerXdr(): Uint8Array {
  const parts: number[] = [];
  const u32 = (n: number) => parts.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const u64 = (n: bigint) => {
    u32(Number(n >> 32n));
    u32(Number(n & 0xffffffffn));
  };
  const bytes = (n: number, fill = 0) => parts.push(...new Array<number>(n).fill(fill));
  u32(29); // ledgerVersion
  bytes(32); // previousLedgerHash
  bytes(32); // txSetHash
  u64(1_792_531_097n); // closeTime
  u32(1); // one upgrade
  u32(5); // opaque length 5, padded to 8
  bytes(8, 1);
  u32(1); // STELLAR_VALUE_SIGNED
  u32(0); // NodeID: PUBLIC_KEY_TYPE_ED25519
  bytes(32);
  u32(64); // signature
  bytes(64);
  bytes(64); // txSetResultHash, bucketListHash
  u32(5_301_502); // ledgerSeq
  u64(1n); // totalCoins
  u64(2n); // feePool
  u32(3); // inflationSeq
  u64(4n); // idPool
  u32(100); // baseFee
  u32(5_000_000); // baseReserve
  u32(1000); // maxTxSetSize
  bytes(128); // skipList
  u32(0); // ext
  return Uint8Array.from(parts);
}

describe("fork point", () => {
  it("reads the fork fields out of a LedgerHeader", () => {
    expect(parseLedgerHeader(headerXdr())).toEqual({
      ledgerVersion: 29,
      closeTime: 1_792_531_097n,
      ledgerSeq: 5_301_502,
      baseFee: 100,
      baseReserve: 5_000_000,
    });
  });

  it("forks the RPC's latest ledger and checks the passphrase", async () => {
    const rpc = fakeRpc();
    const fork = await forkConfigFromRpc(rpc, { networkName: "testnet", expectedPassphrase: TESTNET_PASSPHRASE });
    expect(fork).toMatchObject({ forkLedger: 5_301_502, forkCloseTime: 1_792_531_097n, baseFee: 100, protocolVersion: 29 });
    await expect(forkConfigFromRpc(rpc, { networkName: "x", expectedPassphrase: "other" })).rejects.toThrow(/serves/);
  });
});

/** An RPC with testnet's identity and a base holding only `alice`. */
function fakeRpc(seen: string[] = []): ReadOnlyRpc {
  return new ReadOnlyRpc("https://rpc.invalid", { fetch: fakeFetch(seen) });
}

function fakeFetch(seen: string[]): typeof fetch {
  return async (_url, init) => {
      const { method, params } = JSON.parse(String(init!.body)) as { method: string; params: { keys?: string[] } };
      seen.push(method);
      const result =
        method === "getNetwork"
          ? { passphrase: TESTNET_PASSPHRASE, protocolVersion: 29 }
          : method === "getLatestLedger"
            ? { sequence: 5_301_502, protocolVersion: 29, headerXdr: bytesToBase64(headerXdr()) }
            : {
                latestLedger: 5_301_502,
                entries: (params.keys ?? [])
                  .filter((k) => dec(base64ToBytes(k)) === "alice")
                  .map((k) => ({ key: k, xdr: bytesToBase64(enc("alice=1000")) })),
              };
      return new Response(JSON.stringify({ result }));
  };
}

describe("SessionStore and PersistentSession", () => {
  it("keeps ops in order and groups the fork cache by ledger", async () => {
    const store = await SessionStore.open({ dbName: "store-test" });
    const record = await store.create({ id: "s1", title: "t", createdAt: 1, rpcUrl: "u", fork: {} as never });
    expect(record.opCount).toBe(0);
    await store.appendOp("s1", "a");
    await store.appendOp("s1", "b");
    expect(await store.ops("s1")).toEqual(["a", "b"]);
    await store.putBase("s1", { servedAtLedger: 7, entries: [{ keyXdr: enc("k"), entryXdr: enc("k=v"), liveUntilLedger: 9 }], absentKeys: [enc("gone")] });
    await store.putBase("s1", { servedAtLedger: 8, entries: [], absentKeys: [enc("later")] });
    const batches = await store.base("s1");
    expect(batches.map((b) => b.servedAtLedger)).toEqual([7, 8]);
    expect(dec(batches[0]!.entries[0]!.keyXdr)).toBe("k");
    expect(batches[0]!.entries[0]!.liveUntilLedger).toBe(9);
    expect(batches[0]!.absentKeys.map(dec)).toEqual(["gone"]);
    await store.delete("s1");
    expect(await store.get("s1")).toBeUndefined();
    expect(await store.ops("s1")).toEqual([]);
    expect(await store.base("s1")).toEqual([]);
    store.close();
  });

  it("logs what changed the session and replays it offline after a reload", async () => {
    const store = await SessionStore.open({ dbName: "persist-test" });
    let built: FakeComponent | undefined;
    const module: NetworkSessionModule = {
      Session: class {
        constructor(config: ForkConfig) {
          expect(config.forkLedger).toBe(5_301_502);
          built = new FakeComponent({ fork_info: ["alice"], sendTransaction: ["alice", "code"] });
          return built;
        }
      } as unknown as NetworkSessionModule["Session"],
    };
    const seen: string[] = [];
    const first = await PersistentSession.start({
      store,
      module,
      rpcUrl: "https://rpc.invalid",
      networkName: "testnet",
      id: "p1",
      rpcOptions: { fetch: fakeFetch(seen) },
    });
    await first.call("sendTransaction", { tx: 1 });
    await first.call("getLedgerEntries", { keys: [] });
    await first.call("bad").catch(() => undefined);
    await first.call("fork_advanceLedgers", { ledgers: 3 });
    expect(await store.ops("p1")).toEqual([
      expect.stringContaining("sendTransaction"),
      expect.stringContaining("fork_advanceLedgers"),
    ]);
    first.dispose();

    // A reload: a fresh component, the cached base, the log replayed, and no
    // base reads over the network.
    seen.length = 0;
    const replayed: number[] = [];
    const second = await PersistentSession.resume({
      store,
      module,
      id: "p1",
      rpcOptions: { fetch: fakeFetch(seen) },
      onReplay: (done) => replayed.push(done),
    });
    expect(replayed).toEqual([1, 2]);
    expect(built!.applied).toEqual(["sendTransaction", "fork_advanceLedgers"]);
    expect(seen).toEqual([]);
    expect(second.session.rounds).toBe(0);
    store.close();
  });

  it("never logs a real-signed envelope or the real-signer allowance", async () => {
    const store = await SessionStore.open({ dbName: "real-signer-test" });
    const module: NetworkSessionModule = {
      Session: class {
        constructor() {
          return new FakeComponent();
        }
      } as unknown as NetworkSessionModule["Session"],
    };
    const session = await PersistentSession.start({
      store,
      module,
      rpcUrl: "https://rpc.invalid",
      networkName: "testnet",
      id: "r1",
      rpcOptions: { fetch: fakeFetch([]) },
    });
    await session.call("fork_allowRealSigners", { allow: true });
    // Made together: each body is judged by the signatures it brought in.
    await Promise.all([
      session.call("sendTransaction", { real: true }),
      session.call("sendTransaction", { throwaway: 1 }),
    ]);
    await session.call("fork_allowRealSigners", { allow: false });
    const refused = await session.call("sendTransaction", { refuse: true }).catch((e: unknown) => e);
    expect((refused as SessionRpcError).code).toBe(-32001);
    await session.call("sendTransaction", { throwaway: 2 });
    const ops = (await store.ops("r1")).map((b) => JSON.parse(b) as { method: string; params: unknown });
    expect(ops).toEqual([
      expect.objectContaining({ method: "sendTransaction", params: { throwaway: 1 } }),
      expect.objectContaining({ method: "sendTransaction", params: { throwaway: 2 } }),
    ]);
    session.dispose();
    store.close();
  });
});

describe("throwaway keys", () => {
  it("derive the same address as soroban-sim-core's Ed25519Key::throwaway", async () => {
    const { throwawayKeypair } = await import("./throwaway.js");
    // crates/soroban-sim-facade/tests/facade.rs asserts the same address.
    expect(throwawayKeypair("alice").publicKey()).toBe("GBEFICSBULGI6ZIMM36MCGPLBWQUKAD6JYNR6N3WQD2JOK6BLP4C7F2J");
  });
});

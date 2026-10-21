/**
 * SessionStore — a session as a replayable log in IndexedDB, so it survives a
 * reload:
 *
 *   sessions  the fork point and network (one record per session)
 *   ops       every JSON-RPC body that changed the session, in order
 *   base      every base entry the session read (the fork cache), present or
 *             absent, with the ledger RPC served it at
 *
 * Replaying the ops over the cached base rebuilds the same session without
 * touching the network: the component is deterministic, and envelopes carry
 * their own signatures. Nothing secret is stored: browser sessions sign with
 * throwaway keys derived from labels, envelopes are public by design, and an
 * envelope a real key signed never reaches the log (see PersistentSession),
 * since the real network would accept it.
 */
import type { BaseBatch } from "./base.js";
import { base64ToBytes, bytesToBase64 } from "./base.js";
import type { ForkConfig } from "./session.js";

/** Bump on any incompatible change; it opens a new database. */
export const SESSION_DB_SCHEMA_VERSION = 1;
const DEFAULT_DB_NAME = "soroban-sim-sessions";

/** {@link ForkConfig} with only structured-clone-safe values. */
export interface StoredForkConfig {
  networkName: string;
  networkPassphrase: string;
  baseDescription: string;
  forkLedger: number;
  forkCloseTime: string;
  protocolVersion: number;
  baseReserve: number;
  baseFee: number;
  headerXdr?: string;
  secondsPerLedger: number;
  allowRealSigners: boolean;
  servedBy: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  /** The base RPC the session reads (never writes). */
  rpcUrl: string;
  fork: StoredForkConfig;
  /** Ops logged so far. */
  opCount: number;
}

interface OpRecord {
  sessionId: string;
  seq: number;
  body: string;
  at: number;
}

interface BaseRecord {
  sessionId: string;
  key: string;
  servedAtLedger: number;
  entryXdr?: Uint8Array;
  liveUntilLedger?: number;
}

export function storeForkConfig(c: ForkConfig): StoredForkConfig {
  return {
    ...c,
    forkCloseTime: c.forkCloseTime.toString(),
    headerXdr: c.headerXdr ? bytesToBase64(c.headerXdr) : undefined,
  };
}

export function loadForkConfig(c: StoredForkConfig): ForkConfig {
  const { headerXdr, ...rest } = c;
  return {
    ...rest,
    forkCloseTime: BigInt(c.forkCloseTime),
    ...(headerXdr ? { headerXdr: base64ToBytes(headerXdr) } : {}),
  };
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export interface SessionStoreOptions {
  dbName?: string;
  /** Defaults to `globalThis.indexedDB`; tests inject fake-indexeddb. */
  indexedDB?: IDBFactory;
}

export class SessionStore {
  private constructor(private readonly db: IDBDatabase) {}

  static async open(options: SessionStoreOptions = {}): Promise<SessionStore> {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new Error("IndexedDB is not available here");
    const req = factory.open(`${options.dbName ?? DEFAULT_DB_NAME}/v${SESSION_DB_SCHEMA_VERSION}`, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("sessions", { keyPath: "id" });
      db.createObjectStore("ops", { keyPath: ["sessionId", "seq"] }).createIndex("bySession", "sessionId");
      db.createObjectStore("base", { keyPath: ["sessionId", "key"] }).createIndex("bySession", "sessionId");
    };
    return new SessionStore(await done(req));
  }

  close(): void {
    this.db.close();
  }

  async create(record: Omit<SessionRecord, "opCount">): Promise<SessionRecord> {
    const full: SessionRecord = { ...record, opCount: 0 };
    const tx = this.db.transaction("sessions", "readwrite");
    tx.objectStore("sessions").add(full);
    await committed(tx);
    return full;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    return done(this.db.transaction("sessions").objectStore("sessions").get(id));
  }

  /** Newest first. */
  async list(): Promise<SessionRecord[]> {
    const all = await done(this.db.transaction("sessions").objectStore("sessions").getAll());
    return (all as SessionRecord[]).sort((a, b) => b.createdAt - a.createdAt);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction(["sessions", "ops", "base"], "readwrite");
    tx.objectStore("sessions").delete(id);
    for (const name of ["ops", "base"] as const) {
      const index = tx.objectStore(name).index("bySession");
      const keys = await done(index.getAllKeys(IDBKeyRange.only(id)));
      for (const key of keys) tx.objectStore(name).delete(key);
    }
    await committed(tx);
  }

  /** Append one body to the log, after the session answered it. */
  async appendOp(id: string, body: string): Promise<number> {
    const tx = this.db.transaction(["sessions", "ops"], "readwrite");
    const sessions = tx.objectStore("sessions");
    const record = (await done(sessions.get(id))) as SessionRecord | undefined;
    if (!record) throw new Error(`no session ${id}`);
    const seq = record.opCount;
    tx.objectStore("ops").add({ sessionId: id, seq, body, at: Date.now() } satisfies OpRecord);
    sessions.put({ ...record, opCount: seq + 1 });
    await committed(tx);
    return seq;
  }

  /** The logged bodies, in order. */
  async ops(id: string): Promise<string[]> {
    const index = this.db.transaction("ops").objectStore("ops").index("bySession");
    const records = (await done(index.getAll(IDBKeyRange.only(id)))) as OpRecord[];
    return records.sort((a, b) => a.seq - b.seq).map((r) => r.body);
  }

  /** Cache one base batch. */
  async putBase(id: string, batch: BaseBatch): Promise<void> {
    const tx = this.db.transaction("base", "readwrite");
    const store = tx.objectStore("base");
    for (const e of batch.entries) {
      store.put({
        sessionId: id,
        key: bytesToBase64(e.keyXdr),
        servedAtLedger: batch.servedAtLedger,
        entryXdr: e.entryXdr,
        ...(e.liveUntilLedger !== undefined ? { liveUntilLedger: e.liveUntilLedger } : {}),
      } satisfies BaseRecord);
    }
    for (const k of batch.absentKeys) {
      store.put({ sessionId: id, key: bytesToBase64(k), servedAtLedger: batch.servedAtLedger } satisfies BaseRecord);
    }
    await committed(tx);
  }

  /** Every cached base entry, grouped into batches by the ledger served at. */
  async base(id: string): Promise<BaseBatch[]> {
    const index = this.db.transaction("base").objectStore("base").index("bySession");
    const records = (await done(index.getAll(IDBKeyRange.only(id)))) as BaseRecord[];
    const batches = new Map<number, BaseBatch>();
    for (const r of records) {
      let batch = batches.get(r.servedAtLedger);
      if (!batch) {
        batch = { servedAtLedger: r.servedAtLedger, entries: [], absentKeys: [] };
        batches.set(r.servedAtLedger, batch);
      }
      if (r.entryXdr) {
        batch.entries.push({
          keyXdr: base64ToBytes(r.key),
          entryXdr: new Uint8Array(r.entryXdr),
          ...(r.liveUntilLedger !== undefined ? { liveUntilLedger: r.liveUntilLedger } : {}),
        });
      } else {
        batch.absentKeys.push(base64ToBytes(r.key));
      }
    }
    return [...batches.values()].sort((a, b) => a.servedAtLedger - b.servedAtLedger);
  }
}

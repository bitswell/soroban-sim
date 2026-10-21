/**
 * Where a session's fork reads the real network from.
 *
 * The component never fetches: a call that needs base entries returns their
 * keys, the caller fetches them through a {@link BaseLedger}, provides the
 * batch, and repeats the call. A batch keeps RPC's answer verbatim, so an
 * archived entry (RPC returns evicted entries with `liveUntilLedgerSeq` in the
 * past, or 0) stays distinct from an absent one.
 */
import { ReadOnlyRpc } from "./rpc.js";

/** A present base entry: its LedgerKey, LedgerEntry XDR and TTL. */
export interface BaseEntry {
  keyXdr: Uint8Array;
  entryXdr: Uint8Array;
  liveUntilLedger?: number;
}

/** One answer from the base: present entries and keys proven absent. */
export interface BaseBatch {
  /** The ledger the base answered at (RPC serves only its latest). */
  servedAtLedger: number;
  entries: BaseEntry[];
  absentKeys: Uint8Array[];
}

export interface BaseLedger {
  /** Every requested key comes back, present or absent. */
  fetch(keys: Uint8Array[]): Promise<BaseBatch>;
}

/** RPC caps `getLedgerEntries` at 200 keys. */
export const RPC_KEYS_PER_CALL = 200;

/** Lazily reads a live network over RPC `getLedgerEntries`. */
export class RpcBaseLedger implements BaseLedger {
  constructor(readonly rpc: ReadOnlyRpc) {}

  async fetch(keys: Uint8Array[]): Promise<BaseBatch> {
    const batch: BaseBatch = { servedAtLedger: 0, entries: [], absentKeys: [] };
    for (let i = 0; i < keys.length; i += RPC_KEYS_PER_CALL) {
      const chunk = keys.slice(i, i + RPC_KEYS_PER_CALL);
      const encoded = chunk.map(bytesToBase64);
      const answer = await this.rpc.ledgerEntries(encoded);
      batch.servedAtLedger = Math.max(batch.servedAtLedger, answer.latestLedger);
      const found = new Map((answer.entries ?? []).map((e) => [e.key, e]));
      encoded.forEach((key, j) => {
        const hit = found.get(key);
        if (!hit) {
          batch.absentKeys.push(chunk[j]!);
          return;
        }
        batch.entries.push({
          keyXdr: chunk[j]!,
          entryXdr: ledgerEntryXdr(hit.lastModifiedLedgerSeq ?? 0, base64ToBytes(hit.xdr)),
          ...(hit.liveUntilLedgerSeq !== undefined
            ? { liveUntilLedger: hit.liveUntilLedgerSeq }
            : {}),
        });
      });
    }
    return batch;
  }
}

/** A fixed base: tests and recorded fixtures. Unknown keys are absent. */
export class StaticBaseLedger implements BaseLedger {
  private readonly entries = new Map<string, BaseEntry>();
  /** Keys asked for, in order: tests assert on the fetch pattern. */
  readonly requested: string[] = [];

  constructor(
    readonly servedAtLedger: number,
    entries: BaseEntry[],
  ) {
    for (const e of entries) this.entries.set(bytesToBase64(e.keyXdr), e);
  }

  async fetch(keys: Uint8Array[]): Promise<BaseBatch> {
    const batch: BaseBatch = { servedAtLedger: this.servedAtLedger, entries: [], absentKeys: [] };
    for (const key of keys) {
      const id = bytesToBase64(key);
      this.requested.push(id);
      const hit = this.entries.get(id);
      if (hit) batch.entries.push(hit);
      else batch.absentKeys.push(key);
    }
    return batch;
  }
}

/**
 * A stellar-xdr LedgerEntry from RPC's parts: `lastModifiedLedgerSeq`, the
 * `LedgerEntryData` RPC returns as `xdr`, and a v0 extension (as the CLI's
 * fork does).
 */
export function ledgerEntryXdr(lastModified: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + data.length + 4);
  new DataView(out.buffer).setUint32(0, lastModified >>> 0);
  out.set(data, 4);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

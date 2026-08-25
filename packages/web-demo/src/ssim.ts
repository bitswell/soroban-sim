/**
 * SSIM0 decoder — a copy of `packages/soroban-sim/src/differential/decode-ssim.ts`,
 * vendored because that module is internal to the simulator package (only `.` and
 * `./generated` are exported). It mirrors the Rust encoder
 * `encode_simulation_result` in `crates/soroban-sim-core/src/lib.rs`.
 *
 * The component's `outcome::complete(bytes)` payload is a deterministic,
 * self-describing binary framing (the "SSIM0" format) of a soroban-simulation
 * `InvokeHostFunctionSimulationResult`. This decoder reads that framing back into
 * raw XDR byte slices; the worker then turns those slices into display labels via
 * `decode.ts` (where the heavy `@stellar/stellar-sdk` lives, off the main thread).
 *
 * Framing (all integers big-endian), byte-for-byte matching the Rust encoder:
 *
 *   magic:                  b"SSIM0\0"                      (6 bytes)
 *   simulated_instructions: u32
 *   simulated_memory:       u32
 *   result:
 *     tag: u8  (0 = success ScVal, 1 = inline contract/host failure)
 *     tag==0 -> length-prefixed ScVal XDR       (u32 len + bytes)
 *     tag==1 -> length-prefixed UTF-8 error msg (u32 len + bytes)
 *   auth:              u32 count + [u32 len + SorobanAuthorizationEntry XDR]*
 *   contract_events:   u32 count + [u32 len + ContractEvent XDR]*
 *   diagnostic_events: u32 count + [u32 len + DiagnosticEvent XDR]*
 *   transaction_data:  u8 present (0/1); if 1 -> u32 len + SorobanTransactionData XDR
 *   modified_entries:  u32 count + [optional(state_before) optional(state_after)]*
 *       optional(entry): u8 present (0/1); if 1 -> u32 len + LedgerEntry XDR
 */

const SSIM_MAGIC = [0x53, 0x53, 0x49, 0x4d, 0x30, 0x00];

/** Successful invocation: the returned value as raw `ScVal` XDR. */
export interface SsimResultOk {
  ok: true;
  scValXdr: Uint8Array;
}
/** Inline failure: a host/contract error, encoded as the Rust `{err:?}` string. */
export interface SsimResultErr {
  ok: false;
  error: string;
}
export type SsimResult = SsimResultOk | SsimResultErr;

/** A single post-invocation ledger-entry change (both sides `LedgerEntry` XDR). */
export interface SsimEntryDiff {
  before?: Uint8Array;
  after?: Uint8Array;
}

/** Fully decoded SSIM payload. All XDR fields are returned as raw byte slices. */
export interface SsimDecoded {
  /** Raw metered CPU instructions the run consumed (adjustment-independent). */
  simulatedInstructions: number;
  /** Raw metered linear-memory bytes the run consumed. */
  simulatedMemory: number;
  /** The invocation return value, or an inline host/contract error. */
  result: SsimResult;
  /** `SorobanAuthorizationEntry` XDR blobs the run recorded, in emission order. */
  auth: Uint8Array[];
  /** `ContractEvent` XDR blobs the run emitted, in emission order. */
  contractEvents: Uint8Array[];
  /** `DiagnosticEvent` XDR blobs (populated only when diagnostics are enabled). */
  diagnosticEvents: Uint8Array[];
  /** `SorobanTransactionData` XDR (footprint + resources + resourceFee); absent on failure. */
  transactionData?: Uint8Array;
  /** Post-invocation `LedgerEntry` diffs the run produced. */
  modifiedEntries: SsimEntryDiff[];
}

class Cursor {
  private off = 0;
  private readonly view: DataView;
  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  private ensure(n: number): void {
    if (this.off + n > this.data.length) {
      throw new Error(
        `SSIM decode overrun: need ${n} at ${this.off}, ${this.data.length - this.off} remain`,
      );
    }
  }
  u8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }
  u32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.off, false);
    this.off += 4;
    return v;
  }
  take(n: number): Uint8Array {
    this.ensure(n);
    const out = this.data.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  lenPrefixed(): Uint8Array {
    return this.take(this.u32());
  }
  remaining(): number {
    return this.data.length - this.off;
  }
  pos(): number {
    return this.off;
  }
}

function readVec(c: Cursor): Uint8Array[] {
  const count = c.u32();
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i += 1) out.push(c.lenPrefixed());
  return out;
}

function readOptionalEntry(c: Cursor): Uint8Array | undefined {
  return c.u8() === 1 ? c.lenPrefixed() : undefined;
}

export function decodeSsim(bytes: Uint8Array): SsimDecoded {
  const c = new Cursor(bytes);
  const magic = c.take(SSIM_MAGIC.length);
  for (let i = 0; i < SSIM_MAGIC.length; i += 1) {
    if (magic[i] !== SSIM_MAGIC[i]) throw new Error("SSIM decode: bad magic");
  }
  const simulatedInstructions = c.u32();
  const simulatedMemory = c.u32();

  const tag = c.u8();
  let result: SsimResult;
  if (tag === 0) {
    result = { ok: true, scValXdr: c.lenPrefixed() };
  } else if (tag === 1) {
    result = { ok: false, error: new TextDecoder().decode(c.lenPrefixed()) };
  } else {
    throw new Error(`SSIM decode: unknown result tag ${tag}`);
  }

  const auth = readVec(c);
  const contractEvents = readVec(c);
  const diagnosticEvents = readVec(c);

  const transactionData = c.u8() === 1 ? c.lenPrefixed() : undefined;

  const diffCount = c.u32();
  const modifiedEntries: SsimEntryDiff[] = [];
  for (let i = 0; i < diffCount; i += 1) {
    const before = readOptionalEntry(c);
    const after = readOptionalEntry(c);
    modifiedEntries.push({ before, after });
  }

  if (c.remaining() !== 0) {
    throw new Error(
      `SSIM decode: ${c.remaining()} trailing byte(s) after a full parse — framing drift`,
    );
  }

  return {
    simulatedInstructions,
    simulatedMemory,
    result,
    auth,
    contractEvents,
    diagnosticEvents,
    transactionData,
    modifiedEntries,
  };
}

/**
 * A contiguous span of the SSIM envelope, tagged by which framing field it
 * covers. Used to paint the "byte map" so the deterministic binary framing —
 * magic, budget, result, the three event vecs, tx-data, ledger diffs — is
 * visible region by region. Half-open `[start, end)` byte offsets.
 */
export interface SsimRegion {
  /** Stable kind slug for coloring: magic | budget | result | auth | events | diagnostics | txdata | modified. */
  kind: string;
  /** Human label for the region. */
  label: string;
  start: number;
  end: number;
}

/**
 * Walk the SSIM framing a second time, recording the byte span of each field.
 * Mirrors `decodeSsim` exactly; on any framing error it returns whatever spans
 * it managed to parse (the byte map is a best-effort visualization, never a gate).
 */
export function ssimRegions(bytes: Uint8Array): SsimRegion[] {
  const c = new Cursor(bytes);
  const regions: SsimRegion[] = [];
  const mark = (kind: string, label: string, fn: () => void): void => {
    const start = c.pos();
    fn();
    if (c.pos() > start) regions.push({ kind, label, start, end: c.pos() });
  };
  try {
    mark("magic", 'magic "SSIM0\\0"', () => c.take(SSIM_MAGIC.length));
    mark("budget", "budget · instructions + memory (u32 × 2)", () => {
      c.u32();
      c.u32();
    });
    mark("result", "result (tag + ScVal / error)", () => {
      const tag = c.u8();
      if (tag === 0 || tag === 1) c.lenPrefixed();
    });
    mark("auth", "auth entries", () => readVec(c));
    mark("events", "contract events", () => readVec(c));
    mark("diagnostics", "diagnostic events", () => readVec(c));
    mark("txdata", "transaction data · footprint + fee", () => {
      if (c.u8() === 1) c.lenPrefixed();
    });
    mark("modified", "modified ledger entries", () => {
      const n = c.u32();
      for (let i = 0; i < n; i += 1) {
        readOptionalEntry(c);
        readOptionalEntry(c);
      }
    });
  } catch {
    // best-effort: return the spans parsed so far
  }
  return regions;
}

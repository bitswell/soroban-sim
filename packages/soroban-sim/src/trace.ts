/**
 * STRC trace decoding — the TS mirror of soroban-sim-core's `encode_trace` /
 * `decode_trace` (crates/soroban-sim-core/src/trace.rs).
 *
 * Layout: `STRC0\0` magic (6 bytes), u32 step count, then per step:
 * u32 seq, u8 kind, u32-len-prefixed UTF-8 name, u32-len-prefixed UTF-8
 * display, u64 cpu, u64 mem. All integers big-endian.
 */

/** Magic prefix of an encoded trace ("STRC" + version byte + NUL). */
export const TRACE_MAGIC = new Uint8Array([0x53, 0x54, 0x52, 0x43, 0x30, 0x00]);

/**
 * The kind of a semantic trace step, mirroring soroban-env-host's
 * `TraceEvent` variants. String values match the Rust enum variant names.
 */
export type TraceStepKind =
  | "begin"
  | "push-ctx"
  | "pop-ctx"
  | "env-call"
  | "env-ret"
  | "end";

const KIND_BY_BYTE: readonly TraceStepKind[] = [
  "begin",
  "push-ctx",
  "pop-ctx",
  "env-call",
  "env-ret",
  "end",
];

/** One semantic step of a traced execution. */
export interface TraceStep {
  /** 0-based position of this step in the trace. */
  seq: number;
  /** Which TraceEvent variant produced this step. */
  kind: TraceStepKind;
  /**
   * Short name: the env fn name for env-call/env-ret (e.g. `get_contract_data`),
   * the frame label for push-ctx/pop-ctx (e.g. `VM:c288faf9:add`),
   * `begin`/`end` for begin/end.
   */
  name: string;
  /**
   * The event's full Display rendering, e.g.
   * `push VM:c288faf9:add(I32(40), I32(2))` / `call map_get(...)`.
   */
  display: string;
  /** Cumulative CPU instructions consumed at the time of the event. */
  cpu: bigint;
  /** Cumulative memory bytes consumed at the time of the event. */
  mem: bigint;
}

class TraceDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceDecodeError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Strict decoder for `encode_trace` bytes; rejects bad magic, truncation, and trailing bytes. */
export function decodeTrace(bytes: Uint8Array): TraceStep[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > bytes.length) {
      throw new TraceDecodeError(`trace truncated at offset ${pos}`);
    }
  };
  const u8 = () => {
    need(1);
    return view.getUint8(pos++);
  };
  const u32 = () => {
    need(4);
    const v = view.getUint32(pos);
    pos += 4;
    return v;
  };
  const u64 = () => {
    need(8);
    const v = view.getBigUint64(pos);
    pos += 8;
    return v;
  };
  const str = () => {
    const len = u32();
    need(len);
    const s = utf8.decode(bytes.subarray(pos, pos + len));
    pos += len;
    return s;
  };

  need(TRACE_MAGIC.length);
  for (let i = 0; i < TRACE_MAGIC.length; i += 1) {
    if (bytes[i] !== TRACE_MAGIC[i]) {
      throw new TraceDecodeError("bad trace magic");
    }
  }
  pos = TRACE_MAGIC.length;

  const count = u32();
  const steps: TraceStep[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = u32();
    const kindByte = u8();
    const kind = KIND_BY_BYTE[kindByte];
    if (kind === undefined) {
      throw new TraceDecodeError(`invalid TraceStepKind byte: ${kindByte}`);
    }
    const name = str();
    const display = str();
    const cpu = u64();
    const mem = u64();
    steps.push({ seq, kind, name, display, cpu, mem });
  }
  if (pos !== bytes.length) {
    throw new TraceDecodeError(
      `trailing bytes after trace: ${bytes.length - pos} of ${bytes.length}`,
    );
  }
  return steps;
}

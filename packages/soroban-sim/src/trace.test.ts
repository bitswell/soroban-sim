import { describe, expect, it } from "vitest";
import { decodeTrace, TRACE_MAGIC, type TraceStep } from "./trace.js";

/**
 * Test-side STRC encoder mirroring soroban-sim-core's `encode_trace`
 * (crates/soroban-sim-core/src/trace.rs): magic, u32 count, then per step
 * u32 seq, u8 kind, len-prefixed name, len-prefixed display, u64 cpu, u64 mem.
 * All integers big-endian.
 */
const KIND_BYTE: Record<TraceStep["kind"], number> = {
  begin: 0,
  "push-ctx": 1,
  "pop-ctx": 2,
  "env-call": 3,
  "env-ret": 4,
  end: 5,
};

function encodeTrace(steps: TraceStep[]): Uint8Array {
  const utf8 = new TextEncoder();
  const chunks: Uint8Array[] = [TRACE_MAGIC];
  const u32 = (v: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    return b;
  };
  const u64 = (v: bigint) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v);
    return b;
  };
  chunks.push(u32(steps.length));
  for (const step of steps) {
    chunks.push(u32(step.seq));
    chunks.push(new Uint8Array([KIND_BYTE[step.kind]]));
    for (const s of [step.name, step.display]) {
      const bytes = utf8.encode(s);
      chunks.push(u32(bytes.length), bytes);
    }
    chunks.push(u64(step.cpu), u64(step.mem));
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const STEPS: TraceStep[] = [
  { seq: 0, kind: "begin", name: "begin", display: "begin", cpu: 0n, mem: 0n },
  {
    seq: 1,
    kind: "push-ctx",
    name: "VM:c288faf9:add",
    display: "push VM:c288faf9:add(I32(40), I32(2))",
    cpu: 1234n,
    mem: 567n,
  },
  {
    seq: 2,
    kind: "env-call",
    name: "get_contract_data",
    display: "call get_contract_data(Symbol(k), Persistent)",
    cpu: 2000n,
    mem: 600n,
  },
  {
    seq: 3,
    kind: "env-ret",
    name: "get_contract_data",
    display: "ret get_contract_data -> Ok(I32(7))",
    cpu: 2500n,
    mem: 650n,
  },
  {
    seq: 4,
    kind: "pop-ctx",
    name: "VM:c288faf9:add",
    display: "pop VM:c288faf9:add -> Ok(I32(42))",
    cpu: 3000n,
    mem: 700n,
  },
  {
    seq: 5,
    kind: "end",
    name: "end",
    // Exercise non-ASCII UTF-8 through the len-prefixed strings.
    display: "end → done",
    // Exercise values above Number.MAX_SAFE_INTEGER.
    cpu: 9007199254740993n,
    mem: 18446744073709551615n,
  },
];

describe("decodeTrace", () => {
  it("round-trips an STRC buffer", () => {
    expect(decodeTrace(encodeTrace(STEPS))).toEqual(STEPS);
  });

  it("decodes an empty trace", () => {
    expect(decodeTrace(encodeTrace([]))).toEqual([]);
  });

  it("rejects bad magic", () => {
    const bytes = encodeTrace(STEPS);
    bytes[4] = 0x31; // "STRC1" instead of "STRC0"
    expect(() => decodeTrace(bytes)).toThrow(/bad trace magic/);
  });

  it("rejects truncation", () => {
    const bytes = encodeTrace(STEPS);
    expect(() => decodeTrace(bytes.subarray(0, bytes.length - 1))).toThrow(
      /truncated/,
    );
  });

  it("rejects trailing bytes", () => {
    const bytes = encodeTrace(STEPS);
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 0);
    expect(() => decodeTrace(padded)).toThrow(/trailing bytes/);
  });

  it("rejects an invalid kind byte", () => {
    const bytes = encodeTrace([STEPS[0]!]);
    // Kind byte of the first step sits right after magic + count + seq.
    bytes[TRACE_MAGIC.length + 4 + 4] = 9;
    expect(() => decodeTrace(bytes)).toThrow(/invalid TraceStepKind byte: 9/);
  });

  it("decodes from a non-zero byteOffset view", () => {
    const bytes = encodeTrace(STEPS);
    const shifted = new Uint8Array(bytes.length + 3);
    shifted.set(bytes, 3);
    expect(decodeTrace(shifted.subarray(3))).toEqual(STEPS);
  });
});

/**
 * SSIM0 decoder — a trimmed copy of `packages/soroban-sim/src/differential/
 * decode-ssim.ts`, vendored because that module is internal to the simulator
 * package (only `.` and `./generated` are exported). It mirrors the Rust encoder
 * `encode_simulation_result` in `crates/soroban-sim-core/src/lib.rs`.
 *
 * We read enough of the framing to surface the return ScVal, the metering, and
 * whether transaction data was produced; the remaining vectors are skipped in
 * order so the cursor stays aligned.
 */

const SSIM_MAGIC = [0x53, 0x53, 0x49, 0x4d, 0x30, 0x00];

export interface SsimDecoded {
  simulatedInstructions: number;
  simulatedMemory: number;
  result: { ok: true; scValXdr: Uint8Array } | { ok: false; error: string };
  hasTxData: boolean;
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
  skipVec(): void {
    const count = this.u32();
    for (let i = 0; i < count; i += 1) this.take(this.u32());
  }
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
  let result: SsimDecoded["result"];
  if (tag === 0) {
    result = { ok: true, scValXdr: c.lenPrefixed() };
  } else if (tag === 1) {
    result = { ok: false, error: new TextDecoder().decode(c.lenPrefixed()) };
  } else {
    throw new Error(`SSIM decode: unknown result tag ${tag}`);
  }

  c.skipVec(); // auth
  c.skipVec(); // contract events
  c.skipVec(); // diagnostic events
  const hasTxData = c.u8() === 1;

  return {
    simulatedInstructions,
    simulatedMemory,
    result,
    hasTxData,
  };
}

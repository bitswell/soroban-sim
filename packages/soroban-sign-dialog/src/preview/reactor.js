// The soroban-sim-preview reactor host: loads the wasm32-wasip1 module and
// calls it. Used by the Worker, and directly on the calling thread with
// `inline: true`. The reactor imports a handful of WASI p1 functions; none
// touches a file, the network or real randomness that matters (the host's
// PRNG is seeded from the transaction).

/** source: a URL, or the wasm bytes (an ArrayBuffer or typed array). */
export async function createReactor(source) {
  let exports;
  const view = () => new DataView(exports.memory.buffer);
  const ENOSYS = 52;
  const wasi = new Proxy({
    environ_get: () => 0,
    environ_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
    args_get: () => 0,
    args_sizes_get: (count, size) => { view().setUint32(count, 0, true); view().setUint32(size, 0, true); return 0; },
    clock_time_get: (_id, _precision, ptr) => { view().setBigUint64(ptr, BigInt(Math.round(performance.now() * 1e6)), true); return 0; },
    fd_write: (_fd, iovs, count, written) => {
      const v = view();
      let n = 0;
      for (let i = 0; i < count; i++) n += v.getUint32(iovs + i * 8 + 4, true);
      v.setUint32(written, n, true);
      return 0;
    },
    random_get: (ptr, len) => { crypto.getRandomValues(new Uint8Array(exports.memory.buffer, ptr, len)); return 0; },
    proc_exit: (code) => { throw new Error(`reactor exited (${code})`); },
  }, { get: (t, k) => t[k] ?? (() => ENOSYS) });

  const t0 = performance.now();
  let module;
  if (typeof source === 'string' || source instanceof URL) {
    const url = String(source);
    // compileStreaming needs `application/wasm`; fall back for servers that
    // send another type.
    module = await WebAssembly.compileStreaming(fetch(url))
      .catch(async () => WebAssembly.compile(await (await fetch(url)).arrayBuffer()));
  } else {
    module = await WebAssembly.compile(source);
  }
  const t1 = performance.now();
  ({ exports } = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi }));
  exports._initialize?.();
  const t2 = performance.now();
  const info = { compileMs: t1 - t0, instantiateMs: t2 - t1, hostProtocol: exports.np_host_protocol() };
  return {
    info,
    call(bytes) {
      const p = exports.np_alloc(bytes.length);
      new Uint8Array(exports.memory.buffer, p, bytes.length).set(bytes);
      const r = exports.np_call(p, bytes.length);
      const ptr = Number(r & 0xffffffffn), len = Number(r >> 32n);
      return new Uint8Array(exports.memory.buffer, ptr, len).slice();
    },
  };
}

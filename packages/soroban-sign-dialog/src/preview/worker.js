// Runs the soroban-sim-preview reactor off the main thread. Messages:
// init { url } and call { bytes }, each with an id the reply echoes.
import { createReactor } from './reactor.js';

let reactor;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      reactor = await createReactor(data.url);
      self.postMessage({ id: data.id, ok: true, value: reactor.info });
    } else if (data.type === 'call') {
      const t0 = performance.now();
      const out = reactor.call(data.bytes);
      self.postMessage({ id: data.id, ok: true, value: out, ms: performance.now() - t0 }, [out.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: data.id, ok: false, error: String(err?.message ?? err) });
  }
};

import { runFixture } from "@theahaco/soroban-sim";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const data = bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

self.postMessage({ type: "ready" });

self.onmessage = async () => {
  const started = performance.now();
  const output = runFixture();
  const sha256 = await sha256Hex(output);
  self.postMessage({
    type: "result",
    len: output.length,
    sha256,
    elapsedMs: performance.now() - started,
  });
};

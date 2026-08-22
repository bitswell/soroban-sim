import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const component = `${repoRoot}/target/wasm32-wasip2/release/soroban_sim_component.wasm`;
const golden = JSON.parse(
  readFileSync(`${repoRoot}/fixtures/golden/add_i32.fixture.json`, "utf8"),
);

const stdout = execFileSync(
  "wasmtime",
  ["run", "--invoke", "run-fixture()", component],
  { encoding: "utf8", maxBuffer: 1024 * 1024 },
).trim();
const match = stdout.match(/^ok\(\[(.*)\]\)$/s);
if (!match) {
  throw new Error(`unexpected Wasmtime output: ${stdout.slice(0, 200)}`);
}
const bytes = match[1].trim().length === 0
  ? []
  : match[1].split(",").map((part) => Number(part.trim()));
const output = Buffer.from(bytes);
const sha256 = createHash("sha256").update(output).digest("hex");
if (output.length !== golden.encoded_output_len) {
  throw new Error(`length mismatch: got ${output.length}, want ${golden.encoded_output_len}`);
}
if (sha256 !== golden.encoded_output_sha256) {
  throw new Error(`sha256 mismatch: got ${sha256}, want ${golden.encoded_output_sha256}`);
}
console.log(`wasmtime fixture ok len=${output.length} sha256=${sha256}`);

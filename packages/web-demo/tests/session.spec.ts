import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type BrowserContext, type Page, test } from "@playwright/test";
import { Account, Keypair, Networks, Operation, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

/**
 * Network sessions in the browser, offline: the fork's RPC reads are answered
 * from a recording of testnet (tests/fixtures/testnet-fork.json, captured by
 * scripts/capture-session-fixture.mjs). Every key the recording lacks reads
 * as absent, as it does on the network for a fresh throwaway account or a
 * never-uploaded Wasm. Transactions go through the page's virtual RPC (the
 * service worker) into the session; nothing reaches a network.
 */

const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
const repo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));

interface Recording {
  getNetwork: { passphrase: string; protocolVersion: number };
  getLatestLedger: { sequence: number; protocolVersion: number; headerXdr: string; id: string };
  entries: Array<{ key: string; xdr: string; lastModifiedLedgerSeq: number; liveUntilLedgerSeq?: number }>;
}

const testnetFork = (): Recording =>
  JSON.parse(readFileSync(new URL("./fixtures/testnet-fork.json", import.meta.url), "utf8")) as Recording;

/** Answer `url`'s JSON-RPC from `recording`; returns the methods it was asked. */
async function recordedRpc(context: BrowserContext, url: string, recording: Recording): Promise<string[]> {
  const asked: string[] = [];
  const entries = new Map(recording.entries.map((e) => [e.key, e]));
  await context.route(`${url}/**`, async (route) => {
    const call = route.request().postDataJSON() as { id: unknown; method: string; params?: { keys?: string[] } };
    asked.push(call.method);
    const latest = recording.getLatestLedger.sequence;
    const result =
      call.method === "getNetwork"
        ? recording.getNetwork
        : call.method === "getLatestLedger"
          ? recording.getLatestLedger
          : call.method === "getLedgerEntries"
            ? { latestLedger: latest, entries: (call.params?.keys ?? []).flatMap((k) => entries.get(k) ?? []) }
            : undefined;
    const body = result
      ? { jsonrpc: "2.0", id: call.id, result }
      : { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: `not recorded: ${call.method}` } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  return asked;
}

async function fork(page: Page, network: "testnet" | "mainnet"): Promise<void> {
  await page.goto("/");
  await page.locator("#session-network").selectOption(network);
  await expect(page.locator("#session-start")).toBeEnabled();
  await page.locator("#session-start").click();
  await expect(page.locator("#session-state")).toContainText("open:", { timeout: 60_000 });
}

/** One JSON-RPC call to the session's virtual RPC URL, from the page. */
async function virtualRpc(page: Page, method: string, params: unknown = {}): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const url = (await page.locator("#session-rpc").textContent())!;
  return page.evaluate(
    async ({ url, method, params }) => {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      return r.json();
    },
    { url, method, params },
  );
}

const step = (page: Page, n: number) => page.locator(`#session-steps li[data-step="${n}"]`);

test("a two-step dependent sequence runs on a recorded testnet fork and survives a reload", async ({ page, context }) => {
  test.setTimeout(180_000);
  const recording = testnetFork();
  const asked = await recordedRpc(context, TESTNET_RPC, recording);
  await fork(page, "testnet");
  await expect(page.locator("#session-state")).toContainText(`testnet at ledger ${recording.getLatestLedger.sequence}`);
  await expect(page.locator("#session-pill")).toHaveText("testnet fork");
  await expect(page.locator("#session-mainnet-warning")).toBeHidden();
  await expect(step(page, 1)).toContainText("throwaway fee payer");

  // The plan runs through stellar-sdk pointed at the virtual RPC URL: the
  // deploy needs step 3's upload, the call needs step 4's instance, and the
  // first deploy (before the upload) is refused in simulation.
  await page.locator("#session-plan-file").setInputFiles([
    repo("examples/session/two-step-add.yaml"),
    repo("fixtures/contracts/add_i32.wasm"),
  ]);
  await expect(page.locator("#session-plan-status")).toContainText("all as expected", { timeout: 120_000 });
  await expect(page.locator("#session-steps li")).toHaveCount(5);
  await expect(page.locator("#session-step-count")).toHaveText("5 steps · 3 transactions");
  for (const n of [3, 4, 5]) await expect(step(page, n)).toHaveAttribute("data-outcome", "applied");

  // The same contract `soroban-sim session run` derives over the same fork
  // (crates/soroban-sim-cli/tests/plan_run.rs).
  const add = "CDGPQAE2PZSEDRAYUAZMKIB7NXM3IOP3BQACPGPANKLK3BP6OBPADKRW";
  await expect(step(page, 4)).toContainText(`deploy ${add}`);
  await step(page, 4).locator(".session-step-head").click();
  await expect(step(page, 4)).toContainText("created · ContractData");
  await expect(step(page, 4)).toContainText("FEES (XLM) AND RESOURCES", { ignoreCase: true });
  await expect(step(page, 4)).toContainText("source account");
  await step(page, 5).locator(".session-step-head").click();
  await expect(step(page, 5)).toContainText(`${add}.add`);
  await expect(step(page, 5).locator(".session-step-body")).toContainText("42");

  // Any step opens in the time-travel debugger.
  await step(page, 5).getByRole("button", { name: "open in time-travel debugger" }).click();
  await expect(page.locator("#debugger")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator("#dbg-reason")).toBeHidden();
  await expect(page.locator("#dbg-count")).toContainText("semantic steps");
  await expect(page.locator("#dbg-tree")).toContainText("add");

  // stellar-rpc answers from the session itself.
  const latest = await virtualRpc(page, "getLatestLedger");
  expect(latest.result?.sequence).toBe(recording.getLatestLedger.sequence + 3);
  const network = await virtualRpc(page, "getNetwork");
  expect(network.result?.passphrase).toBe(Networks.TESTNET);

  await expect(page.locator("#session-verdict")).toHaveText("passed");
  await expect(page.locator("#session-report-body")).toContainText("Overrides (2)");
  await expect(page.locator("#session-replayable")).toBeHidden();

  // A reload replays the IndexedDB log over the cached fork: same steps, and
  // no base read goes to the network.
  const before = asked.length;
  await page.reload();
  await expect(page.locator("#session-progress")).toContainText("Resumed: replayed", { timeout: 60_000 });
  await expect(page.locator("#session-steps li")).toHaveCount(5);
  await expect(step(page, 5)).toHaveAttribute("data-outcome", "applied");
  expect(asked.slice(before)).toEqual([]);
});

test("plan steps sign classic authorization entries with throwaway keys", async ({ page, context }) => {
  test.setTimeout(120_000);
  await recordedRpc(context, TESTNET_RPC, testnetFork());
  await fork(page, "testnet");
  await page.locator("#session-plan-file").setInputFiles(fileURLToPath(new URL("./fixtures/classic-auth.yaml", import.meta.url)));
  await expect(page.locator("#session-plan-status")).toContainText("all as expected", { timeout: 60_000 });
  // payer override, two funding overrides, the SAC deploy, the transfer.
  await expect(page.locator("#session-steps li")).toHaveCount(5);
  await expect(step(page, 5)).toHaveAttribute("data-outcome", "applied");
  await step(page, 5).locator(".session-step-head").click();
  // alice's entry is an address credential (stellar-sdk signs the CAP-71 v2
  // arm) carrying her throwaway signature; carol signed the envelope.
  const alice = "GBEFICSBULGI6ZIMM36MCGPLBWQUKAD6JYNR6N3WQD2JOK6BLP4C7F2J";
  await expect(step(page, 5).locator(".session-step-body")).toContainText(`address_v2 ${alice} · signed`);
  await expect(page.locator("#session-verdict")).toHaveText("passed");
});

test("the wallet pre-submit flow submits into the session through the virtual RPC", async ({ page, context }) => {
  test.setTimeout(180_000);
  const asked = await recordedRpc(context, TESTNET_RPC, testnetFork());
  await fork(page, "testnet");
  const payer = (await page.locator("#session-payer").textContent())!;
  // With a session open, the local identity is the session's throwaway payer.
  await expect(page.locator("#local-identity-address")).toHaveText(payer);
  await expect(page.locator(".identity-card .network-pill")).toHaveText("testnet session");

  // The workbench's guided call, preflighted locally as before.
  await page.locator("#load-contract").click();
  await expect(page.locator("#contract-fn")).toBeVisible({ timeout: 60_000 });
  await page.locator("#contract-fn").selectOption("update_message");
  await expect(page.locator('#contract-args input[data-arg="author"]')).toHaveValue(payer);
  await page.locator("#run").click();
  await expect(page.locator("#review-submit")).toBeEnabled({ timeout: 120_000 });

  await page.locator("#review-submit").click();
  await expect(page.locator("#submit-target")).toBeVisible();
  await expect(page.locator('#submit-target input[value="session"]')).toBeChecked();
  await expect(page.locator("#submit-warning")).toContainText("Nothing is broadcast");
  await expect(page.locator("#replay-warning")).toBeHidden();
  await expect(page.locator("#confirm-submit")).toHaveText("Sign with the throwaway key & submit into the session");
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#submit-progress")).toContainText("Applied in the session", { timeout: 60_000 });
  await page.locator("#submit-dialog .dialog-close").click();

  await expect(step(page, 2)).toHaveAttribute("data-outcome", "applied");
  await expect(step(page, 2)).toContainText("update_message");
  await step(page, 2).locator(".session-step-head").click();
  // The contract instance and code are archived on testnet: the call restored them.
  await expect(step(page, 2).locator(".session-step-body")).toContainText("restored · ContractCode");
  await expect(step(page, 2).locator(".session-step-body")).toContainText("created · ContractData");
  expect(asked).not.toContain("sendTransaction");
});

/** A Mainnet recording whose base holds an account the test has the real key of. */
function mainnetWithRealAccount(real: Keypair): { recording: Recording; seq: bigint } {
  const recording = testnetFork();
  const seq = BigInt(recording.getLatestLedger.sequence - 10) << 32n;
  const account = xdr.LedgerEntryData.account(
    new xdr.AccountEntry({
      accountId: real.xdrAccountId(),
      balance: xdr.Int64.fromString("5000000000"),
      seqNum: xdr.Int64.fromString(seq.toString()),
      numSubEntries: 0,
      inflationDest: null,
      flags: 0,
      homeDomain: "",
      thresholds: Buffer.from([1, 0, 0, 0]),
      signers: [],
      ext: xdr.AccountEntryExt.v0(),
    }),
  );
  const key = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: real.xdrAccountId() }));
  return {
    seq,
    recording: {
      ...recording,
      getNetwork: { ...recording.getNetwork, passphrase: Networks.PUBLIC },
      entries: [...recording.entries, { key: key.toXdr("base64"), xdr: account.toXdr("base64"), lastModifiedLedgerSeq: recording.getLatestLedger.sequence - 10 }],
    },
  };
}

test("a real mainnet signer's envelope is refused with a replay warning", async ({ page, context }) => {
  test.setTimeout(120_000);
  // A mainnet fork whose base holds an account the test has the real key of.
  const real = Keypair.random();
  const { recording, seq } = mainnetWithRealAccount(real);
  await recordedRpc(context, MAINNET_RPC, recording);
  await fork(page, "mainnet");
  await expect(page.locator("#session-pill")).toHaveText("mainnet fork");
  await expect(page.locator("#session-mainnet-warning")).toBeVisible();
  await expect(page.locator("#session-mainnet-warning")).toContainText("valid on Mainnet");

  // An upload the real key signs, prepared against the session.
  const wasm = readFileSync(repo("fixtures/contracts/add_i32.wasm"));
  const upload = (fee: string) =>
    new TransactionBuilder(new Account(real.publicKey(), seq.toString()), { fee, networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.uploadContractWasm({ wasm }))
      .setTimeout(0);
  const sim = await virtualRpc(page, "simulateTransaction", { transaction: upload("100").build().toEnvelope().toXdr("base64") });
  expect(sim.error).toBeUndefined();
  // The resource fee goes on top of the inclusion fee, as stellar-sdk assembles it.
  const prepared = upload(String(100 + Number(sim.result!.minResourceFee)))
    .setSorobanData(String(sim.result!.transactionData))
    .build();
  prepared.sign(real);

  await page.locator(".session-envelope summary").click();
  await page.locator("#session-envelope").fill(prepared.toEnvelope().toXdr("base64"));
  await page.locator("#session-envelope-submit").click();
  await expect(page.locator("#session-err")).toContainText("valid on mainnet", { timeout: 60_000 });
  await expect(step(page, 2)).toHaveAttribute("data-outcome", "refused");
  await expect(page.locator("#session-replayable")).toBeVisible();
  await expect(page.locator("#session-replayable")).toContainText("valid on the real network");
  await expect(page.locator("#session-verdict")).toContainText("FAILED");
});

test("a real wallet signing into a mainnet session must acknowledge the replay warning", async ({ page, context }) => {
  test.setTimeout(180_000);
  const real = Keypair.random();
  await recordedRpc(context, TESTNET_RPC, testnetFork());
  await recordedRpc(context, MAINNET_RPC, mainnetWithRealAccount(real).recording);
  // A stand-in for the wallet module the page loads on demand: it connects
  // the account above and signs with its real key, here in the test.
  await page.exposeFunction("__testWalletSign", (envelope: string, passphrase: string) => {
    const tx = TransactionBuilder.fromXdr(envelope, passphrase);
    tx.sign(real);
    return tx.toEnvelope().toXdr("base64");
  });
  await page.route("**/src/wallet.ts*", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `
        export const NIDO_ID = "nido";
        export async function connectWallet() { return { address: ${JSON.stringify(real.publicKey())}, id: "test", name: "Test wallet" }; }
        export async function disconnectWallet() {}
        export async function signWithWallet(xdr, address, passphrase) {
          return { signedTxXdr: await window.__testWalletSign(xdr, passphrase), signerAddress: address };
        }`,
    }),
  );
  await fork(page, "mainnet");
  await page.locator("#identity-wallet").click();
  await page.locator("#connect-wallet").click();
  await expect(page.locator("#wallet-address")).toHaveText(real.publicKey());

  await page.locator("#load-contract").click();
  await expect(page.locator("#contract-fn")).toBeVisible({ timeout: 60_000 });
  await page.locator("#contract-fn").selectOption("update_message");
  await expect(page.locator('#contract-args input[data-arg="author"]')).toHaveValue(real.publicKey());
  await page.locator("#run").click();
  await expect(page.locator("#review-submit")).toBeEnabled({ timeout: 120_000 });
  await page.locator("#review-submit").click();

  // The warning names Mainnet and the real account; signing waits for it.
  await expect(page.locator("#replay-warning")).toBeVisible();
  await expect(page.locator("#replay-warning-text")).toContainText("valid on Mainnet");
  await expect(page.locator("#replay-warning-text")).toContainText("your real account");
  await expect(page.locator("#confirm-submit")).toBeDisabled();
  await page.locator("#replay-ack").check();
  await expect(page.locator("#confirm-submit")).toHaveText("Sign with the real wallet & submit into the session");
  await page.locator("#confirm-submit").click();
  await expect(page.locator("#submit-progress")).toContainText("Applied in the session", { timeout: 60_000 });
  await page.locator("#submit-dialog .dialog-close").click();

  // The session allowed it only after the acknowledgement, and the report
  // keeps the signature under Safety and fails.
  await expect(step(page, 2)).toContainText("fork_allowRealSigners");
  await expect(step(page, 3)).toHaveAttribute("data-outcome", "applied");
  await expect(page.locator("#session-replayable")).toBeVisible();
  await expect(page.locator("#session-replayable")).toContainText(real.publicKey());
  await expect(page.locator("#session-verdict")).toContainText("FAILED");
});

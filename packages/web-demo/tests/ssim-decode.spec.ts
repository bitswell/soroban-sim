import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { ADD_I32_SSIM_B64, SAC_TRANSFER_SSIM_B64 } from "./ssim-samples.js";

/**
 * Unit-test the vendored SSIM0 decoder (`src/ssim.ts`) and the worker-side label
 * layer (`src/decode.ts`) against real, deterministic component payloads — run in
 * the browser via the Vite dev server so the exact production modules (and the
 * real `@stellar/stellar-sdk`) are exercised, with no wasm needed at test time.
 *
 * This complements, and must NOT weaken, the golden byte gate in
 * `fixture-worker.spec.ts` (388 bytes).
 */

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/golden/add_i32.fixture.json", import.meta.url)),
    "utf8",
  ),
) as { encoded_output_len: number };

/** Decode a base64 SSIM payload in the page and return a JSON-serializable summary. */
async function decodeInPage(page: import("@playwright/test").Page, b64: string) {
  return page.evaluate(async (input: string) => {
    // Variable specifiers so tsc does not try to resolve these browser-only,
    // Vite-served module paths at type-check time.
    const ssimPath = "/src/ssim.ts";
    const decodePath = "/src/decode.ts";
    const { decodeSsim } = await import(/* @vite-ignore */ ssimPath);
    const {
      footprintLabels,
      contractEventLabel,
      authLabel,
      scValLabel,
      ledgerChangeLabel,
    } = await import(/* @vite-ignore */ decodePath);
    const bin = atob(input);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);

    const d = decodeSsim(bytes);
    const fp = d.transactionData ? footprintLabels(d.transactionData) : undefined;
    return {
      instructions: d.simulatedInstructions,
      memory: d.simulatedMemory,
      authCount: d.auth.length,
      eventCount: d.contractEvents.length,
      diagnosticCount: d.diagnosticEvents.length,
      hasTxData: d.transactionData !== undefined,
      modifiedCount: d.modifiedEntries.length,
      stateChanges: d.modifiedEntries.map(
        (change: { before?: Uint8Array; after?: Uint8Array }) =>
          ledgerChangeLabel(change.before, change.after),
      ),
      resultOk: d.result.ok,
      scVal: d.result.ok ? scValLabel(d.result.scValXdr) : undefined,
      footprint: fp && {
        readOnly: fp.readOnly.map((k: { label: string }) => k.label),
        readWrite: fp.readWrite.map((k: { label: string }) => k.label),
        readOnlyKeys: fp.readOnly.map(
          (k: { role?: string; key?: string; detail: string }) => ({
            role: k.role,
            key: k.key,
            detail: k.detail,
          }),
        ),
        readWriteKeys: fp.readWrite.map(
          (k: { role?: string; key?: string; detail: string }) => ({
            role: k.role,
            key: k.key,
            detail: k.detail,
          }),
        ),
        instructions: fp.instructions,
        readBytes: fp.readBytes,
        writeBytes: fp.writeBytes,
        resourceFee: fp.resourceFee,
      },
      auth: d.auth.map((a: Uint8Array) => authLabel(a)),
      events: d.contractEvents.map((e: Uint8Array) => contractEventLabel(e)),
    };
  }, b64);
}

test.describe("SSIM decode + label layer", () => {
  test("decodes a ContractData storage value", async ({ page }) => {
    const entry = new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 123,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: xdr.ExtensionPoint.v0(),
          contract: Address.fromString(
            "CBXVJXHPSYORSAHPX4I6NYPQMDJWK2STQCE6JTIM7FNV4OZSIDJFGNDM",
          ).toScAddress(),
          key: xdr.ScVal.scvSymbol("Message"),
          durability: xdr.ContractDataDurability.fromName("persistent"),
          val: nativeToScVal("Hello from contract storage", { type: "string" }),
        }),
      ),
      ext: xdr.LedgerEntryExt.v0(),
    });
    const b64 = entry.toXdr("base64");

    await page.goto("/");
    const value = await page.evaluate(async (encoded: string) => {
      const decodePath = "/src/decode.ts";
      const { contractDataValueLabel } = await import(
        /* @vite-ignore */ decodePath
      );
      const bin = atob(encoded);
      const bytes = Uint8Array.from(bin, (char) => char.charCodeAt(0));
      return contractDataValueLabel(bytes);
    }, b64);

    expect(value).toEqual({
      type: "String",
      display: "Hello from contract storage",
    });
  });

  test("decodes the add_i32 golden: budget > 0 and a non-empty footprint", async ({
    page,
  }) => {
    await page.goto("/");
    const s = await decodeInPage(page, ADD_I32_SSIM_B64);

    // Budget metering the host actually consumed.
    expect(s.instructions).toBeGreaterThan(0);
    expect(s.memory).toBeGreaterThan(0);

    // The return value decodes to I32 · 42.
    expect(s.resultOk).toBe(true);
    expect(s.scVal?.type).toBe("I32");
    expect(s.scVal?.display).toBe("42");

    // Footprint present and non-empty (read-only: ContractData + ContractCode).
    expect(s.hasTxData).toBe(true);
    expect(s.footprint).toBeTruthy();
    expect(s.footprint!.readOnly.length).toBeGreaterThan(0);
    expect(s.footprint!.readOnly.join(" ")).toContain("ContractData");
    expect(s.footprint!.readOnly.join(" ")).toContain("ContractCode");
    expect(s.footprint!.readOnlyKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "contract-instance",
          key: "Contract instance",
        }),
        expect.objectContaining({ role: "contract-code" }),
      ]),
    );
    expect(
      s.footprint!.readOnlyKeys.find(
        (key: { role?: string }) => key.role === "contract-instance",
      )?.detail,
    ).toMatch(/^C[A-Z2-7]{5}…[A-Z2-7]{6} · persistent$/);
    expect(s.footprint!.instructions).toBeGreaterThan(0);

    // Framing fully consumed (decodeSsim throws on trailing bytes) — sanity on
    // the diagnostic/diff tail the trimmed decoder used to skip.
    expect(s.diagnosticCount).toBeGreaterThanOrEqual(0);
  });

  test("decodes SAC transfer: auth + contract event + read-write footprint", async ({
    page,
  }) => {
    await page.goto("/");
    const s = await decodeInPage(page, SAC_TRANSFER_SSIM_B64);

    // Auth entry: a single source-account-credentialed `transfer` invocation.
    expect(s.authCount).toBe(1);
    expect(s.auth[0]!.credentials).toBe("SourceAccount");
    expect(s.auth[0]!.fn).toBe("transfer");
    expect(s.auth[0]!.contract).toMatch(/^C[A-Z2-7]+$/);

    // Contract event: a `transfer` topic with a decoded amount.
    expect(s.eventCount).toBe(1);
    expect(s.events[0]!.type).toBe("contract");
    expect(s.events[0]!.topics).toContain("transfer");

    // Read-write footprint touched (the two account balance entries).
    expect(s.footprint!.readWrite.length).toBeGreaterThan(0);
    expect(
      s.footprint!.readWriteKeys.every(
        (key: { role?: string }) =>
          key.role !== "contract-instance" && key.role !== "contract-code",
      ),
    ).toBe(true);
    expect(s.footprint!.readBytes).toBeGreaterThan(0);
    expect(s.footprint!.writeBytes).toBeGreaterThan(0);
    expect(Number(s.footprint!.resourceFee)).toBeGreaterThan(0);

    // Transaction-wide writes are decoded as educational before/after rows.
    expect(s.stateChanges.length).toBeGreaterThan(0);
    expect(s.stateChanges.some((change: { kind: string }) => change.kind === "Account")).toBe(
      true,
    );
    expect(
      s.stateChanges.every((change: { change: string }) =>
        ["created", "updated", "deleted"].includes(change.change),
      ),
    ).toBe(true);
  });
});

// Guard: the golden length constant the byte gate depends on is unchanged.
test("golden fixture length is still 388", () => {
  expect(golden.encoded_output_len).toBe(388);
  expect(atob(ADD_I32_SSIM_B64).length).toBe(golden.encoded_output_len);
});

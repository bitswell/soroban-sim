import { expect, test } from "@playwright/test";

test("present contract reads show their decoded value", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWorker {
      onmessage: ((event: { data: unknown }) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;

      constructor() {
        (window as unknown as { testWorker: FakeWorker }).testWorker = this;
        setTimeout(() => this.onmessage?.({ data: { type: "ready" } }), 0);
      }

      postMessage(): void {}
      terminate(): void {}
    }

    Object.defineProperty(window, "Worker", {
      configurable: true,
      value: FakeWorker,
    });
  });

  await page.goto("/");
  await page.evaluate(() => {
    const worker = (window as unknown as {
      testWorker: {
        onmessage: ((event: { data: unknown }) => void) | null;
      };
    }).testWorker;
    worker.onmessage?.({
      data: {
        type: "round",
        id: 0,
        roundIndex: 1,
        rerunCount: 1,
        requestedKeyCount: 1,
        roundMs: 1,
        keys: [
          {
            label: "ContractData Message · CBXVJX…JFGNDM · persistent",
            kind: "ContractData",
            detail: "Message · CBXVJX…JFGNDM · persistent",
            role: "contract-storage",
            key: "Message",
            status: "present",
            ttl: 4_500_000,
            value: {
              type: "String",
              display: "Hello from contract storage",
            },
          },
        ],
      },
    });
  });

  await expect(page.locator("#timeline .rvalue")).toContainText("read value");
  await expect(page.locator("#timeline .rvalue")).toContainText(
    "String · Hello from contract storage",
  );
  await expect(page.locator("#snap-list .s-value")).toContainText(
    "String · Hello from contract storage",
  );
});

test.describe("deployed contract / XDR workbench", () => {
  test("creates one disposable Testnet identity and keeps its secret out of the UI", async ({
    page,
  }) => {
    await page.goto("/");
    const address = await page.locator("#local-identity-address").textContent();
    expect(address).toMatch(/^G[A-Z2-7]+$/);
    await expect(page.locator("#review-submit")).toBeDisabled();
    await expect(page.locator("#submission-boundary")).toContainText(
      "No wallet prompt or network submission",
    );

    const secret = await page.evaluate(() => {
      const raw = localStorage.getItem("soroban-sim.testnet-identity.v1");
      return raw ? (JSON.parse(raw) as { secret: string }).secret : "missing";
    });
    expect(secret).toMatch(/^S[A-Z2-7]+$/);
    await expect(page.locator("body")).not.toContainText(secret);

    await page.reload();
    await expect(page.locator("#local-identity-address")).toHaveText(address!);
    await page.locator("#identity-wallet").click();
    await expect(page.locator("#wallet-identity-view")).toContainText("Nido");
    await expect(page.locator("#wallet-identity-view")).toContainText(
      "local G-account remains the fee payer",
    );
  });

  test("defaults to a guided Testnet contract call and explains local execution", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#request-contract")).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#contract-id")).toHaveValue(/^C[A-Z2-7]+$/);
    await expect(page.locator("#mode-live")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#mode-live")).toBeDisabled();
    await expect(page.locator("#run")).toBeDisabled();
    await expect(page.locator(".mode-help")).toContainText(
      "Contract execution always stays in this browser",
    );

    await expect(page.locator("#golden")).toHaveCount(0);
    await page.getByText("How browser execution works", { exact: true }).click();
    const explainer = page.locator(".explainer");
    const executionMap = page.locator(".browser-execution-map");
    await expect(explainer).toContainText("RPC supplies state");
    await expect(executionMap).toContainText("It does not execute the contract");
    await expect(executionMap).toContainText("Run Soroban locally");
    await expect(executionMap).toContainText(
      "Use this in place of RPC simulateTransaction during local development",
    );
    await expect(executionMap).toContainText("Only after “Review sign & submit”");
    await expect(executionMap).toContainText("Sign the envelope");
    await expect(executionMap).toContainText("Broadcast to Testnet");
  });

  test("rejects malformed contract ids before making an RPC request", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#load-contract")).toBeEnabled({ timeout: 60_000 });
    await page.locator("#contract-id").fill("not-a-contract");
    await page.locator("#load-contract").click();
    await expect(page.locator("#contract-err")).toContainText("C… contract address");
    await expect(page.locator("#run")).toBeDisabled();
  });

  test("rejects malformed transaction XDR locally", async ({ page }) => {
    await page.goto("/");
    await page.locator("#request-xdr").click();
    await page.locator("#transaction-xdr").fill("not-base64-xdr");
    await expect(page.locator("#run")).toBeEnabled({ timeout: 60_000 });
    await page.locator("#run").click();
    await expect(page.locator("#result-panel")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("#r-value")).toContainText("simulation failed");
    await expect(page.locator("#r-err")).toBeVisible();
  });
});

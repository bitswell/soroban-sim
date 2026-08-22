import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const golden = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../fixtures/golden/add_i32.fixture.json", import.meta.url)),
    "utf8",
  ),
) as { encoded_output_len: number; encoded_output_sha256: string };

test("Jco simulator component runs in a browser Worker", async ({ page }) => {
  await page.goto("/");
  const result = page.locator("#result");
  await expect(result).toHaveAttribute("data-status", "done", { timeout: 60_000 });
  const payload = JSON.parse((await result.textContent()) ?? "{}");
  expect(payload.len).toBe(golden.encoded_output_len);
  expect(payload.sha256).toBe(golden.encoded_output_sha256);
  expect(payload.elapsedMs).toBeGreaterThanOrEqual(0);
});

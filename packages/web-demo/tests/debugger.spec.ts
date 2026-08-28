import { expect, test } from "@playwright/test";

// The first Worker on a fresh macOS CI runner must compile the embedded 3 MB
// component. Once Chromium caches that compilation, subsequent pages start in
// milliseconds; allow the cold debugger test to pay that one-time cost.
const COLD_WORKER_TIMEOUT = 120_000;

/**
 * Execution trace — offline, deterministic. After a completed run the worker
 * stashes the accumulated entries; "Open execution trace" re-invokes the
 * two-pass `simulate-trace` export (enforcing replay under the tracing host) and the UI
 * renders a semantic view over the recorded TraceEvents plus the
 * fn_call/fn_return call tree. Raw host calls remain opt-in.
 */

async function runFixtureAndOpenDebugger(
  page: import("@playwright/test").Page,
  fixtureName?: RegExp,
): Promise<void> {
  await page.goto("/");
  await page.locator("#advanced-inputs summary").click();
  await page
    .getByRole("button", { name: fixtureName ?? /add_i32/ })
    .click();
  await expect(page.locator("#run")).toBeEnabled({ timeout: COLD_WORKER_TIMEOUT });
  await page.locator("#run").click();
  await expect(page.locator("#result-panel")).toBeVisible({ timeout: 60_000 });

  const debugBtn = page.locator("#debug-run");
  await expect(debugBtn).toBeVisible({ timeout: 10_000 });
  await debugBtn.click();
  await expect(page.locator("#debugger")).toBeVisible({ timeout: 60_000 });
}

test.describe("execution trace (offline)", () => {
  test("add_i32: trace replays with steps, frame push, and budget attribution", async ({
    page,
  }, testInfo) => {
    testInfo.setTimeout(180_000);
    await runFixtureAndOpenDebugger(page);

    // Enforcing replay succeeded — no degraded-mode banner, scrubber visible.
    await expect(page.locator("#dbg-reason")).toBeHidden();
    await expect(page.locator("#dbg-scrub")).toBeVisible();

    // A real trace: begin + frame push/pop + end at minimum.
    const ticks = await page.locator("#dbg-ticks .dtick").count();
    expect(ticks).toBeGreaterThanOrEqual(4);
    await expect(page.locator("#dbg-count")).toContainText("semantic steps");

    // Host-boundary noise is hidden by default and available on demand.
    expect(
      await page.locator("#dbg-ticks .dtick.env-call:not(.storage)").count(),
    ).toBe(0);
    const semanticTicks = ticks;
    await page.locator("#dbg-raw").check();
    await expect(page.locator("#dbg-count")).toContainText("raw steps");
    expect(await page.locator("#dbg-ticks .dtick").count()).toBeGreaterThanOrEqual(
      semanticTicks,
    );
    await page.locator("#dbg-raw").uncheck();

    // Step 1 is `begin`; stepping lands on the VM frame push with decoded args.
    await expect(page.locator("#dbg-display")).toHaveText("begin");
    await page.locator("#dbg-fwd").click();
    await page.locator("#dbg-fwd").click();
    await expect(page.locator("#dbg-pos")).toContainText("step 3");
    await expect(page.locator("#dbg-display")).toContainText("add(");

    // Scrub to the end: cumulative CPU is the run's total (> 0).
    const max = await page.locator("#dbg-slider").getAttribute("max");
    await page.locator("#dbg-slider").fill(String(max));
    await page.locator("#dbg-slider").dispatchEvent("input");
    const cpu = await page.locator("#dbg-cpu-num").textContent();
    expect(Number((cpu ?? "0").replace(/,/g, ""))).toBeGreaterThan(0);

    // Tier-1 call tree has the root frame with decoded args and return.
    const frames = page.locator("#dbg-tree .tree-frame");
    expect(await frames.count()).toBeGreaterThanOrEqual(1);
    await expect(frames.first()).toContainText("add");
  });

  test("SAC transfer: storage ops populate the ledger lane and run-to-storage works", async ({
    page,
  }) => {
    await runFixtureAndOpenDebugger(page, /SAC — transfer/);

    await expect(page.locator("#dbg-scrub")).toBeVisible();
    await expect(page.locator("#dbg-count")).toContainText("storage ops");

    const semanticTicks = await page.locator("#dbg-ticks .dtick").count();
    await page.locator("#dbg-raw").check();
    expect(await page.locator("#dbg-ticks .dtick").count()).toBeGreaterThan(
      semanticTicks,
    );
    await page.locator("#dbg-raw").uncheck();

    // The transfer touches contract storage — lane marks exist.
    const laneMarks = await page.locator("#dbg-lane .lane-mark").count();
    expect(laneMarks).toBeGreaterThan(0);

    // run-to-storage jumps to a storage env-call.
    const storageBtn = page.locator("#dbg-storage-btn");
    await expect(storageBtn).toBeEnabled();
    await storageBtn.click();
    await expect(page.locator("#dbg-display")).toContainText("contract_data");
    await expect(page.locator("#dbg-kind")).toContainText("storage");
  });
});

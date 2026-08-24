import "./styles.css";
import {
  FIXTURES,
  fixtureById,
  LIVE_FIXTURE_ID,
} from "./fixtures.js";
import type {
  DebugResultMsg,
  DemoMode,
  RoundMsg,
  UploadFnInfo,
  UploadInfoMsg,
  WorkerToMain,
} from "./protocol.js";

/** The committed add_i32 golden the CI gate and native runner also produce. */
const GOLDEN_LEN = 388;
const GOLDEN_SHA = "1082a3e46e6b702d61c740fd9151067a65054d63bc63f9bda6535de1c045263f";

// ---- element handles -------------------------------------------------------
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const resultPre = $<HTMLPreElement>("result");
const fixturesEl = $("fixtures");
const reqNote = $("req-note");
const cacheRow = $("cache-row");
const cacheBox = $<HTMLInputElement>("cache");
const runBtn = $<HTMLButtonElement>("run");
const modeOffline = $<HTMLButtonElement>("mode-offline");
const modeLive = $<HTMLButtonElement>("mode-live");
const themeBtn = $<HTMLButtonElement>("theme");

const timeline = $("timeline");
const timelineScroll = $("timeline-scroll");
const timelineEmpty = $("timeline-empty");
const mRounds = $("m-rounds");
const mKeys = $("m-keys");
const mElapsed = $("m-elapsed");
const mWorker = $("m-worker");

const snapList = $("snap-list");
const snapEmpty = $("snap-empty");
const snapPresent = $("snap-present");
const snapAbsent = $("snap-absent");

const resultPanel = $("result-panel");
const rValue = $("r-value");
const rLen = $("r-len");
const rSha = $("r-sha");
const rBadge = $("r-badge");
const rErr = $("r-err");
const resultNote = $("result-note");

const golden = $("golden");
const goldenText = $("golden-text");

// upload-any-contract
const uploadFile = $<HTMLInputElement>("upload-file");
const uploadBtn = $<HTMLButtonElement>("upload-btn");
const uploadCard = $("upload-card");
const upName = $("up-name");
const upSize = $("up-size");
const upCid = $("up-cid");
const upLadder = $("up-ladder");
const upFnRow = $("up-fn-row");
const upFn = $<HTMLSelectElement>("up-fn");
const upFnFree = $<HTMLInputElement>("up-fn-free");
const upArgs = $("up-args");
const upErr = $("up-err");

// visual debugger
const debugRunBtn = $<HTMLButtonElement>("debug-run");
const debuggerEl = $("debugger");
const dbgReason = $("dbg-reason");
const dbgScrub = $("dbg-scrub");
const dbgCount = $("dbg-count");
const dbgTicks = $("dbg-ticks");
const dbgSlider = $<HTMLInputElement>("dbg-slider");
const dbgLane = $("dbg-lane");
const dbgBack = $<HTMLButtonElement>("dbg-back");
const dbgFwd = $<HTMLButtonElement>("dbg-fwd");
const dbgOver = $<HTMLButtonElement>("dbg-over");
const dbgStorageBtn = $<HTMLButtonElement>("dbg-storage-btn");
const dbgDetail = $("dbg-detail");
const dbgPos = $("dbg-pos");
const dbgDisplay = $("dbg-display");
const dbgKind = $("dbg-kind");
const dbgName = $("dbg-name");
const dbgDcpu = $("dbg-dcpu");
const dbgDmem = $("dbg-dmem");
const dbgCpuNum = $("dbg-cpu-num");
const dbgCpuFill = $("dbg-cpu-fill");
const dbgCpuScale = $("dbg-cpu-scale");
const dbgMemNum = $("dbg-mem-num");
const dbgMemFill = $("dbg-mem-fill");
const dbgMemScale = $("dbg-mem-scale");
const dbgTree = $("dbg-tree");

// running-wasm state
const wasmState = $("wasm-state");
const gCpuNum = $("g-cpu-num");
const gCpuFill = $("g-cpu-fill");
const gCpuScale = $("g-cpu-scale");
const gMemNum = $("g-mem-num");
const gMemFill = $("g-mem-fill");
const gMemScale = $("g-mem-scale");
const gNote = $("g-note");
const fpRo = $("fp-ro");
const fpRw = $("fp-rw");
const fpRoCount = $("fp-ro-count");
const fpRwCount = $("fp-rw-count");
const fpRes = $("fp-res");
const evList = $("ev-list");
const evCount = $("ev-count");
const authList = $("auth-list");
const authCount = $("auth-count");
const bmLegend = $("bm-legend");
const bmHex = $("bm-hex");
const bmNote = $("bm-note");

/** Per-transaction host budget caps (soroban-env-host, protocol 28). */
const CPU_CAP = 100_000_000;
const MEM_CAP = 40 * 1024 * 1024;

/** Byte-map region colors, keyed by SSIM framing field. Theme-independent. */
const REGION_COLOR: Record<string, string> = {
  magic: "#6b7a93",
  budget: "#e0a54b",
  result: "#4c8dff",
  auth: "#3dbe8b",
  events: "#b57edc",
  diagnostics: "#8899aa",
  txdata: "#46b3c9",
  modified: "#e0674b",
};

// ---- theme -----------------------------------------------------------------
const savedTheme = localStorage.getItem("sim-theme");
if (savedTheme === "dark" || savedTheme === "light") {
  document.documentElement.dataset.theme = savedTheme;
}
themeBtn.addEventListener("click", () => {
  const cur =
    document.documentElement.dataset.theme ??
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("sim-theme", next);
});

// ---- app state -------------------------------------------------------------
let mode: DemoMode = "offline";
let selectedId = FIXTURES[0]!.id;
let running = false;
let runId = 0;
let workerStartupMs = 0;
let workerReady = false;
let hardStopTimer: ReturnType<typeof setTimeout> | undefined;
let presentCount = 0;
let absentCount = 0;

// upload-any-contract state
let uploadInfo: UploadInfoMsg | undefined;
let uploadSelected = false;
let uploadParseId = 0;

// visual-debugger state
let debuggableRunId: number | undefined;
let debugPending = false;
let debugData: DebugResultMsg | undefined;
let dbgIdx = 0;
let activeTick: HTMLElement | undefined;
let activeLaneMark: HTMLElement | undefined;
let activeTreeFrame: HTMLElement | undefined;
let treeFrameEls: (HTMLElement | undefined)[] = [];
let laneMarkBySeq = new Map<number, HTMLElement>();

// ---- worker (respawnable for hard-stop) ------------------------------------
let worker!: Worker;
let workerStarted = 0;

function spawnWorker(runGolden: boolean): void {
  workerStarted = performance.now();
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (e: MessageEvent<WorkerToMain>) => onWorkerMessage(e.data, runGolden);
  worker.onerror = (e) => {
    if (running) failRun(e.message || "worker error");
  };
}

function onWorkerMessage(msg: WorkerToMain, mayRunGolden: boolean): void {
  switch (msg.type) {
    case "ready": {
      workerStartupMs = performance.now() - workerStarted;
      mWorker.firstChild!.textContent = workerStartupMs.toFixed(0);
      if (mayRunGolden) {
        workerReady = true;
        runBtn.disabled = false;
        worker.postMessage({ type: "run-fixture" });
      }
      return;
    }
    case "result": {
      // M0 golden path — write the frozen JSON contract the Playwright gate reads.
      resultPre.dataset.status = "done";
      resultPre.textContent = JSON.stringify(
        { len: msg.len, sha256: msg.sha256, elapsedMs: msg.elapsedMs, workerStartupMs },
        null,
        2,
      );
      renderGolden(msg.len, msg.sha256);
      return;
    }
    case "round": {
      if (msg.id !== runId) return;
      renderRound(msg);
      return;
    }
    case "sim-result": {
      if (msg.id !== runId) return;
      finishRun(msg);
      return;
    }
    case "sim-error": {
      if (msg.id !== runId) return;
      failRun(msg.message);
      return;
    }
    case "upload-info": {
      if (msg.id !== uploadParseId) return;
      onUploadInfo(msg);
      return;
    }
    case "debug-result": {
      if (msg.id !== debuggableRunId) return;
      debugPending = false;
      debugRunBtn.disabled = false;
      debugRunBtn.textContent = "◉ debug this run";
      openDebugger(msg);
      return;
    }
    case "debug-error": {
      if (msg.id !== debuggableRunId) return;
      debugPending = false;
      debugRunBtn.disabled = false;
      debugRunBtn.textContent = "◉ debug this run";
      debuggerEl.hidden = false;
      dbgReason.hidden = false;
      dbgReason.innerHTML = "";
      const b = document.createElement("b");
      b.textContent = "trace failed: ";
      dbgReason.append(b, document.createTextNode(msg.message));
      dbgScrub.hidden = true;
      dbgDetail.hidden = true;
      return;
    }
  }
}

function renderGolden(len: number, sha: string): void {
  const match = len === GOLDEN_LEN && sha === GOLDEN_SHA;
  golden.dataset.status = match ? "done" : "error";
  goldenText.innerHTML = match
    ? `<b>${len} B</b> · sha <code>${sha.slice(0, 8)}</code> ✓ byte-identical to CI`
    : `unexpected output (${len} B, sha ${sha.slice(0, 8)})`;
}

// ---- fixture picker --------------------------------------------------------
function renderFixtures(): void {
  fixturesEl.replaceChildren();
  for (const f of FIXTURES) {
    const btn = document.createElement("button");
    btn.className = "fixture";
    btn.type = "button";
    const disabled = mode === "live" && !f.liveCapable;
    btn.disabled = disabled;
    btn.setAttribute(
      "aria-pressed",
      String(!uploadSelected && f.id === selectedId),
    );
    const tag = f.liveCapable
      ? `<span class="fx-tag">live</span>`
      : "";
    btn.innerHTML = `${tag}<div>${f.label}</div><div class="fx-call">${f.call}</div>`;
    btn.addEventListener("click", () => {
      if (btn.disabled || running) return;
      selectedId = f.id;
      uploadSelected = false;
      uploadCard.setAttribute("aria-pressed", "false");
      renderFixtures();
      renderReqNote();
    });
    fixturesEl.appendChild(btn);
  }
}

function renderReqNote(): void {
  reqNote.textContent = uploadSelected
    ? "Uploaded contract — runs offline: your code + a fresh contract instance seeded over the committed config snapshot."
    : fixtureById(selectedId).note;
}

// ---- mode ------------------------------------------------------------------
function setMode(next: DemoMode): void {
  if (running) return;
  mode = next;
  modeOffline.setAttribute("aria-pressed", String(next === "offline"));
  modeLive.setAttribute("aria-pressed", String(next === "live"));
  cacheRow.classList.toggle("hidden", next !== "live");
  if (next === "live" && !fixtureById(selectedId).liveCapable) {
    selectedId = LIVE_FIXTURE_ID;
  }
  renderFixtures();
  renderReqNote();
}
modeOffline.addEventListener("click", () => setMode("offline"));
modeLive.addEventListener("click", () => setMode("live"));

// ---- run / cancel ----------------------------------------------------------
function resetRunUI(): void {
  timeline.replaceChildren(timelineEmpty);
  timelineEmpty.hidden = true;
  snapList.replaceChildren(snapEmpty);
  snapEmpty.hidden = true;
  presentCount = 0;
  absentCount = 0;
  snapPresent.textContent = "0";
  snapAbsent.textContent = "0";
  mRounds.textContent = "—";
  mKeys.textContent = "—";
  setMetricNum(mElapsed, "—");
  resultPanel.hidden = true;
  resultNote.hidden = true;
  rBadge.classList.add("hidden");
  rErr.hidden = true;
  resultPanel.classList.remove("error");
  wasmState.hidden = true;
  // debugger resets with every new run
  debugRunBtn.hidden = true;
  debugRunBtn.disabled = false;
  debugRunBtn.textContent = "◉ debug this run";
  debuggerEl.hidden = true;
  debuggableRunId = undefined;
  debugPending = false;
  debugData = undefined;
}

function setMetricNum(el: HTMLElement, value: string): void {
  // metric spans keep a trailing unit <span>; only replace the leading text node
  if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) {
    el.firstChild.textContent = value;
  } else {
    el.textContent = value;
  }
}

function startRun(): void {
  if (!workerReady || running) return;
  if (uploadSelected) {
    const invocation = gatherUploadInvocation();
    if (!invocation) return; // validation error already shown inline
    running = true;
    runId += 1;
    resetRunUI();
    runBtn.textContent = "Cancel";
    runBtn.dataset.running = "true";
    worker.postMessage({
      type: "simulate-upload",
      id: runId,
      fn: invocation.fn,
      args: invocation.args,
      raw: invocation.raw,
    });
    return;
  }
  running = true;
  runId += 1;
  resetRunUI();
  runBtn.textContent = "Cancel";
  runBtn.dataset.running = "true";
  worker.postMessage({
    type: "simulate",
    id: runId,
    mode,
    fixtureId: selectedId,
    cache: mode === "live" && cacheBox.checked,
  });
}

function cancelRun(): void {
  worker.postMessage({ type: "cancel", id: runId });
  // Hard-stop fallback: a synchronous wasm run can only be interrupted by
  // terminating the Worker. If the abort hasn't settled shortly, respawn.
  hardStopTimer = setTimeout(() => {
    worker.terminate();
    workerReady = false;
    runBtn.disabled = true;
    spawnWorker(false);
    // mark ready without re-running golden
    const readyPoll = setInterval(() => {
      workerReady = true;
      runBtn.disabled = false;
      clearInterval(readyPoll);
    }, 50);
    endRun();
    failRunText("Run cancelled.");
  }, 400);
}

function endRun(): void {
  running = false;
  runBtn.textContent = "Run simulation ▸";
  runBtn.dataset.running = "false";
  if (hardStopTimer) {
    clearTimeout(hardStopTimer);
    hardStopTimer = undefined;
  }
}

runBtn.addEventListener("click", () => {
  if (running) cancelRun();
  else startRun();
});

// ---- render a resolved round ----------------------------------------------
let activeRound: HTMLElement | undefined;

function renderRound(msg: RoundMsg): void {
  timelineEmpty.hidden = true;
  if (activeRound) activeRound.classList.remove("active");

  const col = document.createElement("div");
  col.className = "round active";

  const rnum = document.createElement("div");
  rnum.className = "rnum";
  rnum.textContent = `R${msg.roundIndex}`;
  col.appendChild(rnum);

  // usually one key per round; render the primary key's cell + labels
  const key = msg.keys[0]!;
  const cell = document.createElement("div");
  cell.className = `cell ${key.status}`;
  if (key.ttl !== undefined) {
    const ttl = document.createElement("span");
    ttl.className = "ttl";
    ttl.textContent = shortTtl(key.ttl);
    cell.appendChild(ttl);
  }
  col.appendChild(cell);

  const kind = document.createElement("div");
  kind.className = "rkind";
  kind.textContent = key.kind;
  kind.title = key.label;
  col.appendChild(kind);

  const detail = document.createElement("div");
  detail.className = "rdetail";
  detail.textContent = key.detail || "—";
  detail.title = key.label;
  col.appendChild(detail);

  timeline.appendChild(col);
  activeRound = col;

  // live metrics tick
  mRounds.textContent = String(msg.roundIndex + 1);
  mKeys.textContent = String(msg.requestedKeyCount);

  // append every key of the round to the snapshot rail
  for (const k of msg.keys) appendSnapshotRow(k);

  // keep the newest column in view
  timelineScroll.scrollLeft = timelineScroll.scrollWidth;
}

function appendSnapshotRow(key: RoundMsg["keys"][number]): void {
  snapEmpty.hidden = true;
  const row = document.createElement("div");
  row.className = `snap-row ${key.status}`;
  const dot = document.createElement("span");
  dot.className = "dot";
  const label = document.createElement("span");
  label.className = "s-label";
  label.textContent = key.label;
  label.title = key.label;
  const ttl = document.createElement("span");
  ttl.className = "s-ttl";
  ttl.textContent = key.status === "present" && key.ttl ? `ttl ${shortTtl(key.ttl)}` : "—";
  row.append(dot, label, ttl);
  snapList.appendChild(row);

  if (key.status === "present") presentCount += 1;
  else absentCount += 1;
  snapPresent.textContent = String(presentCount);
  snapAbsent.textContent = String(absentCount);
}

function shortTtl(ttl: number): string {
  if (ttl >= 1_000_000) return `${(ttl / 1_000_000).toFixed(1)}M`;
  if (ttl >= 1_000) return `${(ttl / 1_000).toFixed(0)}k`;
  return String(ttl);
}

// ---- finish ----------------------------------------------------------------
function finishRun(msg: Extract<WorkerToMain, { type: "sim-result" }>): void {
  endRun();
  if (activeRound) activeRound.classList.remove("active");

  mRounds.textContent = String(msg.rounds);
  mKeys.textContent = String(msg.requestedKeyCount);
  setMetricNum(mElapsed, msg.elapsedMs.toFixed(0));

  resultPanel.hidden = false;
  resultNote.hidden = false;
  rErr.hidden = true;
  resultPanel.classList.remove("error");

  if (msg.ok) {
    rValue.textContent = `${msg.scValType} · ${msg.scValDisplay}`;
    rLen.textContent = `${msg.resultLen} B`;
    rSha.textContent = msg.sha256;
  } else {
    rValue.textContent = "host error";
    rLen.textContent = `${msg.resultLen} B`;
    rSha.textContent = msg.sha256;
    rErr.hidden = false;
    rErr.textContent = msg.errorText ?? "inline failure";
  }
  // Honest badge: only the dedicated runFixture strip proves the CI golden.
  // The interactive add_i32 run uses a full tx envelope, so its bytes differ;
  // we never claim a byte-match here.
  rBadge.classList.add("hidden");

  // The worker stashed a trace-replay context for this run — offer the debugger.
  if (msg.debuggable) {
    debuggableRunId = msg.id;
    debugRunBtn.hidden = false;
  }

  renderWasmState(msg);
}

// ---- running-wasm state ----------------------------------------------------
function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}
function fmtPct(value: number, cap: number): string {
  const pct = (value / cap) * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(pct < 10 ? 2 : 1)}%`;
}
function fillWidth(value: number, cap: number): string {
  const pct = Math.min(100, (value / cap) * 100);
  return `${Math.max(pct, value > 0 ? 0.6 : 0)}%`;
}

function renderWasmState(msg: Extract<WorkerToMain, { type: "sim-result" }>): void {
  wasmState.hidden = false;

  // --- budget gauges (real host metering) ---
  gCpuNum.textContent = fmtInt(msg.instructions);
  gMemNum.textContent = fmtBytes(msg.memoryBytes);
  gCpuScale.textContent = `${fmtPct(msg.instructions, CPU_CAP)} of the 100M instruction cap`;
  gMemScale.textContent = `${fmtPct(msg.memoryBytes, MEM_CAP)} of the 40 MiB memory cap`;
  // reset then animate width on next frame so the transition always plays
  gCpuFill.style.width = "0%";
  gMemFill.style.width = "0%";
  requestAnimationFrame(() => {
    gCpuFill.style.width = fillWidth(msg.instructions, CPU_CAP);
    gMemFill.style.width = fillWidth(msg.memoryBytes, MEM_CAP);
  });
  gNote.textContent =
    "Metered by soroban-env-host as it executed the contract's core wasm — the real CPU + linear-memory the run consumed, before any RPC fee padding.";

  // --- footprint (ledger keys the run actually touched) ---
  renderFootprint(fpRo, fpRoCount, msg.readOnly);
  renderFootprint(fpRw, fpRwCount, msg.readWrite);
  fpRes.replaceChildren();
  if (msg.resources) {
    const r = msg.resources;
    addResItem(fpRes, "instructions", fmtInt(r.instructions));
    addResItem(fpRes, "disk read", fmtBytes(r.readBytes));
    addResItem(fpRes, "write bytes", fmtBytes(r.writeBytes));
    addResItem(fpRes, "resource fee", `${fmtInt(Number(r.resourceFee))} stroops`);
  } else {
    const p = document.createElement("span");
    p.className = "fp-empty";
    p.textContent = msg.hasTxData ? "resources unavailable" : "no transaction data produced";
    fpRes.appendChild(p);
  }

  // --- contract events + auth ---
  renderEvents(msg.contractEvents);
  renderAuth(msg.auth);

  // --- ssim byte map ---
  renderByteMap(msg.regions, msg.resultHex, msg.resultLen, msg.diagnosticEventCount, msg.modifiedCount);
}

function renderFootprint(
  list: HTMLElement,
  counter: HTMLElement,
  keys: Extract<WorkerToMain, { type: "sim-result" }>["readOnly"],
): void {
  list.replaceChildren();
  const arr = keys ?? [];
  counter.textContent = String(arr.length);
  if (arr.length === 0) {
    const p = document.createElement("p");
    p.className = "fp-empty";
    p.textContent = "none";
    list.appendChild(p);
    return;
  }
  for (const k of arr) {
    const row = document.createElement("div");
    row.className = "fp-key";
    const kind = document.createElement("div");
    kind.className = "fp-kind";
    kind.textContent = k.kind;
    const detail = document.createElement("div");
    detail.className = "fp-detail";
    detail.textContent = k.detail || k.label;
    detail.title = k.label;
    row.append(kind, detail);
    list.appendChild(row);
  }
}

function addResItem(host: HTMLElement, k: string, v: string): void {
  const item = document.createElement("div");
  item.className = "r-item";
  const kk = document.createElement("span");
  kk.className = "r-k";
  kk.textContent = k;
  const vv = document.createElement("span");
  vv.className = "r-v";
  vv.textContent = v;
  item.append(kk, vv);
  host.appendChild(item);
}

function renderEvents(
  events: Extract<WorkerToMain, { type: "sim-result" }>["contractEvents"],
): void {
  evList.replaceChildren();
  const arr = events ?? [];
  evCount.textContent = String(arr.length);
  if (arr.length === 0) {
    evList.innerHTML = `<p class="ea-empty">no events emitted</p>`;
    return;
  }
  for (const e of arr) {
    const item = document.createElement("div");
    item.className = "ea-item";
    const top = document.createElement("div");
    top.className = "ea-top";
    const type = document.createElement("span");
    type.className = "ea-type";
    type.textContent = e.type;
    top.appendChild(type);
    if (e.contractId) {
      const cid = document.createElement("span");
      cid.className = "ea-cid";
      cid.textContent = `${e.contractId.slice(0, 4)}…${e.contractId.slice(-4)}`;
      cid.title = e.contractId;
      top.appendChild(cid);
    }
    item.appendChild(top);
    const topics = document.createElement("div");
    topics.className = "ea-topics";
    topics.textContent = e.topics.length ? `[ ${e.topics.join(", ")} ]` : "[ ]";
    item.appendChild(topics);
    const data = document.createElement("div");
    data.className = "ea-data";
    data.textContent = `data: ${e.data}`;
    item.appendChild(data);
    evList.appendChild(item);
  }
}

function renderAuth(
  auth: Extract<WorkerToMain, { type: "sim-result" }>["auth"],
): void {
  authList.replaceChildren();
  const arr = auth ?? [];
  authCount.textContent = String(arr.length);
  if (arr.length === 0) {
    authList.innerHTML = `<p class="ea-empty">no auth recorded</p>`;
    return;
  }
  for (const a of arr) {
    const item = document.createElement("div");
    item.className = "ea-item";
    const top = document.createElement("div");
    top.className = "ea-top";
    const type = document.createElement("span");
    type.className = "ea-type";
    type.textContent = a.credentials;
    top.appendChild(type);
    if (a.subInvocations > 0) {
      const sub = document.createElement("span");
      sub.className = "ea-cid";
      sub.textContent = `${a.subInvocations} sub-invocation${a.subInvocations === 1 ? "" : "s"}`;
      top.appendChild(sub);
    }
    item.appendChild(top);
    const fn = document.createElement("div");
    fn.className = "ea-topics";
    if (a.fn) {
      fn.innerHTML = `fn <span class="ea-fn"></span>`;
      fn.querySelector(".ea-fn")!.textContent = a.fn;
    } else {
      fn.textContent = "—";
    }
    item.appendChild(fn);
    if (a.contract) {
      const c = document.createElement("div");
      c.className = "ea-data";
      c.textContent = `on ${a.contract.slice(0, 4)}…${a.contract.slice(-4)}`;
      c.title = a.contract;
      item.appendChild(c);
    }
    authList.appendChild(item);
  }
}

function hexPairs(hexSlice: string): string {
  const out: string[] = [];
  for (let i = 0; i < hexSlice.length; i += 2) out.push(hexSlice.slice(i, i + 2));
  return out.join(" ");
}

function renderByteMap(
  regions: Extract<WorkerToMain, { type: "sim-result" }>["regions"],
  hexStr: string | undefined,
  totalLen: number,
  diagCount: number | undefined,
  modifiedCount: number | undefined,
): void {
  bmLegend.replaceChildren();
  bmHex.replaceChildren();
  const arr = regions ?? [];

  // legend: unique kinds present, in framing order
  const seen = new Set<string>();
  for (const r of arr) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    const leg = document.createElement("span");
    leg.className = "bm-leg";
    leg.style.setProperty("--rc", REGION_COLOR[r.kind] ?? "#8899aa");
    const sw = document.createElement("i");
    const txt = document.createElement("span");
    txt.textContent = r.label;
    leg.append(sw, txt);
    bmLegend.appendChild(leg);
  }

  if (hexStr && arr.length) {
    for (const r of arr) {
      const run = document.createElement("span");
      run.className = "bm-run";
      run.style.setProperty("--rc", REGION_COLOR[r.kind] ?? "#8899aa");
      run.title = `${r.label} · bytes [${r.start}, ${r.end}) · ${r.end - r.start} B`;
      run.textContent = `${hexPairs(hexStr.slice(r.start * 2, r.end * 2))} `;
      bmHex.appendChild(run);
    }
  } else {
    const p = document.createElement("p");
    p.className = "ea-empty";
    p.textContent = "envelope too large to render bytes inline";
    bmHex.appendChild(p);
  }

  const parts = [`${fmtInt(totalLen)} bytes total`];
  if (diagCount) parts.push(`${diagCount} diagnostic event${diagCount === 1 ? "" : "s"}`);
  if (modifiedCount) parts.push(`${modifiedCount} modified ledger ${modifiedCount === 1 ? "entry" : "entries"}`);
  parts.push("big-endian, self-describing — identical bytes in this Worker, the native runner, and CI");
  bmNote.textContent = parts.join(" · ");
}

function failRun(message: string): void {
  endRun();
  failRunText(message);
}

function failRunText(message: string): void {
  if (activeRound) activeRound.classList.remove("active");
  resultPanel.hidden = false;
  resultNote.hidden = true;
  resultPanel.classList.add("error");
  rValue.textContent = mode === "live" ? "testnet unreachable" : "simulation failed";
  rLen.textContent = "—";
  rSha.textContent = "—";
  rBadge.classList.add("hidden");
  rErr.hidden = false;
  rErr.textContent =
    mode === "live"
      ? `${message} — retry, or switch to Offline for a deterministic run.`
      : message;
}

// ---- upload-any-contract ---------------------------------------------------
uploadBtn.addEventListener("click", () => uploadFile.click());
uploadFile.addEventListener("change", async () => {
  const file = uploadFile.files?.[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  uploadParseId += 1;
  worker.postMessage({
    type: "upload-parse",
    id: uploadParseId,
    fileName: file.name,
    bytes,
  });
});

function selectUpload(): void {
  if (running || !uploadInfo?.ok) return;
  uploadSelected = true;
  uploadCard.setAttribute("aria-pressed", "true");
  renderFixtures();
  renderReqNote();
}
uploadCard.addEventListener("click", selectUpload);
uploadCard.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    selectUpload();
  }
});

function onUploadInfo(msg: UploadInfoMsg): void {
  uploadInfo = msg;
  uploadCard.hidden = false;
  upName.textContent = msg.fileName;
  upSize.textContent = fmtBytes(msg.size);
  upErr.hidden = true;
  upErr.textContent = "";
  for (const rung of upLadder.querySelectorAll<HTMLElement>(".rung")) {
    rung.classList.toggle("active", msg.ok && rung.dataset.rung === msg.ladder);
  }
  if (!msg.ok) {
    upCid.textContent = "";
    upFnRow.hidden = true;
    upArgs.replaceChildren();
    upErr.hidden = false;
    upErr.textContent = msg.error ?? "could not read this file as contract wasm";
    uploadSelected = false;
    uploadCard.setAttribute("aria-pressed", "false");
    renderFixtures();
    return;
  }
  upCid.textContent = msg.contractId;
  upCid.title = `code sha-256 ${msg.codeHash}`;
  upFnRow.hidden = false;
  if (msg.ladder === "raw") {
    upFn.hidden = true;
    upFnFree.hidden = false;
  } else {
    upFn.hidden = false;
    upFnFree.hidden = true;
    upFn.replaceChildren();
    for (const fn of msg.fns) {
      const opt = document.createElement("option");
      opt.value = fn.name;
      opt.textContent =
        msg.ladder === "spec"
          ? `${fn.name}(${fn.args.map((a) => a.name).join(", ")})`
          : fn.name;
      upFn.appendChild(opt);
    }
  }
  renderUploadArgs();
  selectUpload();
}
upFn.addEventListener("change", renderUploadArgs);

/** Placeholder text per spec-arg widget class. */
const ARG_PLACEHOLDER: Record<string, string> = {
  u32: "e.g. 7",
  i32: "e.g. -7",
  u64: "e.g. 7",
  i64: "e.g. -7",
  string: "text",
  symbol: "symbol",
  address: "G… or C… address",
  xdr: "base64 ScVal XDR",
};

function renderUploadArgs(): void {
  upArgs.replaceChildren();
  upErr.hidden = true;
  const info = uploadInfo;
  if (!info?.ok) return;
  if (info.ladder === "spec") {
    const fnInfo = info.fns.find((f) => f.name === upFn.value) ?? info.fns[0];
    if (!fnInfo) return;
    for (const arg of fnInfo.args) {
      const field = document.createElement("div");
      field.className = "up-arg";
      const label = document.createElement("label");
      const b = document.createElement("b");
      b.textContent = arg.name;
      label.append(b, document.createTextNode(` ${arg.input}`));
      field.appendChild(label);
      let input: HTMLElement;
      if (arg.input === "bool") {
        const sel = document.createElement("select");
        for (const v of ["true", "false"]) {
          const o = document.createElement("option");
          o.value = v;
          o.textContent = v;
          sel.appendChild(o);
        }
        input = sel;
      } else if (arg.input === "xdr") {
        const ta = document.createElement("textarea");
        ta.rows = 2;
        ta.placeholder = ARG_PLACEHOLDER.xdr!;
        input = ta;
      } else {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.placeholder = ARG_PLACEHOLDER[arg.input] ?? "";
        input = inp;
      }
      input.dataset.arg = arg.name;
      field.appendChild(input);
      upArgs.appendChild(field);
    }
    return;
  }
  // names / raw rungs: args are raw ScVal XDR, one per line, optional.
  const field = document.createElement("div");
  field.className = "up-arg";
  const label = document.createElement("label");
  const b = document.createElement("b");
  b.textContent = "args";
  label.append(
    b,
    document.createTextNode(" base64 ScVal XDR, one per line (optional)"),
  );
  const ta = document.createElement("textarea");
  ta.rows = 3;
  ta.placeholder = "AAAAAwAAAAc=";
  ta.dataset.arg = "raw-args";
  field.append(label, ta);
  upArgs.appendChild(field);
}

function showUploadError(message: string): void {
  upErr.hidden = false;
  upErr.textContent = message;
}

function gatherUploadInvocation():
  | { fn: string; args: string[]; raw: boolean }
  | undefined {
  const info = uploadInfo;
  if (!info?.ok) {
    showUploadError("upload a contract .wasm first");
    return undefined;
  }
  upErr.hidden = true;
  if (info.ladder === "spec") {
    const fn = upFn.value;
    const inputs = upArgs.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input, select, textarea");
    const args: string[] = [];
    for (const el of inputs) {
      if (el.value.trim() === "") {
        showUploadError(`argument "${el.dataset.arg}" is required`);
        return undefined;
      }
      args.push(el.value);
    }
    return { fn, args, raw: false };
  }
  const fn = info.ladder === "raw" ? upFnFree.value.trim() : upFn.value;
  if (!fn) {
    showUploadError("enter a function name to invoke");
    return undefined;
  }
  const ta = upArgs.querySelector<HTMLTextAreaElement>("textarea");
  const args = (ta?.value ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return { fn, args, raw: true };
}

// ---- visual debugger -------------------------------------------------------
debugRunBtn.addEventListener("click", () => {
  if (debuggableRunId === undefined || debugPending) return;
  debugPending = true;
  debugRunBtn.disabled = true;
  debugRunBtn.textContent = "tracing…";
  worker.postMessage({ type: "debug", id: debuggableRunId });
});

const KIND_LABEL: Record<string, string> = {
  begin: "begin",
  end: "end",
  "push-ctx": "frame push",
  "pop-ctx": "frame pop",
  "env-call": "env call",
  "env-ret": "env return",
};

function openDebugger(msg: DebugResultMsg): void {
  debugData = msg;
  debuggerEl.hidden = false;

  if (msg.reason) {
    dbgReason.hidden = false;
    dbgReason.replaceChildren();
    const b = document.createElement("b");
    b.textContent = "trace unavailable: ";
    dbgReason.append(
      b,
      document.createTextNode(
        `${msg.reason} — showing the Tier-1 call tree only.`,
      ),
    );
  } else {
    dbgReason.hidden = true;
    dbgReason.replaceChildren();
  }

  renderCallTree(msg);

  const steps = msg.steps;
  const hasTrace = steps.length > 0;
  dbgScrub.hidden = !hasTrace;
  dbgDetail.hidden = !hasTrace;
  if (!hasTrace) {
    debuggerEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  const storageCount = steps.reduce((n, s) => n + (s.storage ? 1 : 0), 0);
  dbgCount.textContent = `${fmtInt(steps.length)} steps · ${fmtInt(
    msg.frames.length,
  )} frames · ${fmtInt(storageCount)} storage ops`;

  // ticks
  dbgTicks.replaceChildren();
  activeTick = undefined;
  for (const step of steps) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = `dtick ${step.kind}${step.storage ? " storage" : ""}`;
    t.title = `#${step.seq} ${step.display}`;
    t.addEventListener("click", () => setDebugStep(step.seq));
    dbgTicks.appendChild(t);
  }

  // ledger lane
  dbgLane.replaceChildren();
  laneMarkBySeq = new Map();
  activeLaneMark = undefined;
  if (storageCount === 0) {
    const empty = document.createElement("span");
    empty.className = "lane-empty";
    empty.textContent = "no storage ops in this run";
    dbgLane.appendChild(empty);
  } else {
    const denom = Math.max(steps.length - 1, 1);
    for (const step of steps) {
      if (!step.storage) continue;
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "lane-mark";
      mark.style.left = `${(step.seq / denom) * 100}%`;
      mark.title = `#${step.seq} ${step.display}`;
      mark.addEventListener("click", () => setDebugStep(step.seq));
      laneMarkBySeq.set(step.seq, mark);
      dbgLane.appendChild(mark);
    }
  }

  dbgSlider.min = "0";
  dbgSlider.max = String(steps.length - 1);
  setDebugStep(0);
  debuggerEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderCallTree(msg: DebugResultMsg): void {
  dbgTree.replaceChildren();
  treeFrameEls = [];
  activeTreeFrame = undefined;
  if (msg.frames.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tree-empty";
    empty.textContent = "no fn_call diagnostics recorded";
    dbgTree.appendChild(empty);
    return;
  }
  msg.frames.forEach((frame, i) => {
    const el = document.createElement("div");
    el.className = "tree-frame";
    el.style.marginLeft = `${frame.depth * 16}px`;
    const head = document.createElement("div");
    head.className = "tf-head";
    const fn = document.createElement("span");
    fn.className = "tf-fn";
    fn.textContent = frame.fn;
    head.appendChild(fn);
    if (frame.contract) {
      const c = document.createElement("span");
      c.className = "tf-contract";
      c.textContent = `${frame.contract.slice(0, 4)}…${frame.contract.slice(-4)}`;
      c.title = frame.contract;
      head.appendChild(c);
    }
    el.appendChild(head);
    const args = document.createElement("div");
    args.className = "tf-args";
    args.textContent = `(${frame.args.join(", ")})`;
    el.appendChild(args);
    const ret = document.createElement("div");
    if (frame.ret !== undefined) {
      ret.className = "tf-ret";
      ret.textContent = `→ ${frame.ret}`;
    } else {
      ret.className = "tf-ret open";
      ret.textContent = "→ (no return recorded)";
    }
    el.appendChild(ret);
    if (frame.pushSeq >= 0) {
      el.addEventListener("click", () => setDebugStep(frame.pushSeq));
    }
    treeFrameEls[i] = el;
    dbgTree.appendChild(el);
  });
}

function fmtDelta(n: number): string {
  return n > 0 ? `+${fmtInt(n)}` : "0";
}

function setDebugStep(i: number): void {
  const data = debugData;
  if (!data || data.steps.length === 0) return;
  dbgIdx = Math.max(0, Math.min(i, data.steps.length - 1));
  const step = data.steps[dbgIdx]!;

  dbgSlider.value = String(dbgIdx);
  dbgPos.textContent = `step ${dbgIdx + 1} / ${data.steps.length}`;
  dbgDisplay.textContent = step.display;
  dbgKind.textContent =
    (KIND_LABEL[step.kind] ?? step.kind) + (step.storage ? " · storage" : "");
  dbgName.textContent = step.name || "—";
  dbgDcpu.textContent = fmtDelta(step.dCpu);
  dbgDmem.textContent = fmtDelta(step.dMem);

  dbgCpuNum.textContent = fmtInt(step.cpu);
  dbgCpuFill.style.width = fillWidth(step.cpu, data.totalCpu || 1);
  dbgCpuScale.textContent = `${fmtPct(step.cpu, data.totalCpu || 1)} of this run's ${fmtInt(data.totalCpu)} insns`;
  dbgMemNum.textContent = fmtBytes(step.mem);
  dbgMemFill.style.width = fillWidth(step.mem, data.totalMem || 1);
  dbgMemScale.textContent = `${fmtPct(step.mem, data.totalMem || 1)} of this run's ${fmtBytes(data.totalMem)}`;

  if (activeTick) activeTick.classList.remove("active");
  activeTick = dbgTicks.children[dbgIdx] as HTMLElement | undefined;
  activeTick?.classList.add("active");

  if (activeLaneMark) activeLaneMark.classList.remove("active");
  activeLaneMark = laneMarkBySeq.get(step.seq);
  activeLaneMark?.classList.add("active");

  if (activeTreeFrame) activeTreeFrame.classList.remove("active");
  activeTreeFrame = step.frame >= 0 ? treeFrameEls[step.frame] : undefined;
  activeTreeFrame?.classList.add("active");

  const last = data.steps.length - 1;
  dbgBack.disabled = dbgIdx === 0;
  dbgFwd.disabled = dbgIdx === last;
  dbgOver.disabled = dbgIdx === last;
  dbgStorageBtn.disabled = !data.steps.some(
    (s) => s.seq > dbgIdx && s.storage,
  );
}

dbgSlider.addEventListener("input", () => {
  setDebugStep(Number(dbgSlider.value));
});
dbgBack.addEventListener("click", () => setDebugStep(dbgIdx - 1));
dbgFwd.addEventListener("click", () => setDebugStep(dbgIdx + 1));
dbgOver.addEventListener("click", () => {
  const step = debugData?.steps[dbgIdx];
  if (!step) return;
  // On a frame push, jump past the matching pop; otherwise a single step.
  if (step.kind === "push-ctx" && step.matchPop >= 0) {
    setDebugStep(step.matchPop + 1);
  } else {
    setDebugStep(dbgIdx + 1);
  }
});
dbgStorageBtn.addEventListener("click", () => {
  const next = debugData?.steps.find((s) => s.seq > dbgIdx && s.storage);
  if (next) setDebugStep(next.seq);
});
window.addEventListener("keydown", (e) => {
  if (debuggerEl.hidden || !debugData || debugData.steps.length === 0) return;
  const target = e.target as HTMLElement | null;
  if (
    target &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  ) {
    return;
  }
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    setDebugStep(dbgIdx - 1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    setDebugStep(dbgIdx + 1);
  }
});

// ---- boot ------------------------------------------------------------------
renderFixtures();
renderReqNote();
runBtn.disabled = true;
spawnWorker(true);

import "./styles.css";
import {
  FIXTURES,
  fixtureById,
  LIVE_FIXTURE_ID,
} from "./fixtures.js";
import type {
  ContractInfoMsg,
  DebugResultMsg,
  DemoMode,
  FootprintKey,
  RoundMsg,
  UploadFnInfo,
  UploadInfoMsg,
  WorkerToMain,
} from "./protocol.js";

/** The committed add_i32 golden the CI gate and native runner also produce. */
const GOLDEN_LEN = 388;
const GOLDEN_SHA = "3b678efa6ece9309c861a0412b8e1bc45d4d449085217e76c0966b4d8ebe4bca";
const DEFAULT_SIMULATION_SOURCE =
  "GALD63KYDPYZLJLY2VD722RI6HAW3RIKU5AROSPAXTL5JRDJB5NGOJIX";

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
const requestContract = $<HTMLButtonElement>("request-contract");
const requestXdr = $<HTMLButtonElement>("request-xdr");
const contractRequest = $("contract-request");
const xdrRequest = $("xdr-request");
const advancedInputs = $<HTMLDetailsElement>("advanced-inputs");
const contractIdInput = $<HTMLInputElement>("contract-id");
const contractLoadBtn = $<HTMLButtonElement>("load-contract");
const contractMeta = $("contract-meta");
const contractExecutable = $("contract-executable");
const contractSpec = $("contract-spec");
const contractLedger = $("contract-ledger");
const contractFnRow = $("contract-fn-row");
const contractFn = $<HTMLSelectElement>("contract-fn");
const contractFnFree = $<HTMLInputElement>("contract-fn-free");
const contractArgs = $("contract-args");
const contractErr = $("contract-err");
const transactionXdr = $<HTMLTextAreaElement>("transaction-xdr");
const xdrErr = $("xdr-err");

const timeline = $("timeline");
const timelineScroll = $("timeline-scroll");
const timelineEmpty = $("timeline-empty");
const mRounds = $("m-rounds");
const mKeys = $("m-keys");
const mElapsed = $("m-elapsed");
const mWorker = $("m-worker");
const engineStateSummary = $("engine-state-summary");
const engineConfigCountEl = $("engine-config-count");

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
const resultContext = $("result-context");
const rNetwork = $("r-network");
const rLedger = $("r-ledger");

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
const dbgRaw = $<HTMLInputElement>("dbg-raw");
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
const fpRuntimeWrap = $("fp-runtime-wrap");
const fpRuntime = $("fp-runtime");
const fpRuntimeCount = $("fp-runtime-count");
const fpProtocolSummary = $("fp-protocol-summary");
const fpRes = $("fp-res");
const evList = $("ev-list");
const evCount = $("ev-count");
const authList = $("auth-list");
const authCount = $("auth-count");
const bmLegend = $("bm-legend");
const bmHex = $("bm-hex");
const bmNote = $("bm-note");
const impactList = $("impact-list");
const submitStatus = $("submit-status");
const submitSource = $("submit-source");
const submitAuth = $("submit-auth");
const submitFee = $("submit-fee");

/** Per-transaction host budget caps (soroban-env-host, protocol 27). */
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
let engineConfigCount = 0;
let engineConfigLabels = new Set<string>();
let executionEntryLabels = new Set<string>();
type RequestKind = "contract" | "xdr" | "fixture" | "upload";
let requestKind: RequestKind = "contract";
let contractInfo: ContractInfoMsg | undefined;
let contractLoadId = 0;

// upload-any-contract state
let uploadInfo: UploadInfoMsg | undefined;
let uploadSelected = false;
let uploadParseId = 0;

// visual-debugger state
let debuggableRunId: number | undefined;
let debugPending = false;
let debugData: DebugResultMsg | undefined;
let debugSteps: DebugResultMsg["steps"] = [];
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
        contractLoadBtn.disabled = false;
        syncRunAvailability();
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
    case "contract-info": {
      if (msg.id !== contractLoadId) return;
      onContractInfo(msg);
      return;
    }
    case "debug-result": {
      if (msg.id !== debuggableRunId) return;
      debugPending = false;
      debugRunBtn.disabled = false;
      debugRunBtn.textContent = "Open execution trace";
      openDebugger(msg);
      return;
    }
    case "debug-error": {
      if (msg.id !== debuggableRunId) return;
      debugPending = false;
      debugRunBtn.disabled = false;
      debugRunBtn.textContent = "Open execution trace";
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
    const disabled =
      requestKind === "fixture" && mode === "live" && !f.liveCapable;
    btn.disabled = disabled;
    btn.setAttribute(
      "aria-pressed",
      String(requestKind === "fixture" && f.id === selectedId),
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
      activateRequest("fixture");
    });
    fixturesEl.appendChild(btn);
  }
}

function renderReqNote(): void {
  switch (requestKind) {
    case "contract":
      reqNote.textContent = contractInfo?.ok
        ? "Testnet RPC supplies a pinned ledger snapshot. The loaded contract executes inside this browser."
        : "Load the deployed interface, choose a function, then simulate locally against pinned Testnet state.";
      return;
    case "xdr":
      reqNote.textContent =
        "Paste an unsigned Testnet envelope. Its InvokeHostFunction operation executes locally; RPC only resolves ledger entries.";
      return;
    case "upload":
      reqNote.textContent =
        "Uploaded contract — runs offline with a fresh instance over the committed network snapshot.";
      return;
    case "fixture":
      reqNote.textContent = fixtureById(selectedId).note;
  }
}

function syncModeUi(): void {
  const workbench = requestKind === "contract" || requestKind === "xdr";
  if (workbench) mode = "live";
  modeOffline.disabled = workbench;
  modeLive.disabled = workbench;
  modeOffline.setAttribute("aria-pressed", String(mode === "offline"));
  modeLive.setAttribute("aria-pressed", String(mode === "live"));
  cacheRow.classList.toggle(
    "hidden",
    requestKind !== "fixture" || mode !== "live",
  );
}

function activateRequest(next: RequestKind): void {
  if (running) return;
  requestKind = next;
  uploadSelected = next === "upload";
  uploadCard.setAttribute("aria-pressed", String(next === "upload"));
  contractRequest.hidden = next !== "contract";
  xdrRequest.hidden = next !== "xdr";
  requestContract.setAttribute("aria-selected", String(next === "contract"));
  requestXdr.setAttribute("aria-selected", String(next === "xdr"));
  if (next === "fixture" || next === "upload") {
    mode = "offline";
    advancedInputs.open = true;
  }
  syncModeUi();
  renderFixtures();
  renderReqNote();
  invalidateRunUI();
  syncRunAvailability();
}

requestContract.addEventListener("click", () => activateRequest("contract"));
requestXdr.addEventListener("click", () => activateRequest("xdr"));

// ---- state source -----------------------------------------------------------
function setMode(next: DemoMode): void {
  if (
    running ||
    next === mode ||
    requestKind === "contract" ||
    requestKind === "xdr"
  ) {
    return;
  }
  mode = next;
  if (next === "live" && !fixtureById(selectedId).liveCapable) {
    selectedId = LIVE_FIXTURE_ID;
  }
  syncModeUi();
  renderFixtures();
  renderReqNote();
  invalidateRunUI();
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
  engineConfigCount = 0;
  engineConfigLabels = new Set();
  executionEntryLabels = new Set();
  engineStateSummary.hidden = true;
  engineConfigCountEl.textContent = "0";
  snapPresent.textContent = "0";
  snapAbsent.textContent = "0";
  mRounds.textContent = "—";
  mKeys.textContent = "—";
  setMetricNum(mElapsed, "—");
  resultPanel.hidden = true;
  resultNote.hidden = true;
  resultContext.hidden = true;
  rBadge.classList.add("hidden");
  rErr.hidden = true;
  resultPanel.classList.remove("error");
  wasmState.hidden = true;
  impactList.innerHTML = `<p class="fp-empty">no ledger writes</p>`;
  submitStatus.textContent = "not submitted";
  submitSource.textContent = "—";
  submitAuth.textContent = "—";
  submitFee.textContent = "—";
  // debugger resets with every new run
  debugRunBtn.hidden = true;
  debugRunBtn.disabled = false;
  debugRunBtn.textContent = "Open execution trace";
  debuggerEl.hidden = true;
  debuggableRunId = undefined;
  debugPending = false;
  debugData = undefined;
  debugSteps = [];
  dbgRaw.checked = false;
  activeRound = undefined;
}

/** Remove output that no longer describes the selected request. */
function invalidateRunUI(): void {
  resetRunUI();
  timelineEmpty.hidden = false;
  snapEmpty.hidden = false;
}

function syncRunAvailability(): void {
  let readyForRequest = false;
  switch (requestKind) {
    case "contract":
      readyForRequest = Boolean(contractInfo?.ok);
      break;
    case "xdr":
      readyForRequest = transactionXdr.value.trim().length > 0;
      break;
    case "upload":
      readyForRequest = Boolean(uploadInfo?.ok);
      break;
    case "fixture":
      readyForRequest = true;
      break;
  }
  runBtn.disabled = !running && (!workerReady || !readyForRequest);
}

function setMetricNum(el: HTMLElement, value: string): void {
  // metric spans keep a trailing unit <span>; only replace the leading text node
  if (el.firstChild && el.firstChild.nodeType === Node.TEXT_NODE) {
    el.firstChild.textContent = value;
  } else {
    el.textContent = value;
  }
}

function beginRun(): void {
  running = true;
  runId += 1;
  resetRunUI();
  runBtn.disabled = false;
  runBtn.textContent = "Cancel";
  runBtn.dataset.running = "true";
}

function startRun(): void {
  if (!workerReady || running || runBtn.disabled) return;
  if (requestKind === "contract") {
    const invocation = gatherContractInvocation();
    if (!invocation) return;
    beginRun();
    worker.postMessage({
      type: "simulate-contract",
      id: runId,
      contractId: invocation.contractId,
      fn: invocation.fn,
      args: invocation.args,
      raw: invocation.raw,
    });
    return;
  }
  if (requestKind === "xdr") {
    const envelope = transactionXdr.value.trim();
    if (!envelope) {
      xdrErr.hidden = false;
      xdrErr.textContent = "paste a base64 transaction envelope";
      return;
    }
    beginRun();
    worker.postMessage({
      type: "simulate-xdr",
      id: runId,
      transactionXdr: envelope,
    });
    return;
  }
  if (requestKind === "upload") {
    const invocation = gatherUploadInvocation();
    if (!invocation) return; // validation error already shown inline
    beginRun();
    worker.postMessage({
      type: "simulate-upload",
      id: runId,
      fn: invocation.fn,
      args: invocation.args,
      raw: invocation.raw,
    });
    return;
  }
  beginRun();
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
      syncRunAvailability();
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
  syncRunAvailability();
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
  const configKeys = msg.keys.filter((key) => key.kind === "ConfigSetting");
  const executionKeys = msg.keys.filter((key) => key.kind !== "ConfigSetting");

  for (const key of configKeys) engineConfigLabels.add(key.label);
  engineConfigCount = engineConfigLabels.size;
  if (engineConfigCount > 0) {
    engineConfigCountEl.textContent = String(engineConfigCount);
    engineStateSummary.hidden = false;
  }

  const newExecutionKeys = executionKeys.filter((key) => {
    if (executionEntryLabels.has(key.label)) return false;
    executionEntryLabels.add(key.label);
    return true;
  });

  // Host/network configuration is necessary simulator setup, not a contract
  // state read. Keep the actual local pass count, but collapse those keys.
  mRounds.textContent = String(msg.roundIndex + 1);
  mKeys.textContent = String(executionEntryLabels.size);
  if (newExecutionKeys.length === 0) return;

  timelineEmpty.hidden = true;
  if (activeRound) activeRound.classList.remove("active");

  const col = document.createElement("div");
  col.className = "round active";

  const rnum = document.createElement("div");
  rnum.className = "rnum";
  rnum.textContent = `R${msg.roundIndex}`;
  col.appendChild(rnum);

  // usually one key per round; render the primary key's cell + labels
  const key = newExecutionKeys[0]!;
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

  // Append only transaction-relevant entries to the state rail.
  for (const k of newExecutionKeys) appendSnapshotRow(k);

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
  mKeys.textContent = String(executionEntryLabels.size);
  setMetricNum(mElapsed, msg.elapsedMs.toFixed(0));

  resultPanel.hidden = false;
  resultNote.hidden = false;
  rErr.hidden = true;
  resultPanel.classList.remove("error");
  resultContext.hidden = false;
  const liveWorkbench =
    msg.requestKind === "contract" || msg.requestKind === "xdr";
  rNetwork.textContent = msg.requestKind === "xdr"
    ? "Transaction XDR · Testnet state · local execution"
    : msg.requestKind === "contract"
      ? "Contract call · Testnet state · local execution"
    : msg.requestKind === "upload"
      ? "local Wasm · saved snapshot"
      : mode === "live"
        ? "Testnet state · local execution"
        : "saved snapshot · local execution";
  rLedger.textContent = msg.ledgerSequence
    ? `ledger ${fmtInt(msg.ledgerSequence)}`
    : "deterministic snapshot";

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

  resultNote.textContent = liveWorkbench
    ? `RPC supplied ledger entries at Testnet ledger ${fmtInt(msg.ledgerSequence ?? 0)}. The transaction executed in this Worker and was not submitted.`
    : "Deterministic SSIM bytes — the same rerun loop yields the same result in this Worker, the native runner, and CI.";

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

  // --- footprint (contract access separated from host/runtime support) ---
  renderExecutionFootprint(msg);
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

  // --- transaction-wide state impact + what submission would still require ---
  renderStateImpact(msg.stateChanges);
  renderSubmissionRequirements(msg);

  // --- ssim byte map ---
  renderByteMap(msg.regions, msg.resultHex, msg.resultLen, msg.diagnosticEventCount, msg.modifiedCount);
}

function renderStateImpact(
  changes: Extract<WorkerToMain, { type: "sim-result" }>["stateChanges"],
): void {
  impactList.replaceChildren();
  const visible = (changes ?? []).filter(
    (change) => change.kind !== "ConfigSetting",
  );
  const contractChanges = visible.filter((change) => change.category !== "maintenance");
  const maintenance = visible.filter((change) => change.category === "maintenance");
  if (contractChanges.length === 0) {
    const empty = document.createElement("p");
    empty.className = "fp-empty";
    empty.textContent = "No contract storage writes. This invocation is read-only.";
    impactList.appendChild(empty);
  }
  for (const change of contractChanges) {
    const item = document.createElement("div");
    item.className = `impact-item ${change.change}`;
    const head = document.createElement("div");
    head.className = "impact-head";
    const kind = document.createElement("b");
    kind.textContent = change.kind;
    const badge = document.createElement("span");
    badge.textContent = change.change;
    head.append(kind, badge);
    const key = document.createElement("div");
    key.className = "impact-key";
    key.textContent = change.key;
    const values = document.createElement("div");
    values.className = "impact-values";
    const before = document.createElement("code");
    before.textContent = change.before ?? "∅";
    const arrow = document.createElement("span");
    arrow.textContent = "→";
    const after = document.createElement("code");
    after.textContent = change.after ?? "∅";
    values.append(before, arrow, after);
    item.append(head, key, values);
    impactList.appendChild(item);
  }
  if (maintenance.length > 0) {
    const note = document.createElement("div");
    note.className = "impact-maintenance";
    const label = document.createElement("b");
    label.textContent = "Host-managed restoration";
    const detail = document.createElement("span");
    detail.textContent = `${maintenance.length} archived ${maintenance.length === 1 ? "entry" : "entries"} would be restored for this call (${maintenance.map((change) => change.kind).join(", ")}).`;
    note.append(label, detail);
    impactList.appendChild(note);
  }
}

function renderSubmissionRequirements(
  msg: Extract<WorkerToMain, { type: "sim-result" }>,
): void {
  const restoreCount = (msg.stateChanges ?? []).filter(
    (change) => change.category === "maintenance",
  ).length;
  submitStatus.textContent = msg.ok
    ? restoreCount > 0
      ? `preflight complete · restores ${restoreCount} archived ${restoreCount === 1 ? "entry" : "entries"} · not submitted`
      : "preflight complete · not submitted"
    : "fix simulation error before submission";
  submitSource.textContent = msg.sourceAccount
    ? `${msg.sourceAccount.slice(0, 6)}…${msg.sourceAccount.slice(-6)}`
    : "source comes from final envelope";
  const auth = msg.auth ?? [];
  submitAuth.textContent =
    auth.length === 0
      ? "no contract auth recorded"
      : `${auth.length} contract auth ${auth.length === 1 ? "entry" : "entries"} to authorize`;
  submitFee.textContent = msg.resources
    ? `${fmtInt(Number(msg.resources.resourceFee))} stroops minimum resource fee`
    : "resource fee unavailable";
}

function isRuntimeFootprintKey(key: FootprintKey): boolean {
  return key.role === "contract-instance" || key.role === "contract-code";
}

function semanticFootprintKind(key: FootprintKey): string {
  if (key.role === "contract-storage") return "Contract storage";
  if (key.role === "contract-instance") return "Contract instance";
  if (key.role === "contract-code") return "Wasm code";
  return key.kind;
}

function renderExecutionFootprint(
  msg: Extract<WorkerToMain, { type: "sim-result" }>,
): void {
  const readOnly = (msg.readOnly ?? []).filter((key) => key.kind !== "ConfigSetting");
  const readWrite = (msg.readWrite ?? []).filter((key) => key.kind !== "ConfigSetting");
  const contractReads = readOnly.filter((key) => !isRuntimeFootprintKey(key));
  const contractMayWrite = readWrite.filter((key) => !isRuntimeFootprintKey(key));
  const runtime = [
    ...readOnly.filter(isRuntimeFootprintKey).map((key) => ({ key, mode: "read-only" })),
    ...readWrite.filter(isRuntimeFootprintKey).map((key) => ({ key, mode: "read-write" })),
  ];
  const maintenanceKinds = new Set(
    (msg.stateChanges ?? [])
      .filter((change) => change.category === "maintenance")
      .map((change) => change.kind),
  );

  renderFootprint(fpRo, fpRoCount, contractReads);
  renderFootprint(fpRw, fpRwCount, contractMayWrite);
  renderRuntimeFootprint(runtime, maintenanceKinds);
  fpProtocolSummary.textContent = `${readOnly.length} read-only · ${readWrite.length} read-write`;
}

function renderFootprint(
  list: HTMLElement,
  counter: HTMLElement,
  keys: FootprintKey[],
): void {
  list.replaceChildren();
  counter.textContent = String(keys.length);
  if (keys.length === 0) {
    const p = document.createElement("p");
    p.className = "fp-empty";
    p.textContent = "none";
    list.appendChild(p);
    return;
  }
  for (const k of keys) {
    const row = document.createElement("div");
    row.className = "fp-key";
    const kind = document.createElement("div");
    kind.className = "fp-kind";
    kind.textContent = semanticFootprintKind(k);
    const detail = document.createElement("div");
    detail.className = "fp-detail";
    detail.textContent = k.detail || k.label;
    detail.title = k.label;
    row.append(kind, detail);
    list.appendChild(row);
  }
}

function renderRuntimeFootprint(
  entries: { key: FootprintKey; mode: string }[],
  maintenanceKinds: Set<string>,
): void {
  fpRuntime.replaceChildren();
  fpRuntimeCount.textContent = String(entries.length);
  fpRuntimeWrap.hidden = entries.length === 0;
  for (const { key, mode } of entries) {
    const restored =
      mode === "read-write" &&
      maintenanceKinds.has(key.role === "contract-code" ? "ContractCode" : "ContractData");
    const action = restored ? "Restore" : mode === "read-only" ? "Load" : "May update";
    const row = document.createElement("div");
    row.className = `fp-key runtime ${restored ? "restored" : "loaded"}`;
    const kind = document.createElement("div");
    kind.className = "fp-kind";
    kind.textContent = `${action} ${semanticFootprintKind(key)}`;
    const detail = document.createElement("div");
    detail.className = "fp-detail";
    detail.textContent = key.detail || key.label;
    detail.title = `${key.label} · protocol ${mode}`;
    row.append(kind, detail);
    fpRuntime.appendChild(row);
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
  const rpcFailure = /rpc|testnet|fetch|network|ledger advanced/i.test(message);
  rValue.textContent = rpcFailure ? "testnet state unavailable" : "simulation failed";
  rLen.textContent = "—";
  rSha.textContent = "—";
  rBadge.classList.add("hidden");
  rErr.hidden = false;
  rErr.textContent = rpcFailure ? `${message} — retry to pin a fresh ledger.` : message;
}

// ---- deployed Testnet contract --------------------------------------------
function renderContractArgs(): void {
  contractArgs.replaceChildren();
  contractErr.hidden = true;
  const info = contractInfo;
  if (!info?.ok) return;
  if (info.ladder === "spec") {
    const fnInfo =
      info.fns.find((fn) => fn.name === contractFn.value) ?? info.fns[0];
    if (!fnInfo) return;
    for (const arg of fnInfo.args) {
      const field = document.createElement("div");
      field.className = "up-arg";
      const label = document.createElement("label");
      const b = document.createElement("b");
      b.textContent = arg.name;
      label.append(b, document.createTextNode(` ${arg.input}`));
      field.appendChild(label);
      let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      if (arg.input === "bool") {
        const select = document.createElement("select");
        for (const value of ["true", "false"]) {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = value;
          select.appendChild(option);
        }
        input = select;
      } else if (arg.input === "xdr") {
        const textarea = document.createElement("textarea");
        textarea.rows = 2;
        textarea.placeholder = ARG_PLACEHOLDER.xdr!;
        input = textarea;
      } else {
        const text = document.createElement("input");
        text.type = "text";
        text.placeholder = ARG_PLACEHOLDER[arg.input] ?? "";
        if (arg.name === "author" && arg.input === "address") {
          text.value = DEFAULT_SIMULATION_SOURCE;
        } else if (arg.name === "message" && arg.input === "string") {
          text.value = "Simulated locally with soroban-sim";
        }
        input = text;
      }
      input.dataset.arg = arg.name;
      field.appendChild(input);
      contractArgs.appendChild(field);
    }
    return;
  }

  const field = document.createElement("div");
  field.className = "up-arg";
  const label = document.createElement("label");
  const b = document.createElement("b");
  b.textContent = "args";
  label.append(
    b,
    document.createTextNode(" base64 ScVal XDR, one per line (optional)"),
  );
  const textarea = document.createElement("textarea");
  textarea.rows = 4;
  textarea.placeholder = "AAAAAwAAAAc=";
  textarea.dataset.arg = "raw-args";
  field.append(label, textarea);
  contractArgs.appendChild(field);
}

function onContractInfo(msg: ContractInfoMsg): void {
  contractLoadBtn.disabled = false;
  contractLoadBtn.textContent = "Reload contract interface";
  contractErr.hidden = true;
  contractErr.textContent = "";
  if (!msg.ok) {
    contractInfo = undefined;
    contractMeta.hidden = true;
    contractFnRow.hidden = true;
    contractArgs.replaceChildren();
    contractErr.hidden = false;
    contractErr.textContent = msg.error ?? "could not load this Testnet contract";
    renderReqNote();
    syncRunAvailability();
    return;
  }

  contractInfo = msg;
  contractMeta.hidden = false;
  contractExecutable.textContent =
    msg.executable === "wasm" ? "Wasm contract" : "Stellar Asset Contract";
  contractSpec.textContent =
    msg.ladder === "spec" ? `${msg.fns.length} typed functions` : "raw ScVal inputs";
  contractLedger.textContent = msg.ledgerSequence
    ? `loaded at ledger ${fmtInt(msg.ledgerSequence)}`
    : "Testnet";
  contractFnRow.hidden = false;
  contractFn.replaceChildren();
  if (msg.ladder === "spec") {
    contractFn.hidden = false;
    contractFnFree.hidden = true;
    for (const fn of msg.fns) {
      const option = document.createElement("option");
      option.value = fn.name;
      option.textContent = `${fn.name}(${fn.args.map((arg) => arg.name).join(", ")})`;
      contractFn.appendChild(option);
    }
    if (msg.fns.some((fn) => fn.name === "get_message")) {
      contractFn.value = "get_message";
    }
  } else {
    contractFn.hidden = true;
    contractFnFree.hidden = false;
  }
  renderContractArgs();
  renderReqNote();
  invalidateRunUI();
  syncRunAvailability();
}

function loadContract(): void {
  if (!workerReady || running) return;
  const contractId = contractIdInput.value.trim();
  if (!contractId) {
    contractErr.hidden = false;
    contractErr.textContent = "enter a Testnet C-address";
    return;
  }
  activateRequest("contract");
  contractInfo = undefined;
  contractLoadId += 1;
  contractLoadBtn.disabled = true;
  contractLoadBtn.textContent = "Loading from Testnet…";
  contractMeta.hidden = true;
  contractFnRow.hidden = true;
  contractArgs.replaceChildren();
  contractErr.hidden = true;
  syncRunAvailability();
  worker.postMessage({
    type: "load-contract",
    id: contractLoadId,
    contractId,
  });
}

function gatherContractInvocation():
  | { contractId: string; fn: string; args: string[]; raw: boolean }
  | undefined {
  const info = contractInfo;
  if (!info?.ok) {
    contractErr.hidden = false;
    contractErr.textContent = "load the contract interface first";
    return undefined;
  }
  contractErr.hidden = true;
  if (info.ladder === "spec") {
    const fn = contractFn.value;
    const inputs = contractArgs.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input, select, textarea");
    const args: string[] = [];
    for (const input of inputs) {
      if (input.value.trim() === "") {
        contractErr.hidden = false;
        contractErr.textContent = `argument "${input.dataset.arg}" is required`;
        return undefined;
      }
      args.push(input.value);
    }
    return { contractId: info.contractId, fn, args, raw: false };
  }
  const fn = contractFnFree.value.trim();
  if (!fn) {
    contractErr.hidden = false;
    contractErr.textContent = "enter a function name";
    return undefined;
  }
  const textarea = contractArgs.querySelector<HTMLTextAreaElement>("textarea");
  const args = (textarea?.value ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return { contractId: info.contractId, fn, args, raw: true };
}

contractLoadBtn.addEventListener("click", loadContract);
contractIdInput.addEventListener("input", () => {
  contractInfo = undefined;
  contractMeta.hidden = true;
  contractFnRow.hidden = true;
  contractArgs.replaceChildren();
  contractLoadBtn.textContent = "Load contract interface";
  contractErr.hidden = true;
  invalidateRunUI();
  renderReqNote();
  syncRunAvailability();
});
contractFn.addEventListener("change", () => {
  renderContractArgs();
  invalidateRunUI();
});
contractFnFree.addEventListener("input", invalidateRunUI);
contractArgs.addEventListener("input", invalidateRunUI);
transactionXdr.addEventListener("input", () => {
  xdrErr.hidden = true;
  invalidateRunUI();
  syncRunAvailability();
});

// ---- upload-any-contract ---------------------------------------------------
uploadBtn.addEventListener("click", () => uploadFile.click());
uploadFile.addEventListener("change", async () => {
  const file = uploadFile.files?.[0];
  if (!file) return;
  invalidateRunUI();
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
  activateRequest("upload");
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
upFn.addEventListener("change", () => {
  renderUploadArgs();
  invalidateRunUI();
});
upFnFree.addEventListener("input", invalidateRunUI);
upArgs.addEventListener("input", invalidateRunUI);
cacheBox.addEventListener("change", invalidateRunUI);

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

// ---- execution trace -------------------------------------------------------
debugRunBtn.addEventListener("click", () => {
  if (debuggableRunId === undefined || debugPending) return;
  debugPending = true;
  debugRunBtn.disabled = true;
  debugRunBtn.textContent = "Building trace…";
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
  dbgRaw.checked = false;
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
  renderTraceSteps();
  debuggerEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderTraceSteps(preserveSeq?: number): void {
  const msg = debugData;
  if (!msg) return;

  debugSteps = dbgRaw.checked
    ? msg.steps
    : msg.steps.filter(
        (step) =>
          (step.kind !== "env-call" && step.kind !== "env-ret") || step.storage,
      );

  const steps = debugSteps;
  const hasTrace = steps.length > 0;
  dbgScrub.hidden = !hasTrace;
  dbgDetail.hidden = !hasTrace;
  if (!hasTrace) {
    return;
  }

  const storageCount = steps.reduce((n, s) => n + (s.storage ? 1 : 0), 0);
  const viewLabel = dbgRaw.checked ? "raw steps" : "semantic steps";
  const rawSuffix = dbgRaw.checked
    ? ""
    : ` · ${fmtInt(msg.steps.length)} raw steps available`;
  dbgCount.textContent = `${fmtInt(steps.length)} ${viewLabel}${rawSuffix} · ${fmtInt(
    msg.frames.length,
  )} frames · ${fmtInt(storageCount)} storage ops`;

  // ticks
  dbgTicks.replaceChildren();
  activeTick = undefined;
  steps.forEach((step, i) => {
    const t = document.createElement("button");
    t.type = "button";
    t.className = `dtick ${step.kind}${step.storage ? " storage" : ""}`;
    t.title = `#${step.seq} ${step.display}`;
    t.addEventListener("click", () => setDebugStep(i));
    dbgTicks.appendChild(t);
  });

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
    steps.forEach((step, i) => {
      if (!step.storage) return;
      const mark = document.createElement("button");
      mark.type = "button";
      mark.className = "lane-mark";
      mark.style.left = `${(i / denom) * 100}%`;
      mark.title = `#${step.seq} ${step.display}`;
      mark.addEventListener("click", () => setDebugStep(i));
      laneMarkBySeq.set(step.seq, mark);
      dbgLane.appendChild(mark);
    });
  }

  dbgSlider.min = "0";
  dbgSlider.max = String(steps.length - 1);
  if (preserveSeq === undefined) setDebugStep(0);
  else setDebugStepBySeq(preserveSeq);
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
      el.addEventListener("click", () => setDebugStepBySeq(frame.pushSeq));
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
  if (!data || debugSteps.length === 0) return;
  dbgIdx = Math.max(0, Math.min(i, debugSteps.length - 1));
  const step = debugSteps[dbgIdx]!;
  const previous = debugSteps[dbgIdx - 1];
  const dCpu = previous ? Math.max(0, step.cpu - previous.cpu) : step.dCpu;
  const dMem = previous ? Math.max(0, step.mem - previous.mem) : step.dMem;

  dbgSlider.value = String(dbgIdx);
  dbgPos.textContent = `step ${dbgIdx + 1} / ${debugSteps.length}`;
  dbgDisplay.textContent = step.display;
  dbgKind.textContent =
    (KIND_LABEL[step.kind] ?? step.kind) + (step.storage ? " · storage" : "");
  dbgName.textContent = step.name || "—";
  dbgDcpu.textContent = fmtDelta(dCpu);
  dbgDmem.textContent = fmtDelta(dMem);

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

  const last = debugSteps.length - 1;
  dbgBack.disabled = dbgIdx === 0;
  dbgFwd.disabled = dbgIdx === last;
  dbgOver.disabled = dbgIdx === last;
  dbgStorageBtn.disabled = !debugSteps.some(
    (step, index) => index > dbgIdx && step.storage,
  );
}

function setDebugStepBySeq(seq: number): void {
  if (debugSteps.length === 0) return;
  const exact = debugSteps.findIndex((step) => step.seq === seq);
  if (exact >= 0) {
    setDebugStep(exact);
    return;
  }
  const after = debugSteps.findIndex((step) => step.seq > seq);
  setDebugStep(after >= 0 ? after : debugSteps.length - 1);
}

dbgSlider.addEventListener("input", () => {
  setDebugStep(Number(dbgSlider.value));
});
dbgBack.addEventListener("click", () => setDebugStep(dbgIdx - 1));
dbgFwd.addEventListener("click", () => setDebugStep(dbgIdx + 1));
dbgOver.addEventListener("click", () => {
  const step = debugSteps[dbgIdx];
  if (!step) return;
  // On a frame push, jump past the matching pop; otherwise a single step.
  if (step.kind === "push-ctx" && step.matchPop >= 0) {
    const afterPop = debugSteps.findIndex(
      (candidate) => candidate.seq > step.matchPop,
    );
    setDebugStep(afterPop >= 0 ? afterPop : debugSteps.length - 1);
  } else {
    setDebugStep(dbgIdx + 1);
  }
});
dbgStorageBtn.addEventListener("click", () => {
  const next = debugSteps.findIndex(
    (step, index) => index > dbgIdx && step.storage,
  );
  if (next >= 0) setDebugStep(next);
});
dbgRaw.addEventListener("change", () => {
  const seq = debugSteps[dbgIdx]?.seq;
  renderTraceSteps(seq);
});
window.addEventListener("keydown", (e) => {
  if (debuggerEl.hidden || !debugData || debugSteps.length === 0) return;
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
contractLoadBtn.disabled = true;
syncModeUi();
renderFixtures();
renderReqNote();
syncRunAvailability();
spawnWorker(true);

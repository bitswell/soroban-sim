import "./styles.css";
import {
  FIXTURES,
  fixtureById,
  LIVE_FIXTURE_ID,
} from "./fixtures.js";
import type { DemoMode, RoundMsg, WorkerToMain } from "./protocol.js";

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
    btn.setAttribute("aria-pressed", String(f.id === selectedId));
    const tag = f.liveCapable
      ? `<span class="fx-tag">live</span>`
      : "";
    btn.innerHTML = `${tag}<div>${f.label}</div><div class="fx-call">${f.call}</div>`;
    btn.addEventListener("click", () => {
      if (btn.disabled || running) return;
      selectedId = f.id;
      renderFixtures();
      renderReqNote();
    });
    fixturesEl.appendChild(btn);
  }
}

function renderReqNote(): void {
  reqNote.textContent = fixtureById(selectedId).note;
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

// ---- boot ------------------------------------------------------------------
renderFixtures();
renderReqNote();
runBtn.disabled = true;
spawnWorker(true);

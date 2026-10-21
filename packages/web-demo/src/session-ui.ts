/**
 * The network-session panel and the page's half of the virtual RPC.
 *
 * The session itself runs in a Web Worker (session-worker.ts). This module
 * registers the service worker (public/sw.js) that serves the virtual RPC
 * URL, relays its requests to the session worker, and renders the fork, the
 * step timeline and the report. main.ts uses it to point the wallet
 * pre-submit flow at the session and to open a step in the time-travel
 * debugger.
 */
import type { Keypair } from "@stellar/stellar-sdk";
import type { SessionReportResult, StepDebugContext } from "@theahaco/soroban-sim";
import {
  MAINNET_PASSPHRASE,
  MAINNET_RPC_URL,
  type SessionRecord,
  SessionStore,
  TESTNET_PASSPHRASE,
  TESTNET_RPC_URL,
  throwawayKeypair,
} from "@theahaco/soroban-sim/browser";
import {
  type FromSessionWorker,
  type SessionRequest,
  type SessionResult,
  type SessionStepView,
  type SessionStepsView,
  type SessionSummary,
  type SwRpcRequest,
  VIRTUAL_RPC_PREFIX,
} from "./session-protocol.js";

export interface SessionHostHooks {
  /** Trace one session step in the time-travel debugger. */
  debugStep(context: StepDebugContext): void;
  /** The open session changed: opened, closed, a step applied. */
  onChange(summary: SessionSummary | undefined): void;
}

const BASE = import.meta.env.BASE_URL;
const OPEN_SESSION_KEY = "soroban-sim.session.open";
/** What the throwaway fee payer starts with: enough for big uploads. */
const PAYER_XLM = 10_000;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

export function xlm(stroops: number): string {
  const sign = stroops < 0 ? "-" : "";
  const abs = Math.abs(stroops);
  return `${sign}${Math.floor(abs / 1e7)}.${String(abs % 1e7).padStart(7, "0")}`;
}

function short(text: string, keep = 6): string {
  return text.length > keep * 2 + 1 ? `${text.slice(0, keep)}…${text.slice(-keep)}` : text;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { className?: string; text?: string; title?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.title) node.title = props.title;
  node.append(...children);
  return node;
}

function download(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = el("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Register the virtual RPC service worker; true once it controls the page. */
async function registerVirtualRpc(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE });
  await navigator.serviceWorker.ready;
  if (navigator.serviceWorker.controller) return true;
  // First visit: the worker claims this page when it activates.
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(Boolean(navigator.serviceWorker.controller)), 10_000);
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      { once: true },
    );
  });
}

export class SessionHost {
  summary: SessionSummary | undefined;
  /** Resolves true once the virtual RPC URL is served (after the first session opens). */
  virtualRpcReady: Promise<boolean> = Promise.resolve(false);
  /** Started with the first session, so pages that never fork pay nothing. */
  private worker: Worker | undefined;
  private workerReady: Promise<void> | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: SessionResult) => void; reject: (e: Error) => void }>();
  private steps: SessionStepsView | undefined;
  private report: SessionReportResult | undefined;
  private readonly expanded = new Set<number>();

  // panel elements
  private readonly network = $<HTMLSelectElement>("session-network");
  private readonly rpcUrl = $<HTMLInputElement>("session-rpc-url");
  private readonly startBtn = $<HTMLButtonElement>("session-start");
  private readonly state = $("session-state");
  private readonly saved = $("session-saved");
  private readonly progress = $("session-progress");
  private readonly err = $("session-err");
  private readonly openPanel = $("session-open");
  private readonly pill = $("session-pill");
  private readonly forkPoint = $("session-fork-point");
  private readonly next = $("session-next");
  private readonly rpcCode = $("session-rpc");
  private readonly payerCode = $("session-payer");
  private readonly mainnetWarning = $("session-mainnet-warning");
  private readonly advanceN = $<HTMLInputElement>("session-advance-n");
  private readonly snapshots = $<HTMLSelectElement>("session-snapshots");
  private readonly revertBtn = $<HTMLButtonElement>("session-revert");
  private readonly envelope = $<HTMLTextAreaElement>("session-envelope");
  private readonly planFile = $<HTMLInputElement>("session-plan-file");
  private readonly planStatus = $("session-plan-status");
  private readonly timeline = $("session-timeline");
  private readonly stepList = $("session-steps");
  private readonly stepCount = $("session-step-count");
  private readonly reportPanel = $("session-report");
  private readonly verdict = $("session-verdict");
  private readonly replayable = $("session-replayable");
  private readonly reportBody = $("session-report-body");

  constructor(private readonly hooks: SessionHostHooks) {
    // A tab without a session answers the relay at once, so the service
    // worker moves on to the tab that has it.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (event: MessageEvent<SwRpcRequest>) => {
        const msg = event.data;
        const [port] = event.ports;
        if (msg?.type !== "soroban-sim/rpc" || !port) return;
        if (this.worker) this.worker.postMessage({ type: "rpc", sessionId: msg.sessionId, body: msg.body }, [port]);
        else port.postMessage({ held: false });
      });
      navigator.serviceWorker.startMessages();
    }
    this.bind();
    void this.boot();
  }

  /** Start the session worker and the virtual RPC service worker, once. */
  private started(): { worker: Worker; ready: Promise<void> } {
    if (this.worker && this.workerReady) return { worker: this.worker, ready: this.workerReady };
    const worker = new Worker(new URL("./session-worker.ts", import.meta.url), { type: "module" });
    this.workerReady = new Promise((resolve) => {
      worker.addEventListener("message", (e: MessageEvent<FromSessionWorker>) => {
        if (e.data.type === "ready") resolve();
      });
    });
    worker.addEventListener("message", (e: MessageEvent<FromSessionWorker>) => this.onWorker(e.data));
    this.worker = worker;
    this.virtualRpcReady = registerVirtualRpc().catch(() => false);
    return { worker, ready: this.workerReady };
  }

  /** The URL stellar-sdk can use as its RPC server for the open session. */
  virtualRpcUrl(summary = this.summary): string | undefined {
    if (!summary) return undefined;
    return `${location.origin}${BASE}${VIRTUAL_RPC_PREFIX}${encodeURIComponent(summary.id)}`;
  }

  /**
   * The virtual RPC URL once the service worker serves it. On a first visit
   * the worker takes control of the page shortly after the session opens.
   */
  async virtualRpc(): Promise<string> {
    const url = this.virtualRpcUrl();
    if (!url) throw new Error("no session is open");
    if (!(await this.virtualRpcReady)) {
      throw new Error("the virtual RPC needs a service worker, which this browser does not run here (use https or localhost)");
    }
    return url;
  }

  /** The session's throwaway fee payer key (derived from its label). */
  payerKeypair(): Keypair {
    if (!this.summary) throw new Error("no session is open");
    return throwawayKeypair(this.summary.payerLabel);
  }

  async request<T extends SessionResult["type"]>(request: SessionRequest): Promise<Extract<SessionResult, { type: T }>> {
    const { worker, ready } = this.started();
    await ready;
    const id = this.nextId++;
    const result = await new Promise<SessionResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ type: "request", id, request });
    });
    return result as Extract<SessionResult, { type: T }>;
  }

  /** Call a facade method (state changes are logged for replay). */
  async call<T = unknown>(method: string, params: unknown = {}): Promise<T> {
    const r = await this.request<"called">({ type: "call", method, params });
    this.setSummary(r.summary);
    return r.result as T;
  }

  /** Re-read the timeline and the report. */
  async refresh(): Promise<void> {
    if (!this.summary) return;
    const [steps, report] = await Promise.all([this.request<"steps">({ type: "steps" }), this.request<"report">({ type: "report" })]);
    this.steps = steps.steps;
    this.report = report.report;
    this.renderSteps();
    this.renderReport();
  }

  // --- worker traffic ---

  private onWorker(msg: FromSessionWorker): void {
    switch (msg.type) {
      case "response":
      case "error": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.type === "response") p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.message), { code: msg.code }));
        return;
      }
      case "progress":
        this.showProgress(msg.message);
        return;
      case "changed":
        this.setSummary(msg.summary);
        void this.refresh();
        return;
      case "ready":
        return;
    }
  }

  // --- panel ---

  private bind(): void {
    this.network.addEventListener("change", () => {
      this.rpcUrl.hidden = this.network.value !== "custom";
    });
    this.startBtn.addEventListener("click", () => void this.start());
    $("session-close").addEventListener("click", () => void this.close());
    $("session-advance").addEventListener("click", () =>
      void this.act(() => this.call("fork_advanceLedgers", { ledgers: Math.max(1, Number(this.advanceN.value) || 1) })),
    );
    $("session-snapshot").addEventListener("click", () =>
      void this.act(() => this.call("fork_snapshot", { label: `before step ${(this.steps?.steps.length ?? 0) + 1}` })),
    );
    this.revertBtn.addEventListener("click", () =>
      void this.act(() => this.call("fork_revert", { id: Number(this.snapshots.value) })),
    );
    $("session-envelope-submit").addEventListener("click", () => void this.submitEnvelope());
    this.planFile.addEventListener("change", () => void this.importPlan());
    $("session-report-md").addEventListener("click", () => {
      if (this.report) download(`session-${this.summary?.id ?? "report"}.md`, "text/markdown", this.report.markdown);
    });
    $("session-report-json").addEventListener("click", () => {
      if (this.report) download(`session-${this.summary?.id ?? "report"}.json`, "application/json", JSON.stringify(this.report.report, null, 2));
    });
  }

  private async boot(): Promise<void> {
    this.startBtn.disabled = false;
    const sessions = await this.renderSaved();
    let last: string | null = null;
    try {
      last = localStorage.getItem(OPEN_SESSION_KEY);
    } catch {
      last = null;
    }
    // The session that was open before a reload opens again.
    if (last && sessions.some((s) => s.id === last)) await this.resume(last);
  }

  private networkChoice(): { networkName: string; rpcUrl: string; expectedPassphrase?: string } {
    switch (this.network.value) {
      case "mainnet":
        return { networkName: "mainnet", rpcUrl: MAINNET_RPC_URL, expectedPassphrase: MAINNET_PASSPHRASE };
      case "custom": {
        const url = this.rpcUrl.value.trim();
        if (!/^https?:\/\//.test(url)) throw new Error("enter the RPC URL to fork (http or https)");
        return { networkName: url, rpcUrl: url };
      }
      default:
        return { networkName: "testnet", rpcUrl: TESTNET_RPC_URL, expectedPassphrase: TESTNET_PASSPHRASE };
    }
  }

  private async start(): Promise<void> {
    await this.act(async () => {
      const choice = this.networkChoice();
      this.startBtn.disabled = true;
      try {
        const r = await this.request<"opened">({ type: "start", ...choice, payerXlm: PAYER_XLM });
        this.opened(r.summary);
      } finally {
        this.startBtn.disabled = false;
      }
    });
    await this.renderSaved();
  }

  private async resume(id: string): Promise<void> {
    await this.act(async () => {
      const r = await this.request<"opened">({ type: "resume", id });
      this.opened(r.summary);
      if (r.replayed > 0) this.showProgress(`Resumed: replayed ${r.replayed} logged call${r.replayed === 1 ? "" : "s"} from IndexedDB`);
    });
  }

  private async close(): Promise<void> {
    await this.request({ type: "close" });
    try {
      localStorage.removeItem(OPEN_SESSION_KEY);
    } catch {
      // Per-viewer convenience only.
    }
    this.steps = undefined;
    this.report = undefined;
    this.setSummary(undefined);
  }

  private opened(summary: SessionSummary): void {
    try {
      localStorage.setItem(OPEN_SESSION_KEY, summary.id);
    } catch {
      // Without storage the session still works; it just does not reopen itself.
    }
    this.expanded.clear();
    this.setSummary(summary);
    void this.refresh();
  }

  private setSummary(summary: SessionSummary | undefined): void {
    this.summary = summary;
    this.openPanel.hidden = !summary;
    this.timeline.hidden = !summary;
    this.reportPanel.hidden = !summary;
    this.state.textContent = summary ? `open: ${summary.title}` : "no session open";
    if (summary) {
      const mainnet = summary.passphrase === MAINNET_PASSPHRASE;
      this.pill.textContent = `${summary.networkName} fork`;
      this.pill.classList.toggle("danger", mainnet);
      this.forkPoint.textContent = `ledger ${summary.forkLedger} · protocol ${summary.protocolVersion}`;
      this.next.textContent = `${summary.next.ledger} · closes ${new Date(summary.next.closeTime * 1000).toISOString().replace(".000Z", "Z")}`;
      this.rpcCode.textContent = this.virtualRpcUrl(summary) ?? "—";
      this.payerCode.textContent = summary.payer;
      this.payerCode.title = `throwaway key "${summary.payerLabel}", funded by an override`;
      this.mainnetWarning.hidden = !mainnet;
      this.snapshots.replaceChildren(...summary.snapshots.map((id) => el("option", { text: `snapshot #${id}` })));
      summary.snapshots.forEach((id, i) => ((this.snapshots.options[i] as HTMLOptionElement).value = String(id)));
      this.revertBtn.disabled = summary.snapshots.length === 0;
    }
    this.hooks.onChange(summary);
  }

  /** The stored sessions, read straight from IndexedDB (no worker needed). */
  private async renderSaved(): Promise<SessionRecord[]> {
    let sessions: SessionRecord[] = [];
    try {
      const store = await SessionStore.open();
      sessions = await store.list();
      store.close();
    } catch {
      // Without IndexedDB nothing is stored; sessions still run.
    }
    this.saved.replaceChildren(...sessions.map((s) => this.savedRow(s)));
    return sessions;
  }

  private savedRow(s: SessionRecord): HTMLElement {
    const resume = el("button", { text: "resume" });
    resume.type = "button";
    resume.addEventListener("click", () => void this.resume(s.id));
    const del = el("button", { text: "delete" });
    del.type = "button";
    del.addEventListener("click", () =>
      void this.act(async () => {
        await this.request({ type: "delete", id: s.id });
        if (this.summary?.id === s.id) this.setSummary(undefined);
        await this.renderSaved();
      }),
    );
    return el(
      "div",
      { className: "session-saved-row" },
      el("span", { text: `${s.title} · ${s.opCount} logged`, title: `stored ${new Date(s.createdAt).toLocaleString()}` }),
      resume,
      del,
    );
  }

  private async submitEnvelope(): Promise<void> {
    const xdr = this.envelope.value.trim();
    if (!xdr) return;
    await this.act(async () => {
      const sent = await this.call<{ status: string; hash: string; errorResultXdr?: string }>("sendTransaction", { transaction: xdr });
      this.showProgress(`sendTransaction: ${sent.status} ${short(sent.hash, 8)}`);
      this.envelope.value = "";
    });
  }

  private async importPlan(): Promise<void> {
    const files = [...(this.planFile.files ?? [])];
    this.planFile.value = "";
    const plan = files.find((f) => /\.(ya?ml|json)$/i.test(f.name));
    if (!plan || !this.summary) {
      this.showError("choose a plan file (.yaml, .yml or .json), with the Wasm files its upload steps name");
      return;
    }
    await this.act(async () => {
      const { runPlan } = await import("./session-plan.js");
      const wasm = new Map<string, Uint8Array>();
      for (const f of files.filter((f) => /\.wasm$/i.test(f.name))) wasm.set(f.name, new Uint8Array(await f.arrayBuffer()));
      const summary = this.summary!;
      const result = await runPlan(await plan.text(), {
        rpcUrl: await this.virtualRpc(),
        passphrase: summary.passphrase,
        wasm,
        call: (method, params) => this.call(method, params),
        onProgress: (line) => {
          this.planStatus.textContent = line;
          void this.refresh();
        },
      });
      this.planStatus.textContent = result.passed
        ? `plan "${result.name}": ${result.steps} steps, all as expected`
        : `plan "${result.name}" stopped: ${result.failures.join("; ")}`;
    });
  }

  /** Run a panel action, showing its error and refreshing the session. */
  private async act(action: () => Promise<unknown>): Promise<void> {
    this.err.hidden = true;
    try {
      await action();
    } catch (error) {
      this.showError(error instanceof Error ? error.message : String(error));
    } finally {
      this.progress.hidden = this.progress.textContent === "";
      await this.refresh().catch(() => undefined);
    }
  }

  private showError(message: string): void {
    this.err.hidden = false;
    this.err.textContent = message;
  }

  private showProgress(message: string): void {
    this.progress.hidden = false;
    this.progress.textContent = message;
  }

  // --- timeline ---

  private renderSteps(): void {
    const steps = this.steps?.steps ?? [];
    const txs = steps.filter((s) => s.kind === "transaction").length;
    this.stepCount.textContent = `${steps.length} step${steps.length === 1 ? "" : "s"} · ${txs} transaction${txs === 1 ? "" : "s"}`;
    if (steps.length === 0) {
      this.stepList.replaceChildren(el("li", { className: "fp-empty", text: "No steps yet: submit an envelope, send from the workbench, or import a plan." }));
      return;
    }
    this.stepList.replaceChildren(...steps.map((s) => this.stepItem(s)));
  }

  private stepItem(s: SessionStepView): HTMLElement {
    const li = el("li", { className: `session-step${s.reverted ? " reverted" : ""}` });
    li.dataset.step = String(s.index);
    li.dataset.outcome = s.outcome;
    const head = el(
      "button",
      { className: "session-step-head" },
      el("span", { className: "idx", text: `#${s.index}` }),
      el("span", { className: "kind", text: s.kind }),
      el("span", { className: "name", text: s.name, title: s.name }),
      el("span", { className: "ledger", text: `L${s.ledger}` }),
      el("span", { className: `session-outcome ${s.outcome}`, text: s.reverted ? `${s.outcome} · reverted` : s.outcome }),
    );
    head.type = "button";
    head.setAttribute("aria-expanded", String(this.expanded.has(s.index)));
    head.addEventListener("click", () => {
      if (this.expanded.has(s.index)) this.expanded.delete(s.index);
      else this.expanded.add(s.index);
      this.renderSteps();
    });
    li.append(head);
    if (this.expanded.has(s.index)) li.append(this.stepBody(s));
    return li;
  }

  private stepBody(s: SessionStepView): HTMLElement {
    const body = el("div", { className: "session-step-body" });
    if (s.detail) body.append(el("div", { text: s.detail }));
    const tx = s.tx;
    if (tx) {
      const kv = (k: string, v: string) => el("div", {}, el("span", { text: k }), el("b", { text: v }));
      body.append(
        el(
          "section",
          {},
          el("h4", { text: "Fees (XLM) and resources" }),
          el(
            "div",
            { className: "session-kv" },
            kv("fee bid", xlm(tx.fee_bid)),
            kv("resource fee", xlm(tx.resource_fee)),
            kv("non-refundable", xlm(tx.non_refundable_fee)),
            kv("refundable", xlm(tx.refundable_fee)),
            kv("inclusion", xlm(tx.inclusion_fee)),
            kv("charged", xlm(tx.fee_charged)),
            kv("refunded", xlm(tx.refunded)),
            kv("rent", xlm(tx.rent_fee)),
            kv("events", xlm(tx.events_fee)),
            kv("cpu used / declared", `${tx.cpu_insns} / ${tx.declared_cpu_insns}`),
            kv("writes", `${tx.write_bytes} / ${tx.declared_write_bytes} B`),
            kv("entries written", String(tx.entries_written)),
          ),
        ),
      );
      if (tx.replayable.length > 0) {
        body.append(
          el(
            "div",
            { className: "session-replayable" },
            el("b", { text: "Valid on the real network: " }),
            tx.replayable.join("; "),
          ),
        );
      }
      body.append(
        el("section", {}, el("h4", { text: "Envelope signatures" }), list(tx.signers.length ? tx.signers : ["none matched"])),
      );
    }
    if (s.auth.length > 0) {
      body.append(
        el(
          "section",
          {},
          el("h4", { text: "Authorization entries" }),
          list(
            s.auth.map((a) =>
              a.credentials === "source_account"
                ? `source account · ${a.invocation}`
                : `${a.credentials} ${a.address ?? ""} · ${a.signed ? "signed" : "UNSIGNED"} · until ledger ${a.expiration_ledger ?? "—"} · ${a.invocation}`,
            ),
          ),
        ),
      );
    }
    if (s.changes.length > 0) {
      body.append(
        el(
          "section",
          {},
          el("h4", { text: `Ledger changes (${s.changes.length})` }),
          list(
            s.changes.map((c) => {
              const values = [c.view.before, c.view.after].filter(Boolean).join(" → ");
              const ttl =
                c.live_until_before !== c.live_until_after && (c.live_until_before ?? c.live_until_after) !== null
                  ? ` · live until ${c.live_until_before ?? "—"} → ${c.live_until_after ?? "—"}`
                  : "";
              return `${c.change} · ${c.view.kind} ${c.view.key}${values ? ` · ${values}` : ""}${ttl}`;
            }),
          ),
        ),
      );
    }
    const actions = el("div", { className: "session-step-actions" });
    if (s.debuggable) {
      const dbg = el("button", { text: "open in time-travel debugger" });
      dbg.type = "button";
      dbg.dataset.debugStep = String(s.index);
      dbg.addEventListener("click", () =>
        void this.act(async () => {
          const r = await this.request<"debug-context">({ type: "debug-context", step: s.index });
          this.hooks.debugStep(r.context);
        }),
      );
      actions.append(dbg);
    }
    if (s.envelope_xdr) {
      const copy = el("button", { text: "copy envelope XDR" });
      copy.type = "button";
      copy.addEventListener("click", () => void navigator.clipboard?.writeText(s.envelope_xdr!));
      actions.append(copy);
    }
    if (actions.childElementCount > 0) body.append(actions);
    return body;
  }

  // --- report ---

  private renderReport(): void {
    const r = this.report;
    if (!r) return;
    const rep = r.report;
    this.verdict.textContent = r.passed ? "passed" : `FAILED (${r.failures.length})`;
    this.verdict.className = `sub ${r.passed ? "ok" : "danger"}`;
    this.replayable.hidden = rep.safety.replayable.length === 0;
    this.replayable.replaceChildren(
      el("b", { text: "Replayable signatures. " }),
      `These envelopes are valid on the real network as signed; anyone who sees them can submit them there.`,
      list(rep.safety.replayable),
    );
    const section = (title: string, ...children: Node[]) => el("section", {}, el("h4", { text: title }), ...children);
    const sections: HTMLElement[] = [];
    if (r.failures.length > 0) sections.push(section(`Failures (${r.failures.length})`, list(r.failures)));
    sections.push(
      section(
        `Overrides (${rep.overrides.length})`,
        el("p", { className: "field-help", text: "Every place this rehearsal departs from the base network." }),
        list(rep.overrides.length ? rep.overrides.map((o) => `${o.kind} · ${o.label}: ${o.detail}`) : ["none"]),
      ),
      section(
        "Fees by payer",
        list(
          rep.fees.by_payer.length
            ? rep.fees.by_payer.map((p) => `${short(p.account)}: ${p.transactions} tx, ${xlm(p.charged)} XLM charged, largest bid ${xlm(p.max_fee_bid)}`)
            : ["no transactions yet"],
        ),
        el("p", { className: "field-help", text: `${rep.fees.applied} applied · ${rep.fees.failed} failed (fee paid) · ${rep.fees.rejected} rejected · ${xlm(rep.fees.total_charged)} XLM charged` }),
      ),
      section(
        `Final diff vs the fork (${rep.diff.total})`,
        list(
          rep.diff.entries.length
            ? rep.diff.entries.slice(0, 40).map((d) => `${d.change} · ${d.key_type} ${d.key}${d.overridden ? " (override)" : ""}`)
            : ["no changes"],
        ),
      ),
      section(
        "Fork drift",
        el("p", {
          className: "field-help",
          text: `Fork ledger ${rep.drift.fork_ledger}; ${rep.fetch.keys_fetched} keys read (${rep.fetch.keys_present} present) in ${rep.fetch.rpc_calls} RPC calls; ${rep.drift.modified_after_fork.length} changed after the fork.`,
        }),
      ),
      section("Safety", el("p", { className: "field-help", text: rep.safety.note })),
    );
    this.reportBody.replaceChildren(...sections);
  }
}

function list(items: string[]): HTMLElement {
  return el("ul", { className: "session-list" }, ...items.map((t) => el("li", { text: t })));
}

/**
 * Session worker: runs the component's network-session resource for the
 * page. It owns the open session, its IndexedDB log and fork cache, and the
 * read-only RPC client the fork reads the real network through. The page
 * forwards it two kinds of traffic: panel requests (start, resume, steps,
 * report, overrides…) and virtual-RPC bodies the service worker relayed from
 * stellar-sdk, answered on the port that came with them.
 */
import {
  base64ToBytes,
  bodyChangesSession,
  networkSession,
  PersistentSession,
  SessionRpcError,
  SessionStore,
  throwawayKeypair,
  type NetworkSessionModule,
} from "@theahaco/soroban-sim";
import { ledgerChangeLabel } from "./decode.js";
import type {
  FromSessionWorker,
  SessionRequest,
  SessionResult,
  SessionStepsView,
  SessionSummary,
  SwRpcAnswer,
  ToSessionWorker,
} from "./session-protocol.js";

let store: SessionStore | undefined;
let current: PersistentSession | undefined;
/** The Web Lock on the open session's id, held until it closes. */
let held: { release: () => void; released: Promise<unknown> } | undefined;
const module = networkSession as unknown as NetworkSessionModule;

function post(msg: FromSessionWorker): void {
  self.postMessage(msg);
}

async function openStore(): Promise<SessionStore> {
  store ??= await SessionStore.open();
  return store;
}

/** The throwaway fee payer of a browser session: no real network knows it. */
function payerLabel(id: string): string {
  return `browser-session:${id}:payer`;
}

interface ForkInfo {
  network: string;
  passphrase: string;
  fork: { ledger: number; closeTime: number; protocolVersion: number };
  next: { ledger: number; closeTime: number };
  snapshots: number[];
  allowRealSigners: boolean;
}

async function summary(session: PersistentSession): Promise<SessionSummary> {
  const info = await session.session.call<ForkInfo>("fork_info");
  const label = payerLabel(session.id);
  return {
    id: session.id,
    title: session.record.title,
    networkName: info.network,
    passphrase: info.passphrase,
    rpcUrl: session.record.rpcUrl,
    forkLedger: info.fork.ledger,
    forkCloseTime: String(info.fork.closeTime),
    protocolVersion: info.fork.protocolVersion,
    next: info.next,
    snapshots: info.snapshots,
    allowRealSigners: info.allowRealSigners,
    payer: throwawayKeypair(label).publicKey(),
    payerLabel: label,
  };
}

/**
 * Hold `id` for this tab. Each tab runs its own copy of a session, and two
 * copies appending to one log would replay as neither tab ran it.
 */
async function lockSession(id: string): Promise<void> {
  let release!: () => void;
  let granted!: (ok: boolean) => void;
  const asked = new Promise<boolean>((resolve) => (granted = resolve));
  const released = navigator.locks.request(`soroban-sim-session:${id}`, { ifAvailable: true }, (lock) => {
    granted(lock !== null);
    return lock ? new Promise<void>((resolve) => (release = resolve)) : undefined;
  });
  if (!(await asked)) throw new Error("this session is open in another tab; close it there to open it here");
  held = { release, released };
}

async function closeCurrent(): Promise<void> {
  current?.dispose();
  current = undefined;
  const lock = held;
  held = undefined;
  lock?.release();
  await lock?.released;
}

function open(): PersistentSession {
  if (!current) throw new Error("no session is open");
  return current;
}

async function handle(request: SessionRequest): Promise<SessionResult> {
  switch (request.type) {
    case "start": {
      await closeCurrent();
      post({ type: "progress", message: `Forking ${request.networkName} at its latest ledger…` });
      const session = await PersistentSession.start({
        store: await openStore(),
        module,
        rpcUrl: request.rpcUrl,
        networkName: request.networkName,
        ...(request.expectedPassphrase ? { expectedPassphrase: request.expectedPassphrase } : {}),
        ...(request.secondsPerLedger ? { secondsPerLedger: request.secondsPerLedger } : {}),
        servedBy: "soroban-sim browser session (virtual RPC)",
      });
      await lockSession(session.id).catch((e: unknown) => {
        session.dispose();
        throw e;
      });
      current = session;
      // The throwaway fee payer is funded by an override, logged like any other.
      await session.call("fork_setBalance", {
        account: throwawayKeypair(payerLabel(session.id)).publicKey(),
        xlm: String(request.payerXlm),
        label: "throwaway fee payer",
      });
      return { type: "opened", summary: await summary(session), replayed: 0 };
    }
    case "resume": {
      await closeCurrent();
      await lockSession(request.id);
      const session = await PersistentSession.resume({
        store: await openStore(),
        module,
        id: request.id,
        onReplay: (done, total) => post({ type: "progress", message: `Replaying the session log: ${done}/${total}` }),
      }).catch(async (e: unknown) => {
        await closeCurrent();
        throw e;
      });
      current = session;
      return { type: "opened", summary: await summary(session), replayed: (await (await openStore()).ops(request.id)).length };
    }
    case "close": {
      await closeCurrent();
      return { type: "closed" };
    }
    case "list":
      return { type: "sessions", sessions: await (await openStore()).list() };
    case "delete": {
      if (current?.id === request.id) await closeCurrent();
      await (await openStore()).delete(request.id);
      return { type: "deleted" };
    }
    case "call": {
      const session = open();
      const result = await session.call(request.method, request.params ?? {});
      return { type: "called", result, summary: await summary(session) };
    }
    case "steps":
      return { type: "steps", steps: await stepsView(open()) };
    case "report":
      return { type: "report", report: await open().session.report() };
    case "debug-context":
      return { type: "debug-context", context: await open().session.debugContext(request.step) };
  }
}

/** The timeline with every changed entry decoded for display. */
async function stepsView(session: PersistentSession): Promise<SessionStepsView> {
  const { steps, clock } = await session.session.steps();
  const bytes = (b64: string | null) => (b64 ? base64ToBytes(b64) : undefined);
  return {
    clock,
    steps: steps.map((s) => ({
      ...s,
      changes: s.changes.map((c) => ({ ...c, view: ledgerChangeLabel(bytes(c.before), bytes(c.after)) })),
    })),
  };
}

/** A body the service worker relayed: answer it if this is its session. */
async function relay(sessionId: string, body: string, port: MessagePort): Promise<void> {
  const session = current;
  if (!session || session.id !== sessionId) {
    port.postMessage({ held: false } satisfies SwRpcAnswer);
    return;
  }
  try {
    const answer = await session.rpc(body);
    port.postMessage({ held: true, ...(answer !== undefined ? { body: answer } : {}) } satisfies SwRpcAnswer);
    if (bodyChangesSession(body)) post({ type: "changed", summary: await summary(session) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reply = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message } });
    port.postMessage({ held: true, body: reply } satisfies SwRpcAnswer);
  }
}

self.onmessage = (event: MessageEvent<ToSessionWorker>) => {
  const msg = event.data;
  if (msg.type === "rpc") {
    const [port] = event.ports;
    if (port) void relay(msg.sessionId, msg.body, port);
    return;
  }
  void handle(msg.request).then(
    (result) => post({ type: "response", id: msg.id, result }),
    (error: unknown) =>
      post({
        type: "error",
        id: msg.id,
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof SessionRpcError ? { code: error.code } : {}),
      }),
  );
};

post({ type: "ready" });

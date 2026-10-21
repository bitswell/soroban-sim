/**
 * Messages between the page, the session worker (which runs the component's
 * network-session resource) and the service worker (public/sw.js, the
 * virtual RPC relay).
 *
 *   stellar-sdk ──fetch──▶ sw.js ──"soroban-sim/rpc" + port──▶ page
 *        page ──{ type: "rpc", port }──▶ session worker ──answer on port──▶ sw.js
 */
import type {
  SessionClock,
  SessionRecord,
  SessionReportResult,
  SessionStep,
  StepChange,
  StepDebugContext,
} from "@theahaco/soroban-sim";
import type { LedgerChangeLabel } from "./decode.js";

/** A step change with its entries decoded for display. */
export type StepChangeView = StepChange & { view: LedgerChangeLabel };
export type SessionStepView = Omit<SessionStep, "changes"> & { changes: StepChangeView[] };
export interface SessionStepsView {
  steps: SessionStepView[];
  clock: SessionClock;
}

/** Where virtual RPC URLs live, below the app's base path. */
export const VIRTUAL_RPC_PREFIX = "__soroban-sim/rpc/";

/** service worker → page: answer `body` if you hold `sessionId`. */
export interface SwRpcRequest {
  type: "soroban-sim/rpc";
  sessionId: string;
  body: string;
}

/** page → service worker (on the transferred port). */
export interface SwRpcAnswer {
  held: boolean;
  body?: string;
}

/** What the session panel shows about the open session. */
export interface SessionSummary {
  id: string;
  title: string;
  networkName: string;
  passphrase: string;
  rpcUrl: string;
  forkLedger: number;
  forkCloseTime: string;
  protocolVersion: number;
  next: { ledger: number; closeTime: number };
  snapshots: number[];
  allowRealSigners: boolean;
  /** The session's throwaway fee payer (funded by an override). */
  payer: string;
  /** The label its key derives from (`throwawayKeypair(payerLabel)`). */
  payerLabel: string;
}

export type SessionRequest =
  | {
      type: "start";
      networkName: string;
      rpcUrl: string;
      expectedPassphrase?: string;
      secondsPerLedger?: number;
      payerXlm: number;
    }
  | { type: "resume"; id: string }
  | { type: "close" }
  | { type: "list" }
  | { type: "delete"; id: string }
  /** Any facade method; state changes are logged like virtual-RPC ones. */
  | { type: "call"; method: string; params?: unknown }
  | { type: "steps" }
  | { type: "report" }
  | { type: "debug-context"; step: number };

export type SessionResult =
  | { type: "opened"; summary: SessionSummary; replayed: number }
  | { type: "closed" }
  | { type: "sessions"; sessions: SessionRecord[] }
  | { type: "deleted" }
  | { type: "called"; result: unknown; summary: SessionSummary }
  | { type: "steps"; steps: SessionStepsView }
  | { type: "report"; report: SessionReportResult }
  | { type: "debug-context"; context: StepDebugContext };

/** page → session worker. `rpc` answers on its port; the rest by `id`. */
export type ToSessionWorker =
  | { type: "request"; id: number; request: SessionRequest }
  | { type: "rpc"; sessionId: string; body: string };

/** session worker → page. */
export type FromSessionWorker =
  | { type: "ready" }
  | { type: "response"; id: number; result: SessionResult }
  | { type: "error"; id: number; message: string; code?: number }
  | { type: "progress"; message: string }
  /** Something changed the session (a virtual-RPC call included). */
  | { type: "changed"; summary: SessionSummary };

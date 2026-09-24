import type { Cursor } from "../core/types.js";

export type MonitorHealth =
  | "unknown"
  | "running"
  | "idle"
  | "stale"
  | "tool-error"
  | "failed"
  | "succeeded"
  | "interrupted";

export interface MonitorRecord {
  sessionId: string;
  adapter: string;
  label?: string;
  registeredAt: string;
  staleAfterMs: number;
  health: MonitorHealth;
  lastObservedAt?: string;
  lastActivityAt?: string;
  cursor?: Cursor;
  lastTransitionAt?: string;
  detail?: string;
}

export interface MonitorTransition {
  sessionId: string;
  adapter: string;
  label?: string;
  from: MonitorHealth;
  to: MonitorHealth;
  at: string;
  detail?: string;
}

export interface MonitorRunResult {
  checked: number;
  missing: number;
  transitions: MonitorTransition[];
  records: MonitorRecord[];
}

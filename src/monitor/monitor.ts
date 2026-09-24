import type { Engine } from "../core/engine.js";
import type { SessionEntry, StructuredSnapshot } from "../core/types.js";
import { toStructured } from "../core/snapshot.js";
import type { MonitorHealth, MonitorRecord, MonitorRunResult, MonitorTransition } from "./types.js";
import { MonitorStore } from "./store.js";

export interface MonitorOptions {
  now?: () => Date;
}

export class Monitor {
  private runChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly engine: Engine,
    private readonly store: MonitorStore,
    private readonly opts: MonitorOptions = {},
  ) {}

  runOnce(): Promise<MonitorRunResult> {
    const run = this.runChain.then(() => this.runOnceInternal());
    this.runChain = run.catch(() => {});
    return run;
  }

  private async runOnceInternal(): Promise<MonitorRunResult> {
    const at = this.opts.now?.() ?? new Date();
    const records = await this.store.list();
    const transitions: MonitorTransition[] = [];
    const entries = new Map<string, SessionEntry>();
    for (const adapter of new Set(records.map((record) => record.adapter))) {
      for (const entry of await this.engine.list({ adapter })) entries.set(entry.id, entry);
    }
    let missing = 0;

    for (const record of records) {
      const entry = entries.get(record.sessionId);
      if (!entry) {
        missing++;
        const updated = await this.transition(record, "unknown", at, "session not found");
        pushTransition(transitions, record, updated);
        continue;
      }

      const adapter = this.engine.adapters().find((candidate) => candidate.name === record.adapter);
      if (!adapter) {
        missing++;
        const updated = await this.transition(record, "unknown", at, "adapter is not available");
        pushTransition(transitions, record, updated);
        continue;
      }
      let result;
      try {
        result = await adapter.read(entry, record.cursor);
      } catch (error) {
        missing++;
        const detail = `session read failed: ${(error as Error).message}`;
        const updated = await this.transition(record, "unknown", at, detail);
        pushTransition(transitions, record, updated);
        continue;
      }
      const activityAt = result.activityAt
        ?? (adapter.lastSeenIsActivity === false ? record.lastActivityAt ?? entry.lastSeen : entry.lastSeen)
        ?? entry.lastSeen;
      const snapshot = toStructured(entry.id, result.messages, entry.cwd);
      const observed = observe(entry, snapshot, record, at, activityAt);
      const updated = await this.store.observe(record.sessionId, {
        ...observed,
        cursor: result.nextCursor,
      });
      pushTransition(transitions, record, updated);
    }

    return { checked: records.length, missing, transitions, records: await this.store.list() };
  }

  private async transition(
    record: MonitorRecord,
    health: MonitorHealth,
    at: Date,
    detail?: string,
  ): Promise<MonitorRecord> {
    return this.store.observe(record.sessionId, {
      health,
      at,
      detail,
    });
  }
}

function observe(
  entry: SessionEntry,
  snapshot: StructuredSnapshot,
  record: MonitorRecord,
  now: Date,
  activityAt: string,
): { health: MonitorHealth; at: Date; lastActivityAt?: string; detail?: string } {
  const lastActivityMs = Date.parse(activityAt);
  if (Number.isFinite(lastActivityMs) && now.getTime() - lastActivityMs >= record.staleAfterMs) {
    return { health: "stale", at: now, lastActivityAt: activityAt, detail: `no activity for ${record.staleAfterMs}ms` };
  }
  const execution = entry.execution;
  if (execution?.state === "running") {
    return { health: "running", at: now, lastActivityAt: activityAt, detail: "harness reports active execution" };
  }
  if (execution?.outcome === "failed") {
    return { health: "failed", at: now, lastActivityAt: activityAt, detail: execution.detail };
  }
  if (execution?.outcome === "interrupted") {
    return { health: "interrupted", at: now, lastActivityAt: activityAt, detail: execution.detail };
  }
  if (execution?.outcome === "succeeded") {
    return { health: "succeeded", at: now, lastActivityAt: activityAt, detail: execution.detail };
  }
  if (snapshot.lastToolCalls.some((tool) => tool.status === "error")) {
    const tool = [...snapshot.lastToolCalls].reverse().find((candidate) => candidate.status === "error");
    return { health: "tool-error", at: now, lastActivityAt: activityAt, detail: `tool ${tool?.name ?? "unknown"} failed` };
  }
  if (snapshot.activity === "tool-running" || snapshot.activity === "thinking") {
    return { health: "running", at: now, lastActivityAt: activityAt, detail: snapshot.activity };
  }
  if (snapshot.activity === "idle") {
    return { health: "idle", at: now, lastActivityAt: activityAt };
  }
  return { health: "unknown", at: now, lastActivityAt: activityAt, detail: "adapter did not expose enough state" };
}

function pushTransition(
  transitions: MonitorTransition[],
  before: MonitorRecord,
  after: MonitorRecord,
): void {
  if (before.health === after.health) return;
  transitions.push({
    sessionId: after.sessionId,
    adapter: after.adapter,
    ...(after.label ? { label: after.label } : {}),
    from: before.health,
    to: after.health,
    at: after.lastTransitionAt ?? after.lastObservedAt ?? new Date().toISOString(),
    ...(after.detail ? { detail: after.detail } : {}),
  });
}

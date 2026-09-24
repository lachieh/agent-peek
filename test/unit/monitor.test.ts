import { describe, expect, it } from "vitest";
import { Engine } from "../../src/core/engine.js";
import { Registry } from "../../src/core/registry.js";
import { AdapterLoader } from "../../src/adapters/loader.js";
import { Monitor } from "../../src/monitor/monitor.js";
import { MonitorStore } from "../../src/monitor/store.js";
import { encodeCursor } from "../../src/core/cursor.js";
import { makeTmpHome } from "../helpers/tmp-home.js";
import type { Adapter } from "../../src/adapters/types.js";
import type { RawMessage, SessionEntry, SessionExecution } from "../../src/core/types.js";

interface FakeSession {
  entry: SessionEntry;
  messages: RawMessage[];
  execution?: SessionExecution;
  readError?: Error;
}

function fakeAdapter(sessions: Record<string, FakeSession>): Adapter {
  return {
    name: "fake",
    async scan() {
      return Object.values(sessions).map((session) => session.entry);
    },
    async read(entry) {
      const session = sessions[entry.id]!;
      if (session.readError) throw session.readError;
      return {
        messages: session.messages,
        nextCursor: encodeCursor({ adapter: "fake", byteOffset: session.messages.length, msgIndex: session.messages.length }),
        eof: true,
      };
    },
  };
}

describe("Monitor", () => {
  it("reports generic execution and tool health without mutating sessions", async () => {
    const { home, cleanup } = await makeTmpHome();
    try {
      const sessions: Record<string, FakeSession> = {
        "fake:running": {
          entry: entry("fake:running", now().toISOString(), { state: "running" }),
          messages: [],
        },
        "fake:failed": {
          entry: entry("fake:failed", now().toISOString(), { state: "idle", outcome: "failed", detail: "provider quota" }),
          messages: [],
        },
        "fake:tool": {
          entry: entry("fake:tool", now().toISOString(), { state: "idle" }),
          messages: [{ role: "assistant", toolCalls: [{ name: "shell", status: "error" }], raw: {} }],
        },
        "fake:stale": {
          entry: entry("fake:stale", new Date(Date.now() - 60_000).toISOString()),
          messages: [{ role: "assistant", text: "done", raw: {} }],
        },
      };
      const result = await setup(sessions, home, now());
      expect(result.checked).toBe(4);
      expect(result.transitions.map((transition) => [transition.sessionId, transition.to])).toEqual([
        ["fake:failed", "failed"],
        ["fake:running", "running"],
        ["fake:stale", "stale"],
        ["fake:tool", "tool-error"],
      ]);
      expect(result.records.find((record) => record.sessionId === "fake:failed")?.detail).toBe("provider quota");
    } finally {
      await cleanup();
    }
  });

  it("records transitions and preserves the latest observation", async () => {
    const { home, cleanup } = await makeTmpHome();
    try {
      const state: SessionExecution = { state: "running" };
      const sessions = {
        "fake:one": {
          entry: entry("fake:one", now().toISOString(), state),
          messages: [],
        },
      };
      const { monitor, store } = await setupHarness(sessions, home, now());
      await store.add({ sessionId: "fake:one", adapter: "fake", staleAfterMs: 60_000, now: now() });
      expect((await monitor.runOnce()).transitions[0]).toMatchObject({ from: "unknown", to: "running" });

      state.state = "idle";
      state.outcome = "failed";
      const second = await monitor.runOnce();
      expect(second.transitions).toEqual([
        expect.objectContaining({ from: "running", to: "failed" }),
      ]);
      expect((await store.get("fake:one"))?.health).toBe("failed");
    } finally {
      await cleanup();
    }
  });

  it("marks an old running session stale before trusting the running state", async () => {
    const { home, cleanup } = await makeTmpHome();
    try {
      const sessions = {
        "fake:stuck": {
          entry: entry("fake:stuck", new Date(Date.now() - 120_000).toISOString(), { state: "running" }),
          messages: [],
        },
      };
      const { monitor, store } = await setupHarness(sessions, home, now());
      await store.add({ sessionId: "fake:stuck", adapter: "fake", staleAfterMs: 30_000, now: now() });
      const result = await monitor.runOnce();
      expect(result.records[0]?.health).toBe("stale");
    } finally {
      await cleanup();
    }
  });

  it("isolates a read failure and continues checking other sessions", async () => {
    const { home, cleanup } = await makeTmpHome();
    try {
      const sessions = {
        "fake:broken": {
          entry: entry("fake:broken", now().toISOString(), { state: "running" }),
          messages: [],
          readError: new Error("transcript disappeared"),
        },
        "fake:healthy": {
          entry: entry("fake:healthy", now().toISOString(), { state: "running" }),
          messages: [],
        },
      };
      const { monitor, store } = await setupHarness(sessions, home, now());
      await store.add({ sessionId: "fake:broken", adapter: "fake", staleAfterMs: 30_000, now: now() });
      await store.add({ sessionId: "fake:healthy", adapter: "fake", staleAfterMs: 30_000, now: now() });
      const result = await monitor.runOnce();
      expect(result.missing).toBe(1);
      expect(result.records.find((record) => record.sessionId === "fake:broken")?.health).toBe("unknown");
      expect(result.records.find((record) => record.sessionId === "fake:healthy")?.health).toBe("running");
    } finally {
      await cleanup();
    }
  });

  it("falls back to adapter activity when execution state is unavailable", async () => {
    const { home, cleanup } = await makeTmpHome();
    try {
      const sessions = {
        "fake:unknown": {
          entry: entry("fake:unknown", now().toISOString()),
          messages: [{ role: "system", text: "waiting", raw: {} }] satisfies RawMessage[],
        },
      };
      const { monitor, store } = await setupHarness(sessions, home, now());
      await store.add({ sessionId: "fake:unknown", adapter: "fake", staleAfterMs: 60_000, now: now() });
      const result = await monitor.runOnce();
      expect(result.records[0]).toMatchObject({ health: "idle" });
    } finally {
      await cleanup();
    }
  });
});

function entry(id: string, lastSeen: string, execution?: SessionExecution): SessionEntry {
  return {
    id,
    adapter: "fake",
    transcriptPath: `/tmp/${id}`,
    lastSeen,
    status: "active",
    execution,
  };
}

function now(): Date {
  return new Date("2026-09-24T12:00:00.000Z");
}

async function setup(sessions: Record<string, FakeSession>, home: string, at: Date) {
  const { monitor } = await setupHarness(sessions, home, at);
  const store = new MonitorStore({ home });
  for (const sessionId of Object.keys(sessions)) {
    await store.add({ sessionId, adapter: "fake", staleAfterMs: 30_000, now: at });
  }
  return monitor.runOnce();
}

async function setupHarness(sessions: Record<string, FakeSession>, home: string, at: Date) {
  const registry = new Registry({ home });
  const loader = new AdapterLoader();
  loader.register(fakeAdapter(sessions));
  const store = new MonitorStore({ home });
  let tick = 0;
  return {
    monitor: new Monitor(new Engine({ registry, loader }), store, { now: () => new Date(at.getTime() + tick++) }),
    store,
  };
}

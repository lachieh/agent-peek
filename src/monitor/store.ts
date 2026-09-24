import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { RegistryLockTimeoutError, StateUnwritableError, isLockContention } from "../core/errors.js";
import type { MonitorHealth, MonitorRecord } from "./types.js";

interface MonitorFile {
  version: 1;
  sessions: Record<string, MonitorRecord>;
}

export interface MonitorStoreOptions {
  home?: string;
}

export class MonitorStore {
  private readonly dir: string;
  private readonly path: string;

  constructor(opts: MonitorStoreOptions = {}) {
    const home = opts.home ?? homedir();
    this.dir = join(home, ".agent-peek");
    this.path = join(this.dir, "monitor.json");
  }

  async list(): Promise<MonitorRecord[]> {
    const file = await this.read();
    return Object.values(file.sessions).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }

  async get(sessionId: string): Promise<MonitorRecord | undefined> {
    return (await this.read()).sessions[sessionId];
  }

  async add(input: {
    sessionId: string;
    adapter: string;
    label?: string;
    staleAfterMs: number;
    now?: Date;
  }): Promise<MonitorRecord> {
    const now = input.now ?? new Date();
    await this.write((file) => {
      const existing = file.sessions[input.sessionId];
      const record: MonitorRecord = {
        sessionId: input.sessionId,
        adapter: input.adapter,
        ...(input.label ? { label: input.label } : {}),
        registeredAt: existing?.registeredAt ?? now.toISOString(),
        staleAfterMs: input.staleAfterMs,
        health: existing?.health ?? "unknown",
        ...(existing?.lastObservedAt ? { lastObservedAt: existing.lastObservedAt } : {}),
        ...(existing?.lastActivityAt ? { lastActivityAt: existing.lastActivityAt } : {}),
        ...(existing?.cursor ? { cursor: existing.cursor } : {}),
        ...(existing?.lastTransitionAt ? { lastTransitionAt: existing.lastTransitionAt } : {}),
        ...(existing?.detail ? { detail: existing.detail } : {}),
      };
      file.sessions[record.sessionId] = record;
    });
    return (await this.get(input.sessionId))!;
  }

  async remove(sessionId: string): Promise<boolean> {
    let removed = false;
    await this.write((file) => {
      removed = Boolean(file.sessions[sessionId]);
      delete file.sessions[sessionId];
    });
    return removed;
  }

  async observe(sessionId: string, input: {
    health: MonitorHealth;
    at: Date;
    lastActivityAt?: string;
    cursor?: MonitorRecord["cursor"];
    detail?: string;
  }): Promise<MonitorRecord> {
    let updated!: MonitorRecord;
    await this.write((file) => {
      const current = file.sessions[sessionId];
      if (!current) throw new Error(`monitor session not registered: ${sessionId}`);
      const currentObserved = current.lastObservedAt ? Date.parse(current.lastObservedAt) : undefined;
      if (currentObserved !== undefined && input.at.getTime() <= currentObserved) {
        updated = current;
        return;
      }
      const changed = current.health !== input.health;
      updated = {
        ...current,
        health: input.health,
        lastObservedAt: input.at.toISOString(),
        ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        detail: input.detail,
        ...(changed ? { lastTransitionAt: input.at.toISOString() } : {}),
      };
      file.sessions[sessionId] = updated;
    });
    return updated;
  }

  private async read(): Promise<MonitorFile> {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      throw new StateUnwritableError(this.dir, error);
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, sessions: {} };
      throw new StateUnwritableError(this.path, error);
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.version === 1 && parsed.sessions && typeof parsed.sessions === "object") return parsed;
      throw new Error("bad shape");
    } catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === "bad shape")) throw error;
      const backup = join(this.dir, `monitor.corrupt-${Date.now()}.json`);
      try { await rename(this.path, backup); } catch { /* preserve the original state */ }
      return { version: 1, sessions: {} };
    }
  }

  private async write(mutator: (file: MonitorFile) => void): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
    } catch (error) {
      throw new StateUnwritableError(this.dir, error);
    }
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(this.path, {
        retries: { retries: 5, minTimeout: 50, maxTimeout: 500, factor: 2 },
        stale: 10_000,
        realpath: false,
      });
    } catch (error) {
      if (isLockContention(error)) throw new RegistryLockTimeoutError(error);
      throw new StateUnwritableError(this.path, error);
    }
    try {
      const file = await this.read();
      mutator(file);
      const tmp = `${this.path}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
      try {
        await rename(tmp, this.path);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    } finally {
      await release().catch(() => {});
    }
  }
}

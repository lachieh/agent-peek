import { describe, expect, it, beforeAll } from "vitest";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertDistFresh } from "../helpers/fresh-dist.js";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bin = join(root, "bin", "peek.js");

beforeAll(() => assertDistFresh());

describe("monitor CLI", () => {
  it("registers and evaluates a failed OpenCode V2 session without contacting OpenCode", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-monitor-cli-"));
    const data = join(home, "data");
    const opencodeDir = join(data, "opencode");
    await mkdir(opencodeDir, { recursive: true });
    await execFileAsync("sqlite3", [join(opencodeDir, "opencode.db"), schema()]);

    const added = await runCli(home, data, ["monitor", "add", "opencode:ses_failed", "--stale-after", "1m", "--json"]);
    expect(added.code).toBe(0);
    expect(JSON.parse(added.stdout)).toMatchObject({ sessionId: "opencode:ses_failed", adapter: "opencode" });

    const listed = await runCli(home, data, ["monitor", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout)).toHaveLength(1);

    const ran = await runCli(home, data, ["monitor", "run", "--once", "--json"]);
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toMatchObject({
      checked: 1,
      missing: 0,
      transitions: [{ sessionId: "opencode:ses_failed", from: "unknown", to: "failed" }],
    });

    const removed = await runCli(home, data, ["monitor", "remove", "opencode:ses_failed", "--json"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(removed.stdout)).toEqual({ removed: true, sessionId: "opencode:ses_failed" });
  });

  it("requires --once for run and rejects unknown actions", async () => {
    const home = await mkdtemp(join(tmpdir(), "peek-monitor-cli-"));
    const data = join(home, "data");
    await mkdir(data, { recursive: true });

    const missingOnce = await runCli(home, data, ["monitor", "run", "--json"]);
    expect(missingOnce.code).toBe(5);
    expect(JSON.parse(missingOnce.stdout)).toMatchObject({ error: "invalid_usage" });

    const unknown = await runCli(home, data, ["monitor", "retry-everything", "--json"]);
    expect(unknown.code).toBe(5);
    expect(JSON.parse(unknown.stdout)).toMatchObject({ error: "invalid_usage" });
  });
});

function runCli(home: string, data: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn("node", [bin, ...args], {
      env: {
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: data,
        XDG_CONFIG_HOME: join(home, ".config"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolveResult({ code: code ?? 0, stdout, stderr }));
  });
}

function schema(): string {
  return `
    CREATE TABLE session_v2 (
      id text PRIMARY KEY, parent_id text, title text, directory text NOT NULL,
      time_created integer NOT NULL, time_updated integer NOT NULL
    );
    CREATE TABLE session_message (
      id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL,
      seq integer NOT NULL, time_created integer NOT NULL, data text NOT NULL
    );
    INSERT INTO session_v2 VALUES
      ('ses_failed', NULL, 'Failed provider', '/tmp/repo', ${Date.now() - 1000}, ${Date.now()});
    INSERT INTO session_message VALUES
      ('msg_idle', 'ses_failed', 'idle', 1, ${Date.now()}, '{"time":{"created":${Date.now()}},"outcome":"failed"}');
  `;
}

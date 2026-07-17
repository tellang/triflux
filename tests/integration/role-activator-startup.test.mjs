import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { SQLITE_SKIP } from "../helpers/sqlite.mjs";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

const RUNNER_SOURCE = `
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function createDelegatorWorkerStub() {
  return {
    async start() {},
    async stop() {},
    async delegate() {
      return { ok: true, status: "completed", transport: "stub-delegator" };
    },
    async getJobStatus(jobId) {
      return { ok: true, job_id: jobId, status: "completed" };
    },
    async reply({ job_id }) {
      return { ok: true, job_id, status: "completed" };
    },
  };
}

const projectRoot = process.env.TFX_TEST_PROJECT_ROOT;
const dbDir = process.env.TFX_TEST_DB_DIR;
mkdirSync(dbDir, { recursive: true });
const dbPath = join(dbDir, "hub.db");
const moduleUrl = (relativePath) =>
  pathToFileURL(join(projectRoot, relativePath)).href;
const { encodeRoleKey } = await import(moduleUrl("hub/role-contract.mjs"));
const { createStore } = await import(moduleUrl("hub/store.mjs"));

const roleKeyWire = encodeRoleKey({
  project_id: "prj_" + "s".repeat(22),
  role_kind: "cto",
});
const seedStore = createStore(dbPath);
seedStore.upsertRoleReservation({
  role_key_wire: roleKeyWire,
  holder_agent_id: null,
  state: "electable",
  last_transition_ms: 1,
  last_reason: "fault_seed",
});
seedStore.db.exec(
  "CREATE TRIGGER fail_role_recovery_update " +
    "BEFORE UPDATE ON role_registry BEGIN " +
    "SELECT RAISE(ABORT, 'damaged role row'); END",
);
seedStore.close();

const { startHub } = await import(moduleUrl("hub/server.mjs"));
const hub = await startHub({
  port: 0,
  dbPath,
  host: "127.0.0.1",
  sessionId: "role-recovery-fault",
  createDelegatorWorker: createDelegatorWorkerStub,
});

try {
  console.log(JSON.stringify({ marker: "hub-started", port: hub.port }));
} finally {
  await hub.stop();
}
`;

function parseJsonLines(output) {
  return output.split(/\r?\n/u).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

describe("startHub role recovery fault containment", {
  skip: SQLITE_SKIP,
}, () => {
  it("starts the hub and logs degraded recovery when one recovered role throws", () => {
    const sandboxDir = join(tmpdir(), `tfx-role-recovery-${randomUUID()}`);
    const homeDir = join(sandboxDir, "home");
    const dbDir = join(sandboxDir, "db");
    const stateDir = join(sandboxDir, "state");
    mkdirSync(homeDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    try {
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", RUNNER_SOURCE],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: homeDir,
            USERPROFILE: homeDir,
            NODE_ENV: "production",
            LOG_LEVEL: "warn",
            TFX_CTO: "1",
            TFX_CTO_MANAGER: "1",
            TFX_CTO_NORTH_STAR: "0",
            TFX_CTO_AUTO_COLLECT: "0",
            TFX_HUB_STATE_DIR: stateDir,
            TFX_HUB_PID_DIR: stateDir,
            TFX_TEST_PROJECT_ROOT: PROJECT_ROOT,
            TFX_TEST_DB_DIR: dbDir,
          },
        },
      );
      const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
      assert.equal(result.status, 0, output);

      const records = parseJsonLines(output);
      const started = records.find((record) => record.marker === "hub-started");
      assert.ok(started?.port > 0, output);

      const degraded = records.find(
        (record) => record.msg === "role_activator.recovery_degraded",
      );
      assert.ok(degraded, output);
      assert.equal(String(degraded.level).toLowerCase(), "warn");
      assert.match(degraded.err?.message ?? "", /damaged role row/u);
    } finally {
      rmSync(sandboxDir, { recursive: true, force: true });
    }
  });
});

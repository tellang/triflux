import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

const RUNNER_SOURCE = `
import { randomUUID } from "node:crypto";
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

const projectRoot = process.env.TFX_HUB_PROJECT_ROOT;
const port = Number(process.env.TFX_HUB_TEST_PORT);
const dbDir = process.env.TFX_HUB_DB_DIR;
const baseUrl = "http://127.0.0.1:" + port;

mkdirSync(dbDir, { recursive: true });
const { startHub } = await import(
  pathToFileURL(join(projectRoot, "hub", "server.mjs")).href +
    "?test=" +
    randomUUID()
);

const hub = await startHub({
  port,
  dbPath: join(dbDir, "state.db"),
  host: "127.0.0.1",
  sessionId: "snapshot-redaction-" + port,
  createDelegatorWorker: createDelegatorWorkerStub,
});

try {
  const response = await fetch(baseUrl + "/broker/snapshot");
  const body = await response.json();
  console.log(
    JSON.stringify({
      marker: "snapshot-result",
      status: response.status,
      body,
    }),
  );
} finally {
  await hub.stop().catch(() => {});
}
`;

function createBrokerFixture(homeDir) {
  const brokerDir = join(homeDir, ".claude", "cache", "tfx-hub");
  const codexDir = join(homeDir, ".codex");
  mkdirSync(brokerDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });

  writeFileSync(
    join(brokerDir, "accounts.json"),
    JSON.stringify(
      {
        codex: [
          {
            id: "profile-account",
            mode: "profile",
            profile: "codex53_high",
            host: "ryzen",
            tier: "pro",
          },
          {
            id: "env-account",
            mode: "env",
            env: {
              OPENAI_API_KEY: "secret-key",
            },
            host: "ryzen",
            tier: "plus",
          },
          {
            id: "auth-account",
            mode: "auth",
            authFile: "private-auth.json",
            host: "ryzen",
            tier: "free",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(brokerDir, "private-auth.json"),
    JSON.stringify({ token: "secret-key", account_id: "auth-account" }),
    "utf8",
  );
  writeFileSync(
    join(codexDir, "auth.json"),
    JSON.stringify({ token: "secret-key", account_id: "auth-account" }),
    "utf8",
  );
}

function parseStructuredOutput(text) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

describe("hub broker snapshot redaction", () => {
  const sandboxDir = join(
    tmpdir(),
    `tfx-hub-snapshot-redaction-${randomUUID()}`,
  );
  const scriptPath = join(sandboxDir, "snapshot-runner.mjs");
  const port = 28700 + Math.floor(Math.random() * 300);
  const homeDir = join(sandboxDir, "home");
  const dbDir = join(sandboxDir, "db");

  before(() => {
    mkdirSync(sandboxDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    createBrokerFixture(homeDir);
    writeFileSync(scriptPath, RUNNER_SOURCE, "utf8");
  });

  after(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("exposes only the public broker account shape over HTTP", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        HOMEDRIVE: homeDir.slice(0, 2),
        HOMEPATH: homeDir.slice(2).replace(/\\/g, "/"),
        NODE_ENV: "production",
        LOG_LEVEL: "warn",
        TFX_HUB_PROJECT_ROOT: PROJECT_ROOT,
        TFX_HUB_TEST_PORT: String(port),
        TFX_HUB_DB_DIR: dbDir,
        TFX_HUB_PID_DIR: join(homeDir, ".claude", "cache", "tfx-hub"),
        TFX_HUB_STATE_DIR: join(homeDir, ".claude", "cache", "tfx-hub"),
      },
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);

    const records = parseStructuredOutput(output);
    const response = records.find(
      (entry) => entry.marker === "snapshot-result",
    );
    assert.ok(response, `snapshot-result marker missing:\n${output}`);

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.accounts.length, 3);

    const serialized = JSON.stringify(response.body);
    assert.equal(serialized.includes("secret-key"), false);
    assert.equal(serialized.includes("private-auth.json"), false);
    assert.equal(serialized.includes("codex53_high"), false);
    assert.equal(serialized.includes("ryzen"), false);

    const expectedKeys = [
      "busy",
      "circuitState",
      "cooldownUntil",
      "failureCount",
      "id",
      "lastUsedAt",
      "provider",
      "remainingMs",
      "tier",
      "totalSessions",
    ];
    for (const account of response.body.accounts) {
      assert.deepEqual(Object.keys(account).sort(), expectedKeys);
    }
  });
});

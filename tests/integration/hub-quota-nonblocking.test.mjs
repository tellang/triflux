import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const ACCOUNTS = [
  { id: "quota-account", authFile: "quota-account.json", token: "quota-token" },
  { id: "ok-account", authFile: "ok-account.json", token: "ok-token" },
  { id: "error-account", authFile: "error-account.json", token: "error-token" },
];

const RUNNER_SOURCE = String.raw`
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

function buildQuotaResponse(status, headers = {}) {
  return new Response(JSON.stringify({ ok: status < 400 }), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const plan = JSON.parse(process.env.TFX_HUB_QUOTA_PLAN ?? "{}");
const projectRoot = process.env.TFX_HUB_PROJECT_ROOT;
const port = Number(process.env.TFX_HUB_TEST_PORT);
const dbDir = process.env.TFX_HUB_DB_DIR;
const baseUrl = "http://127.0.0.1:" + port;
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const requestUrl =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  if (requestUrl === "https://api.openai.com/v1/chat/completions") {
    const headers = new Headers(init?.headers);
    const token = headers.get("authorization")?.replace(/^Bearer\s+/u, "");
    const entry = plan[token];
    if (!entry) {
      throw new Error("missing quota fetch plan for token: " + token);
    }
    if (entry.throwMessage) {
      throw new Error(entry.throwMessage);
    }
    return buildQuotaResponse(entry.status, entry.headers);
  }

  return originalFetch(input, init);
};

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
  sessionId: "quota-" + port,
  createDelegatorWorker: createDelegatorWorkerStub,
});

try {
  const response = await originalFetch(baseUrl + "/broker/quota-refresh", {
    method: "POST",
  });
  const body = await response.json();
  console.log(
    JSON.stringify({
      marker: "quota-result",
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
  mkdirSync(brokerDir, { recursive: true });

  writeFileSync(
    join(brokerDir, "accounts.json"),
    JSON.stringify(
      {
        codex: ACCOUNTS.map(({ id, authFile }) => ({
          id,
          mode: "auth",
          authFile,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  for (const account of ACCOUNTS) {
    writeFileSync(
      join(brokerDir, account.authFile),
      JSON.stringify({
        tokens: {
          access_token: account.token,
        },
      }),
      "utf8",
    );
  }
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

describe("hub quota refresh non-blocking regression", () => {
  const sandboxDir = join(tmpdir(), `tfx-hub-quota-${randomUUID()}`);
  const scriptPath = join(sandboxDir, "quota-runner.mjs");
  const port = 28400 + Math.floor(Math.random() * 300);
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

  function runQuotaScenario(plan) {
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
        TFX_HUB_QUOTA_PLAN: JSON.stringify(plan),
      },
    });

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 0, output);

    const records = parseStructuredOutput(output);
    const response = records.find((entry) => entry.marker === "quota-result");
    assert.ok(response, `quota-result marker missing:\n${output}`);

    return { response, records, output };
  }

  it("quota 초과 시 요청을 막지 않고 warn 로그만 남긴다", () => {
    const { response, records } = runQuotaScenario({
      "quota-token": {
        status: 429,
        headers: {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
        },
      },
      "ok-token": { status: 200 },
      "error-token": { status: 200 },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.results.length, 3);
    assert.equal(
      response.body.results.find((entry) => entry.id === "quota-account")
        ?.status,
      "quota_hit",
    );

    const quotaLog = records.find((entry) => entry.tag === "hub-quota");
    assert.ok(quotaLog, "hub-quota warn 로그가 남아야 한다");
    assert.equal(String(quotaLog.level).toLowerCase(), "warn");
    assert.equal(quotaLog.msg, "broker.quota_refresh_degraded");
    assert.deepEqual(quotaLog.metrics, {
      checked: 3,
      ok: 2,
      quotaHit: 1,
      error: 0,
      failed: 1,
    });
    assert.deepEqual(quotaLog.failures, [
      {
        id: "quota-account",
        status: "quota_hit",
        http: 429,
        headers: {
          "x-ratelimit-limit-requests": "100",
          "x-ratelimit-remaining-requests": "0",
        },
      },
    ]);
    assert.equal(
      records.some((entry) => entry.msg === "broker.quota_refresh_error"),
      false,
    );
  });

  it("실패 로깅에 quota/error metrics를 구조화해 남긴다", () => {
    const { response, records } = runQuotaScenario({
      "quota-token": { status: 429 },
      "ok-token": { status: 200 },
      "error-token": { throwMessage: "simulated quota probe timeout" },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(
      response.body.results.find((entry) => entry.id === "quota-account")
        ?.status,
      "quota_hit",
    );

    const errorResult = response.body.results.find(
      (entry) => entry.id === "error-account",
    );
    assert.ok(errorResult);
    assert.equal(errorResult.status, "error");
    assert.match(errorResult.message, /simulated quota probe timeout/u);

    const quotaLog = records.find((entry) => entry.tag === "hub-quota");
    assert.ok(quotaLog, "실패 시 hub-quota 로그가 남아야 한다");
    assert.equal(String(quotaLog.level).toLowerCase(), "warn");
    assert.deepEqual(quotaLog.metrics, {
      checked: 3,
      ok: 1,
      quotaHit: 1,
      error: 1,
      failed: 2,
    });
    assert.deepEqual(
      quotaLog.failures.map((entry) => ({
        id: entry.id,
        status: entry.status,
        http: entry.http ?? null,
      })),
      [
        { id: "quota-account", status: "quota_hit", http: 429 },
        { id: "error-account", status: "error", http: null },
      ],
    );
    assert.match(
      quotaLog.failures.find((entry) => entry.id === "error-account")
        ?.message ?? "",
      /simulated quota probe timeout/u,
    );
    assert.equal(
      records.some((entry) => entry.msg === "broker.quota_refresh_error"),
      false,
    );
  });
});

// tests/integration/workers.test.mjs — subprocess worker 통합 테스트

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeWorker } from "../../hub/workers/claude-worker.mjs";
import { createWorker } from "../../hub/workers/factory.mjs";
import { GeminiWorker } from "../../hub/workers/gemini-worker.mjs";
import {
  createWorkerError,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_TIMEOUT_MS,
  safeJsonParse,
  toStringList,
} from "../../hub/workers/worker-utils.mjs";
import { BASH_EXE, toBashPath } from "../helpers/bash-path.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const FIXTURE_DIR = resolve(PROJECT_ROOT, "tests", "fixtures");
const FIXTURE_BIN = toBashPath(resolve(FIXTURE_DIR, "bin"));
const CLAUDE_FIXTURE = resolve(FIXTURE_DIR, "fake-claude-cli.mjs");
const ROUTE_SCRIPT = toBashPath(
  resolve(PROJECT_ROOT, "scripts", "tfx-route.sh"),
);

function buildRouteEnv(extraEnv = {}) {
  return {
    ...process.env,
    PATH: `${FIXTURE_BIN}:${process.env.PATH || ""}`,
    TFX_CLI_MODE: "auto",
    TFX_NO_CLAUDE_NATIVE: "0",
    TFX_CODEX_TRANSPORT: "exec",
    TFX_CTO_NORTH_STAR: "0",
    ...extraEnv,
  };
}

describe("GeminiWorker compatibility alias", { timeout: 15000 }, () => {
  it("direct GeminiWorker import도 Antigravity route를 사용해야 한다", async () => {
    const worker = new GeminiWorker({
      routeScript: ROUTE_SCRIPT,
      cwd: PROJECT_ROOT,
      env: buildRouteEnv({
        HOME: resolve(PROJECT_ROOT, ".tmp-home-route-antigravity"),
        AGY_BIN: "agy",
        TFX_ANTIGRAVITY_OK: "1",
      }),
      timeoutMs: 5000,
    });

    const result = await worker.run("hello antigravity");
    assert.equal(result.type, "antigravity");
    assert.match(result.response, /AGY:hello antigravity/);
    assert.equal(result.exitCode, 0);
    await worker.stop();
  });
});

describe("ClaudeWorker", { timeout: 15000 }, () => {
  it("여러 turn을 같은 세션으로 처리하고 history를 유지해야 한다", async () => {
    const worker = new ClaudeWorker({
      command: process.execPath,
      commandArgs: [CLAUDE_FIXTURE],
      timeoutMs: 5000,
      allowDangerouslySkipPermissions: true,
    });

    const first = await worker.run("first turn");
    const second = await worker.run("second turn");

    assert.equal(first.sessionId, "11111111-1111-1111-1111-111111111111");
    assert.equal(second.sessionId, first.sessionId);
    assert.match(second.response, /claude:second turn/);
    assert.equal(worker.history.length, 4);
    await worker.stop();
  });

  it("control_request를 자동 응답하고 turn을 완료해야 한다", async () => {
    const worker = new ClaudeWorker({
      command: process.execPath,
      commandArgs: [CLAUDE_FIXTURE],
      env: { FAKE_CLAUDE_REQUIRE_CONTROL: "1" },
      timeoutMs: 5000,
      allowDangerouslySkipPermissions: true,
    });

    const result = await worker.run("needs control");
    assert.match(result.response, /claude:needs control/);
    await worker.stop();
  });
});

describe("createWorker()", { timeout: 15000 }, () => {
  it("타입별 worker 인스턴스를 생성해야 한다", async () => {
    assert.equal(
      (await createWorker("gemini")).constructor.name,
      "AntigravityRouteWorker",
    );
    assert.equal(
      (await createWorker("antigravity")).constructor.name,
      "AntigravityRouteWorker",
    );
    assert.equal(
      (await createWorker("claude")).constructor.name,
      "ClaudeWorker",
    );
    assert.equal(
      (await createWorker("delegator")).constructor.name,
      "DelegatorMcpWorker",
    );
    await assert.rejects(() => createWorker("unknown"), /Unknown worker type/);
  });
});

describe("worker-utils", () => {
  it("공유 워커 유틸의 기본 contract를 유지해야 한다", () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 15 * 60 * 1000);
    assert.equal(DEFAULT_KILL_GRACE_MS, 1000);
    assert.deepEqual(toStringList([" foo ", null, "", "bar"]), ["foo", "bar"]);
    assert.deepEqual(toStringList("nope"), []);
    assert.deepEqual(safeJsonParse('{"ok":true}'), { ok: true });
    assert.equal(safeJsonParse("{"), null);

    const error = createWorkerError("worker failed", {
      code: "WORKER_FAIL",
      detail: 1,
    });
    assert.equal(error.message, "worker failed");
    assert.equal(error.code, "WORKER_FAIL");
    assert.equal(error.detail, 1);
  });
});

describe("tfx-route.sh wrapper integration", { timeout: 15000 }, () => {
  after(() => {
    for (const dir of [
      ".tmp-home-route-codex",
      ".tmp-home-route-antigravity",
    ]) {
      rmSync(resolve(PROJECT_ROOT, dir), { recursive: true, force: true });
    }
  });

  it("designer는 Antigravity route wrapper를 통해 실행되어야 한다", () => {
    const result = spawnSync(
      BASH_EXE,
      [ROUTE_SCRIPT, "designer", "route gemini", "implement", "5"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: buildRouteEnv({
          HOME: resolve(PROJECT_ROOT, ".tmp-home-route-antigravity"),
          TFX_TEAM_NAME: "phase3-team",
          AGY_BIN: "agy",
          TFX_ANTIGRAVITY_OK: "1",
        }),
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /AGY:route gemini/);
    assert.match(output, /type=antigravity/);
    assert.doesNotMatch(output, /gemini-worker|type=gemini/);
  });

  it("verifier는 기본 route table에서 Codex review 경로를 사용해야 한다", () => {
    const result = spawnSync(
      BASH_EXE,
      [ROUTE_SCRIPT, "verifier", "route verify", "analyze", "5"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: buildRouteEnv({
          HOME: resolve(PROJECT_ROOT, ".tmp-home-route-codex"),
          TFX_TEAM_NAME: "phase3-team",
          CODEX_BIN: "codex",
        }),
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /type=codex/);
    assert.match(output, /agent=verifier/);
  });

  it("verifier는 TFX_NO_CLAUDE_NATIVE=1일 때 Codex review 경로를 사용해야 한다", () => {
    const result = spawnSync(
      BASH_EXE,
      [ROUTE_SCRIPT, "verifier", "route verify", "analyze", "5"],
      {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        env: buildRouteEnv({
          HOME: resolve(PROJECT_ROOT, ".tmp-home-route-codex"),
          TFX_TEAM_NAME: "phase3-team",
          TFX_NO_CLAUDE_NATIVE: "1",
          CODEX_BIN: "codex",
        }),
      },
    );

    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, output);
    assert.match(output, /EXEC:route verify/);
    assert.match(output, /type=codex/);
    assert.match(output, /codex_transport_effective=exec/);
  });
});

// tests/unit/dynamic-route-cli.test.mjs
//
// Phase 1 Wire-up 3 helper — scripts/lib/dynamic-route-cli.mjs.
// sh 경로 (tfx-route.sh) 가 stdout 한 줄로 받는 contract 검증.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(
  HERE,
  "..",
  "..",
  "scripts",
  "lib",
  "dynamic-route-cli.mjs",
);

const ENV_FLAG = "TRIFLUX_DYNAMIC_ROUTING";

function runHelper(args = [], extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  // 부모 env 에서 본 flag 제거 후 extraEnv 가 명시한 경우만 set
  delete env[ENV_FLAG];
  if (Object.hasOwn(extraEnv, ENV_FLAG)) {
    env[ENV_FLAG] = extraEnv[ENV_FLAG];
  }
  const result = spawnSync(process.execPath, [HELPER, ...args], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

let originalEnvFlag;

beforeEach(() => {
  originalEnvFlag = process.env[ENV_FLAG];
  delete process.env[ENV_FLAG];
});

afterEach(() => {
  if (originalEnvFlag === undefined) {
    delete process.env[ENV_FLAG];
  } else {
    process.env[ENV_FLAG] = originalEnvFlag;
  }
});

describe("dynamic-route-cli helper", () => {
  it("R-01: env 미설정 시 stdout empty + exit 0", () => {
    const r = runHelper(["--agent-hint", "codex"]);
    assert.equal(r.stdout, "", "stdout 가 empty 가 아니다 (no-op 기대)");
    assert.equal(r.code, 0);
  });

  it("R-02: env=1 + agent-hint=claude → 'codex' 한 줄 (fallback 결정)", () => {
    const r = runHelper(["--agent-hint", "claude"], { [ENV_FLAG]: "1" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "codex");
  });

  it("R-03: env=true 도 활성화", () => {
    const r = runHelper(["--agent-hint", "claude"], { [ENV_FLAG]: "true" });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "codex");
  });

  it("R-04: env=0 (명시 비활성) — stdout empty", () => {
    const r = runHelper(["--agent-hint", "claude"], { [ENV_FLAG]: "0" });
    assert.equal(r.stdout, "");
    assert.equal(r.code, 0);
  });

  it("R-05: --json 옵션 — JSON 결정 전체를 stdout 으로", () => {
    const r = runHelper(["--agent-hint", "claude", "--json"], {
      [ENV_FLAG]: "1",
    });
    assert.equal(r.code, 0);
    const decision = JSON.parse(r.stdout);
    assert.equal(typeof decision.decisionId, "string");
    assert.equal(decision.mode, "codex-default");
    assert.equal(decision.scenario, "fallback");
    assert.equal(decision.shards[0].cli, "codex");
  });

  it("R-06: --field scenario — scenario 문자열만 출력", () => {
    const r = runHelper(["--agent-hint", "claude", "--field", "scenario"], {
      [ENV_FLAG]: "1",
    });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), "fallback");
  });

  it("R-07: --team-size 가 호출 시 valid decision 으로 결과 반환", () => {
    // helper 는 매 호출마다 새 snapshot 을 빌드 (HUD/broker IO time-dependent)
    // 라 decisionId 결정성은 evaluator 단계에서 검증 (dynamic-routing-engine.test).
    // 본 가드는 sh caller contract 만 검증: team_size 인자가 정상 흐름으로 통과.
    const r = runHelper(
      [
        "--task-id",
        "tfx-route-test-team-size",
        "--agent-hint",
        "codex",
        "--team-size",
        "2",
        "--json",
      ],
      { [ENV_FLAG]: "1" },
    );
    assert.equal(r.code, 0);
    const decision = JSON.parse(r.stdout);
    assert.equal(typeof decision.decisionId, "string");
    assert.equal(typeof decision.scenario, "string");
    assert.ok(Array.isArray(decision.shards), "shards 가 배열이어야 한다");
  });

  it("R-08: --help 출력 후 exit 0", () => {
    const r = runHelper(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage:/);
  });
});

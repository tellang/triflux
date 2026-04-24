import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, describe, it } from "node:test";

// Regression test for hub-ensure PID-file port cascade bug.
//
// 버그 요약:
// 과거 resolveHubTarget()는 TFX_HUB_PORT env 가 없을 때 PID file 의 port 값을
// 그대로 target.port 로 덮어썼다. 이로 인해 한 세션에서 비표준 포트가 PID file 에
// 기록되면, 이후 모든 세션이 그 오염된 port 를 재사용하며 cascade 로 영속화되는
// 버그가 발생했다 (실제 현장 증상: port 29115 / 27889 가 여러 세션에 걸쳐 유지).
//
// 수정: PID file 의 port 는 source of truth 가 아니라는 계약을 코드에 명시.
// 포트는 TFX_HUB_PORT env (없으면 HUB_DEFAULT_PORT=27888) 만 source of truth.
// PID file 의 host 힌트 (loopback variant) 는 계속 재사용한다.

const TEST_HOME = mkdtempSync(join(tmpdir(), "tfx-hub-ensure-test-"));
const ORIG_USERPROFILE = process.env.USERPROFILE;
const ORIG_HOME = process.env.HOME;
const ORIG_TFX_HUB_PORT = process.env.TFX_HUB_PORT;

process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;

const HUB_PID_FILE = join(TEST_HOME, ".claude", "cache", "tfx-hub", "hub.pid");
const HUB_PID_DIR = join(TEST_HOME, ".claude", "cache", "tfx-hub");

let resolveHubTarget;

before(async () => {
  ({ resolveHubTarget } = await import("../../scripts/hub-ensure.mjs"));
});

process.on("exit", () => {
  if (ORIG_USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = ORIG_USERPROFILE;
  if (ORIG_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIG_HOME;
  if (ORIG_TFX_HUB_PORT === undefined) delete process.env.TFX_HUB_PORT;
  else process.env.TFX_HUB_PORT = ORIG_TFX_HUB_PORT;
  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

function writePid(payload) {
  mkdirSync(HUB_PID_DIR, { recursive: true });
  writeFileSync(HUB_PID_FILE, JSON.stringify(payload), "utf8");
}

function clearPid() {
  if (existsSync(HUB_PID_FILE)) rmSync(HUB_PID_FILE, { force: true });
}

describe("resolveHubTarget — port cascade regression", () => {
  afterEach(() => {
    delete process.env.TFX_HUB_PORT;
    clearPid();
  });

  it("returns HUB_DEFAULT_PORT(27888) when no env and no pid file", () => {
    const target = resolveHubTarget();
    assert.equal(target.port, 27888);
    assert.equal(target.host, "127.0.0.1");
  });

  it("honors TFX_HUB_PORT env over default", () => {
    process.env.TFX_HUB_PORT = "28000";
    const target = resolveHubTarget();
    assert.equal(target.port, 28000);
  });

  it("REGRESSION: ignores stale pid-file port, uses HUB_DEFAULT_PORT", () => {
    // Reproduce the cascade bug scenario: pid-file에 비표준 port 29115 기록됨.
    // 과거 버전에서는 resolveHubTarget()이 29115를 반환해 계속 drift.
    // 수정 후에는 27888 을 반환해야 한다.
    writePid({ pid: 99999, port: 29115, host: "127.0.0.1" });

    const target = resolveHubTarget();

    assert.equal(
      target.port,
      27888,
      "pid-file의 port(29115)가 target.port로 누수되면 cascade 버그 재발",
    );
    assert.equal(target.host, "127.0.0.1");
  });

  it("env TFX_HUB_PORT wins even when pid-file has different port", () => {
    process.env.TFX_HUB_PORT = "27888";
    writePid({ pid: 99999, port: 29115 });
    const target = resolveHubTarget();
    assert.equal(target.port, 27888);
  });

  it("preserves loopback host hint from pid-file but not port", () => {
    writePid({ pid: 99999, port: 29115, host: "::1" });
    const target = resolveHubTarget();
    assert.equal(target.port, 27888, "port는 항상 default/env 기준");
    assert.equal(target.host, "::1", "loopback host 힌트는 재사용 허용");
  });

  it("ignores non-loopback host from pid-file", () => {
    writePid({ pid: 99999, port: 29115, host: "10.0.0.1" });
    const target = resolveHubTarget();
    assert.equal(target.host, "127.0.0.1");
  });

  it("handles corrupted pid-file gracefully", () => {
    mkdirSync(HUB_PID_DIR, { recursive: true });
    writeFileSync(HUB_PID_FILE, "not json", "utf8");
    const target = resolveHubTarget();
    assert.equal(target.port, 27888);
    assert.equal(target.host, "127.0.0.1");
  });

  it("treats TFX_HUB_PORT=0 as invalid, falls back to HUB_DEFAULT_PORT", () => {
    // Port 0 은 TCP 에서 "OS 가 ephemeral port 할당" 의미지만 hub 에서는
    // 사용 의도 없음. envPortRaw > 0 조건으로 reject 되어 default 27888 로 fallback.
    process.env.TFX_HUB_PORT = "0";
    const target = resolveHubTarget();
    assert.equal(target.port, 27888);
  });

  it("treats TFX_HUB_PORT=<non-numeric> as invalid, falls back to default", () => {
    process.env.TFX_HUB_PORT = "not-a-number";
    const target = resolveHubTarget();
    assert.equal(target.port, 27888);
  });

  it("treats TFX_HUB_PORT=<negative> as invalid, falls back to default", () => {
    process.env.TFX_HUB_PORT = "-1";
    const target = resolveHubTarget();
    assert.equal(target.port, 27888);
  });
});

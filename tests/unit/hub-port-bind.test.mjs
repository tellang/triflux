import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  cleanStaleHubPid,
  detectLivePeer,
  resolveHubPort,
} from "../../hub/server.mjs";

const TEMP_DIRS = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tfx-hub-port-bind-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function writeHubPid(payload) {
  const dir = makeTempDir();
  const pidFile = join(dir, "hub.pid");
  writeFileSync(pidFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return pidFile;
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    try {
      rmSync(TEMP_DIRS.pop(), { recursive: true, force: true });
    } catch {}
  }
});

describe("hub port bind helpers", () => {
  it("TFX_HUB_PORT 미지정이면 27888을 사용한다", () => {
    assert.equal(resolveHubPort({}, { preferLivePid: false }), 27888);
    assert.equal(
      resolveHubPort(
        { TFX_HUB_PORT: "not-a-number" },
        { preferLivePid: false },
      ),
      27888,
    );
    assert.equal(
      resolveHubPort({ TFX_HUB_PORT: "30001" }, { preferLivePid: false }),
      30001,
    );
  });

  it("stale hub.pid 는 자동 정리되고 기본 포트는 27888로 유지된다", () => {
    const pidFile = writeHubPid({
      pid: 999999,
      port: 27888,
      version: "1.2.3",
      sessionId: "stale-session",
      startedAt: new Date().toISOString(),
    });

    const result = cleanStaleHubPid(pidFile, {
      killFn() {
        const error = new Error("ESRCH");
        error.code = "ESRCH";
        throw error;
      },
    });

    assert.deepEqual(result, {
      cleaned: true,
      reason: "stale_pid",
      pid: 999999,
    });
    assert.equal(existsSync(pidFile), false);
    assert.equal(resolveHubPort({}, { preferLivePid: false }), 27888);
  });

  it("live peer 는 signal 0 체크 결과를 반환해 graceful exit 분기를 가능하게 한다", () => {
    const pidFile = writeHubPid({
      pid: process.pid,
      port: 27888,
      version: "same-version",
      host: "127.0.0.1",
      url: "http://127.0.0.1:27888/mcp",
      sessionId: "live-session",
      startedAt: new Date().toISOString(),
    });
    const killCalls = [];

    const peer = detectLivePeer(pidFile, {
      killFn(pid, signal) {
        killCalls.push([pid, signal]);
      },
    });

    assert.equal(peer.alive, true);
    assert.equal(peer.pid, process.pid);
    assert.equal(peer.port, 27888);
    assert.equal(peer.version, "same-version");
    assert.deepEqual(killCalls, [[process.pid, 0]]);
  });
});

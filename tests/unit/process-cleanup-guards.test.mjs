// tests/unit/process-cleanup-guards.test.mjs
// #548: 정리 코드가 호출자 프로세스 그룹이나 재사용된 PID 를 죽이지 않는지 확인한다.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  parseEtimeMs,
  shouldKillTrackedPid,
} from "../../scripts/session-stale-cleanup.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ROUTE_SH = readFileSync(
  path.join(REPO_ROOT, "scripts", "tfx-route.sh"),
  "utf8",
);

function extract(re) {
  const m = ROUTE_SH.match(re);
  assert.ok(m, `${re} 를 찾을 수 없음`);
  return m[0];
}

const CLEANUP_FNS = [
  extract(/^track_worker_pid\(\) \{[\s\S]*?^\}$/m),
  extract(/^_exec_tracked\(\) \{[\s\S]*?^\}$/m),
  extract(/^_TFX_WORKER_CMD_RE=.*$/m),
  extract(/^_kill_tracked_worker_unix\(\) \{[\s\S]*?^\}$/m),
  extract(/^cleanup_workers\(\) \{[\s\S]*?^\}$/m),
].join("\n");

// 표지 형제 프로세스가 있는 호출 셸을 새 세션(새 그룹)에서 띄우고, 그 안의 서브셸이
// tfx-route 처럼 EXIT trap 으로 cleanup_workers 를 돈다.
const HARNESS = `
set -u
eval "$CLEANUP_FNS"
deregister_agent() { :; }
_no_timeout() { shift; "$@"; }
_PID_TRACK="$DIR/pids"; : > "$_PID_TRACK"
sleep 30 & echo $! > "$DIR/sibling"
(
  trap cleanup_workers EXIT
  if [ "$MODE" = own ]; then
    sleep 30 & echo $! >> "$_PID_TRACK"; echo $! > "$DIR/worker"
  elif [ "$MODE" = tee ]; then
    printf x | _exec_tracked _no_timeout 0 bash -c 'sleep 30 & echo $! > "$DIR/worker"; wait' 2>/dev/null | tee /dev/null > /dev/null &
    echo $! >> "$_PID_TRACK"
    sleep 0.3
  else
    cat "$DIR/sibling" >> "$_PID_TRACK"
  fi
  exit 0
)
echo reached > "$DIR/after"
`;

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runCleanup(mode) {
  const dir = mkdtempSync(path.join(tmpdir(), "tfx-548-"));
  const child = spawn("bash", ["-c", HARNESS], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CLEANUP_FNS, DIR: dir, MODE: mode },
  });
  await new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const read = (name) => Number(readFileSync(path.join(dir, name), "utf8"));
  const sibling = read("sibling");
  const result = {
    reached: existsSync(path.join(dir, "after")),
    siblingAlive: isAlive(sibling),
    workerAlive: mode === "foreign" ? null : isAlive(read("worker")),
  };
  for (const pid of [sibling, mode === "foreign" ? 0 : read("worker")]) {
    if (pid && isAlive(pid)) process.kill(pid, "SIGKILL");
  }
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("#548 cleanup_workers", { skip: process.platform === "win32" }, () => {
  it("같은 그룹의 워커만 죽이고 호출 셸과 형제는 남긴다", async () => {
    const r = await runCleanup("own");
    assert.equal(r.workerAlive, false);
    assert.equal(r.reached, true);
    assert.equal(r.siblingAlive, true);
  });

  it("tee 파이프라인에서도 형제 워커의 자손까지 종료한다", async () => {
    const r = await runCleanup("tee");
    assert.equal(r.workerAlive, false);
    assert.equal(r.reached, true);
    assert.equal(r.siblingAlive, true);
  });

  it("자기 자식이 아닌 추적 PID(재사용)는 건드리지 않는다", async () => {
    const r = await runCleanup("foreign");
    assert.equal(r.reached, true);
    assert.equal(r.siblingAlive, true);
  });
});

describe("#548 session-stale-cleanup POSIX PID 재사용", () => {
  const mtime = Date.parse("2026-10-08T00:00:00Z");
  const decide = (creationMs) =>
    shouldKillTrackedPid({
      pid: 4242,
      pidFileMtimeMs: mtime,
      procMap: new Map([[4242, { pid: 4242, creationMs }]]),
      isWindows: false,
    });

  it("추적 파일 이후 시작한 프로세스는 건너뛰고, 이전 프로세스는 종료 대상이다", () => {
    assert.equal(decide(mtime + 60_000), false);
    assert.equal(decide(mtime - 60_000), true);
    assert.equal(
      shouldKillTrackedPid({ pid: 4242, procMap: new Map(), isWindows: false }),
      false,
    );
  });

  it("ps etime 형식을 해석한다", () => {
    assert.equal(parseEtimeMs("05:07"), 307_000);
    assert.equal(parseEtimeMs("1-02:03:04"), 93_784_000);
  });
});

function hasTmux() {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("#548 tmux 세션 이름 접두사", {
  skip: process.platform === "win32" || !hasTmux(),
}, () => {
  it("이미 없는 세션을 끌 때 접두사만 같은 다른 세션은 살아남는다", async () => {
    // 사용자 tmux 서버와 분리한 소켓 디렉터리. 소켓 경로 길이 제한 때문에 /tmp 에 둔다.
    const sockDir = mkdtempSync("/tmp/tfx548-");
    const saved = {
      TMUX: process.env.TMUX,
      TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    };
    delete process.env.TMUX;
    process.env.TMUX_TMPDIR = sockDir;
    const tmux = (...args) => execFileSync("tmux", args, { stdio: "ignore" });
    try {
      tmux("new-session", "-d", "-s", "tfx548-gone-other", "sleep 30");
      const { killPsmuxSession } = await import("../../hub/team/psmux.mjs");
      killPsmuxSession("tfx548-gone");
      assert.doesNotThrow(() =>
        tmux("has-session", "-t", "=tfx548-gone-other"),
      );
    } finally {
      try {
        tmux("kill-server");
      } catch {}
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(sockDir, { recursive: true, force: true });
    }
  });
});

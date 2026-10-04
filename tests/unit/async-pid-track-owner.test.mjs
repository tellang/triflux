import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";

const SCRIPT = "scripts/tfx-route.sh";
const CLEANUP = "scripts/session-stale-cleanup.mjs";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(path, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (existsSync(path) && readFileSync(path, "utf-8").trim()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

// --async 는 맨 위 프로세스가 job id 만 찍고 끝난 뒤 서브셸이 워커를 돌린다.
// 추적 파일 이름이 끝난 프로세스의 PID 이면 SessionStart 의 session-stale-cleanup 이
// 소유자 사망으로 판정해 워커를 SIGTERM 한다 (codex 가 자기 훅에 죽던 원인).
describe("async 워커 PID 추적 파일 소유자", {
  skip: process.platform === "win32",
}, () => {
  it("부모가 끝난 뒤에도 추적 파일 소유자가 살아 있어 정리 훅이 워커를 죽이지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "tfx-async-owner-"));
    const env = {
      ...process.env,
      HOME: root,
      TMPDIR: root,
      TFX_JOBS_DIR: join(root, "jobs"),
      TFX_SELFTEST_WORKER_SEC: "20",
    };
    let workerPid = 0;
    try {
      const res = spawnSync(
        "bash",
        [SCRIPT, "--async-self-test", "pid-track-owner"],
        { encoding: "utf-8", env, timeout: 5_000 },
      );
      const jobId = (res.stdout || "").trim();
      assert.ok(jobId, `job id 가 비었다: ${res.stderr}`);

      const jobDir = join(env.TFX_JOBS_DIR, jobId);
      await waitFor(join(jobDir, "pid_track"));
      workerPid = Number(
        readFileSync(join(jobDir, "worker_pid"), "utf-8").trim(),
      );
      const trackPath = readFileSync(join(jobDir, "pid_track"), "utf-8").trim();
      const owner = Number(
        /^tfx-route-(\d+)-pids$/.exec(basename(trackPath))?.[1],
      );

      assert.ok(isAlive(workerPid), "워커가 떠 있어야 한다");
      assert.ok(
        isAlive(owner),
        `추적 파일 소유자 pid=${owner} 가 이미 끝났다 (끝난 부모의 $$ 를 쓰고 있음)`,
      );

      const cleanup = spawnSync(process.execPath, [CLEANUP], {
        encoding: "utf-8",
        env,
        input: "",
        timeout: 10_000,
      });
      assert.equal(
        cleanup.error,
        undefined,
        `정리 훅 실행 실패: ${cleanup.error}`,
      );
      assert.equal(cleanup.signal, null, "정리 훅이 신호로 끝났다");
      assert.equal(
        cleanup.status,
        0,
        `정리 훅 exit=${cleanup.status}: ${cleanup.stderr}`,
      );
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(
        isAlive(workerPid),
        "session-stale-cleanup 이 실행 중인 async 워커를 죽였다",
      );

      // 워커가 끝나면 main 과 같은 EXIT trap(cleanup_workers)이 추적 파일을 지운다.
      process.kill(workerPid, "SIGTERM");
      await waitFor(join(jobDir, "exit_code"));
      await new Promise((r) => setTimeout(r, 200));
      assert.ok(!existsSync(trackPath), `추적 파일이 남았다: ${trackPath}`);
    } finally {
      if (workerPid && isAlive(workerPid)) process.kill(workerPid, "SIGTERM");
      await new Promise((r) => setTimeout(r, 200));
      rmSync(root, { recursive: true, force: true });
    }
  });
});

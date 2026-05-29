import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cleanupDaemonDispatches } from "../../hub/team/headless.mjs";

function listenJsonServer(sockPath, handler) {
  const requests = [];
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const line = data.slice(0, data.indexOf("\n"));
      const request = JSON.parse(line);
      requests.push(request);
      const response = await handler(request);
      socket.end(`${JSON.stringify(response)}\n`);
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => resolve({ server, requests }));
  });
}

test("cleanupDaemonDispatches removes projection and kills daemon job within 5s", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daemon-cleanup-"));
  const sockPath = path.join(dir, "control.sock");
  const projectionPath = path.join(dir, "sessions", "session-target.json");
  await fs.mkdir(path.dirname(projectionPath), { recursive: true });
  await fs.writeFile(projectionPath, "{}\n", "utf8");

  const { server, requests } = await listenJsonServer(sockPath, (request) => {
    if (request.op === "list") {
      return {
        ok: true,
        op: "list",
        jobs: [{ short: "short222", sessionId: "session-target" }],
      };
    }
    return { ok: true, op: request.op, killed: request.short };
  });

  try {
    await Promise.race([
      cleanupDaemonDispatches([
        {
          controlSock: sockPath,
          daemonShort: "short222",
          daemonPaths: { controlSock: sockPath },
          sessionId: "session-target",
          sessionProjectionPath: projectionPath,
          daemonCompletionMatched: true,
        },
      ]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cleanup timed out")), 5000),
      ),
    ]);

    await assert.rejects(() => fs.access(projectionPath), {
      code: "ENOENT",
    });
    assert.deepEqual(requests, [
      { proto: 1, op: "list" },
      { proto: 1, op: "kill", short: "short222" },
      { proto: 1, op: "kill", short: "short222" },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// mutation-by-reference 회귀 가드: 공유 dispatch 헬퍼로 리팩터한 뒤에도
// dispatchDaemonBatch 가 만든 record 객체가 waitForDaemonCompletion 의 외부
// 변경(daemonCompletionMatched=true)을 그대로 보존해야 한다. 헬퍼가 record 를
// 새 객체로 교체하면 이 flip 이 유실되어 sendKillBySessionId(list→kill) 가 발사되지 않는다.
test("cleanupDaemonDispatches honors an externally-flipped daemonCompletionMatched (by-reference)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "daemon-flip-"));
  const sockPath = path.join(dir, "control.sock");
  const projectionPath = path.join(dir, "sessions", "session-flip.json");
  await fs.mkdir(path.dirname(projectionPath), { recursive: true });
  await fs.writeFile(projectionPath, "{}\n", "utf8");

  const { server, requests } = await listenJsonServer(sockPath, (request) => {
    if (request.op === "list") {
      return {
        ok: true,
        op: "list",
        jobs: [{ short: "flip333", sessionId: "session-flip" }],
      };
    }
    return { ok: true, op: request.op, killed: request.short };
  });

  try {
    // record 는 dispatch 시점에 daemonCompletionMatched=false 로 생성된다.
    const record = {
      controlSock: sockPath,
      daemonShort: "flip333",
      daemonPaths: { controlSock: sockPath },
      sessionId: "session-flip",
      sessionProjectionPath: projectionPath,
      daemonCompletionMatched: false,
    };
    const dispatches = [record];

    // waitForDaemonCompletion 이 완료를 감지하면 같은 record 를 reference 로 변경한다.
    record.daemonCompletionMatched = true;

    await Promise.race([
      cleanupDaemonDispatches(dispatches),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("cleanup timed out")), 5000),
      ),
    ]);

    // flip 이 보존됐다면 sendKillBySessionId 경로(list→kill)가 실행돼야 한다.
    const listCalls = requests.filter((r) => r.op === "list");
    const killCalls = requests.filter((r) => r.op === "kill");
    assert.equal(listCalls.length, 1, "sendKillBySessionId should list once");
    assert.ok(
      killCalls.length >= 1,
      "sendKillBySessionId must still fire a kill after the flip",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

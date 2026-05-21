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

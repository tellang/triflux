const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");
const { join, resolve } = require("node:path");

// 실제 허브를 띄우지 않고 CLI가 전달한 포트로 기동 완료 경계를 재현한다.
childProcess.spawn = (command, args, options) => {
  const port = Number(process.env.TFX_TEST_HUB_START_PORT);
  assert.ok(port > 0, "already-running hub must not spawn a daemon");
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [resolve(__dirname, "../../hub/server.mjs")]);
  assert.equal(options.env.TFX_HUB_PORT, String(port));
  writeFileSync(
    join(process.env.TFX_HUB_PID_DIR, "hub.pid"),
    JSON.stringify({
      pid: process.pid,
      port,
      host: "127.0.0.1",
      url: `http://127.0.0.1:${port}/mcp`,
    }),
  );
  return { unref() {} };
};
syncBuiltinESMExports();

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDaemonWrappedCommand,
  waitForDaemonCompletionFromMessages,
} from "../../hub/team/headless.mjs";

test("buildDaemonWrappedCommand emits a completion token with the child exit code", () => {
  const wrapped = buildDaemonWrappedCommand("printf ok", "tok123");
  assert.equal(
    wrapped,
    `{ printf ok; __ec=$?; echo "__TFX_HEADLESS_DONE__:tok123:$__ec"; }`,
  );
});

test("waitForDaemonCompletionFromMessages detects stream completion and writes partial output", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "daemon-completion-"));
  const resultFile = path.join(tmp, "worker.txt");
  const messages = [
    { type: "snapshot", streamTail: ["first"] },
    { type: "stream", line: "hello\n" },
    { type: "stream", line: "__TFX_HEADLESS_DONE__:tok123:0\n" },
  ];

  const completion = await waitForDaemonCompletionFromMessages(messages, {
    token: "tok123",
    resultFile,
  });

  assert.equal(completion.matched, true);
  assert.equal(completion.exitCode, 0);
  assert.match(await fs.readFile(`${resultFile}.partial`, "utf8"), /hello/);
  await fs.rm(tmp, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function waitForText(readOutput, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readOutput().includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`viewer output did not include ${JSON.stringify(expected)}`);
}

test("file-source viewer renders daemon heartbeat and live output without psmux", async () => {
  const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "daemon-viewer-"));
  const sessionName = "daemon-viewer-test";
  const viewerPath = path.join(
    import.meta.dirname,
    "../../hub/team/tui-viewer.mjs",
  );
  let stdout = "";
  let stderr = "";
  let child;

  try {
    child = spawn(
      process.execPath,
      [
        viewerPath,
        "--session",
        sessionName,
        "--result-dir",
        resultDir,
        "--layout",
        "lite",
        "--source",
        "files",
        "--workers",
        "1",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PSMUX_BIN: path.join(resultDir, "missing-mux") },
      },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    await waitForText(() => stdout, "waiting for output");
    await fs.writeFile(
      path.join(resultDir, `${sessionName}-worker-1.txt.partial`),
      "live daemon output\n",
      "utf8",
    );
    await waitForText(() => stdout, "live daemon output");

    child.kill("SIGINT");
    const exitCode = await new Promise((resolve) =>
      child.once("exit", resolve),
    );
    assert.equal(exitCode, 0, stderr);
    assert.doesNotMatch(stderr, /psmux 미설치|primary multiplexer 미설치/u);
  } finally {
    if (child?.exitCode === null) child.kill("SIGKILL");
    await fs.rm(resultDir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const BRIDGE = resolve(PROJECT_ROOT, "hub", "bridge.mjs");

function makeHomeWithPid(payload) {
  const homeDir = mkdtempSync(join(tmpdir(), "tfx-bridge-port-"));
  const pidDir = join(homeDir, ".claude", "cache", "tfx-hub");
  mkdirSync(pidDir, { recursive: true });
  writeFileSync(
    join(pidDir, "hub.pid"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return homeDir;
}

function readBridgeUrl(homeDir, extraEnv = {}) {
  const code = `
    import { pathToFileURL } from "node:url";
    const bridge = await import(pathToFileURL(${JSON.stringify(BRIDGE)}).href);
    console.log(bridge.getHubUrl());
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      ...extraEnv,
    },
  }).trim();
}

describe("bridge hub URL port resolution", () => {
  it("ignores stale hub.pid port and keeps the default port", () => {
    const homeDir = makeHomeWithPid({
      pid: 99999,
      host: "::1",
      port: 29115,
    });

    try {
      assert.equal(readBridgeUrl(homeDir), "http://[::1]:27888");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it("honors TFX_HUB_PORT over stale hub.pid port", () => {
    const homeDir = makeHomeWithPid({
      pid: 99999,
      host: "10.0.0.2",
      port: 29115,
    });

    try {
      assert.equal(
        readBridgeUrl(homeDir, { TFX_HUB_PORT: "30123" }),
        "http://127.0.0.1:30123",
      );
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

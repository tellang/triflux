import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..", "..");
const HUB_CLIENT = resolve(
  PROJECT_ROOT,
  "hub",
  "team",
  "cli",
  "services",
  "hub-client.mjs",
);

describe("team hub-client port resolution", () => {
  it("does not return a stale pid-file port when status probe fails", () => {
    const pidDir = mkdtempSync(join(tmpdir(), "tfx-hub-client-port-"));
    const code = `
      import { existsSync, readFileSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      const pidFile = join(process.env.TFX_HUB_PID_DIR, "hub.pid");
      writeFileSync(
        pidFile,
        JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: 1 }, null, 2) + "\\n",
        "utf8",
      );
      const client = await import(pathToFileURL(${JSON.stringify(HUB_CLIENT)}).href);
      const info = await client.getHubInfo();
      const pidExists = existsSync(pidFile);
      console.log(JSON.stringify({
        info,
        pidExists,
        pidFile: pidExists ? JSON.parse(readFileSync(pidFile, "utf8")) : null,
      }));
    `;

    try {
      const out = execFileSync(
        process.execPath,
        ["--input-type=module", "-e", code],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            TFX_HUB_PID_DIR: pidDir,
            TFX_HUB_PORT: "30125",
          },
        },
      );
      const result = JSON.parse(out);
      assert.notEqual(result.info?.port, 1);
      assert.notEqual(result.pidFile?.port, 1);
      assert.equal(result.info?.degraded, undefined);
    } finally {
      rmSync(pidDir, { recursive: true, force: true });
    }
  });
});

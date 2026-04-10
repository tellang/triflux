import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";

const tempDirs = [];

function createTempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTempPidDir() {
  return createTempDir("tfx-wt-manager-profile-");
}

function extractWrappedCommand(args) {
  const encIdx = args.lastIndexOf("-EncodedCommand");
  if (encIdx >= 0) {
    const b64 = args[encIdx + 1];
    return Buffer.from(b64, "base64").toString("utf16le");
  }
  const cmdIdx = args.lastIndexOf("-Command");
  return cmdIdx >= 0 ? args[cmdIdx + 1] : "";
}

function extractPidFile(args) {
  const wrapped = extractWrappedCommand(args);
  const match = /Set-Content '([^']+)'/u.exec(wrapped);
  if (!match) {
    throw new Error(`PID file path not found in wrapped command: ${wrapped}`);
  }
  return match[1];
}

function createHarness(options = {}) {
  let currentTime = options.startTime ?? 0;
  let nextPid = options.startPid ?? 3_000;
  const spawnCalls = [];
  const sleepCalls = [];
  const environment = options.environment || {
    shell: { name: "pwsh", path: "pwsh.exe", version: null },
    terminal: { name: "windows-terminal", hasWt: true, installHint: null },
    multiplexer: { name: "none", path: null },
    platform: options.platform || "win32",
  };

  const deps = {
    platform: () => options.platform || "win32",
    getEnvironment: () => environment,
    now: () => currentTime,
    sleep: async (ms) => {
      sleepCalls.push(ms);
      currentTime += ms;
    },
    spawn: (file, args, spawnOpts) => {
      const pid = nextPid++;
      spawnCalls.push({
        file,
        args: [...args],
        opts: { ...spawnOpts },
        pid,
        at: currentTime,
      });

      try {
        const pidFile = extractPidFile(args);
        if (options.writePidFile !== false) {
          writeFileSync(pidFile, String(pid), "utf8");
        }
      } catch {
        /* splitPane path */
      }

      return {
        unref() {},
      };
    },
    isPidAlive: options.isPidAlive || (() => true),
    exists: (filePath) => {
      const target = String(filePath);
      if (target.endsWith(".pid")) {
        return existsSync(target);
      }
      return false;
    },
    readText: (filePath) => readFileSync(filePath, "utf8"),
  };

  return {
    deps,
    spawnCalls,
    sleepCalls,
  };
}

async function loadInstrumentedCreateWtManager() {
  const wtManagerUrl = new URL("../../hub/team/wt-manager.mjs", import.meta.url);
  const envDetectUrl = new URL("../../hub/lib/env-detect.mjs", import.meta.url).href;
  const spawnTraceUrl = new URL("../../hub/lib/spawn-trace.mjs", import.meta.url).href;
  const psmuxUrl = new URL("../../hub/team/psmux.mjs", import.meta.url).href;

  let source = readFileSync(wtManagerUrl, "utf8");
  source = source
    .replace(
      'import { getEnvironment } from "../lib/env-detect.mjs";',
      `import { getEnvironment } from ${JSON.stringify(envDetectUrl)};`,
    )
    .replace(
      'import * as childProcess from "../lib/spawn-trace.mjs";',
      `import * as childProcess from ${JSON.stringify(spawnTraceUrl)};`,
    )
    .replace(
      'import { sendKeysToPane } from "./psmux.mjs";',
      `import { sendKeysToPane } from ${JSON.stringify(psmuxUrl)};`,
    )
    .replace(
      "function ensureWtProfile(workerCount = 2) {",
      "function ensureWtProfile(workerCount = 2) {\n    globalThis.__wtManagerEnsureWtProfileSpy?.(workerCount);",
    );

  const instrumented = `// ${randomUUID()}\n${source}`;
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(instrumented).toString("base64")}`;
  return import(moduleUrl);
}

afterEach(() => {
  delete globalThis.__wtManagerEnsureWtProfileSpy;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("wt-manager: profile auto-ensure", () => {
  it("createTab({ profile: 'triflux' })는 ensureWtProfile을 1회 호출한다", async () => {
    let ensureWtProfileCalls = 0;
    globalThis.__wtManagerEnsureWtProfileSpy = () => {
      ensureWtProfileCalls += 1;
    };

    const { createWtManager } = await loadInstrumentedCreateWtManager();
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: harness.deps,
    });

    await manager.createTab({
      title: "lead",
      profile: "triflux",
      command: 'Write-Host "ready"',
    });

    assert.equal(ensureWtProfileCalls, 1);
  });

  it("createTab({ profile 미지정 })는 ensureWtProfile을 호출하지 않는다", async () => {
    let ensureWtProfileCalls = 0;
    globalThis.__wtManagerEnsureWtProfileSpy = () => {
      ensureWtProfileCalls += 1;
    };

    const { createWtManager } = await loadInstrumentedCreateWtManager();
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: harness.deps,
    });

    await manager.createTab({
      title: "lead",
      command: 'Write-Host "ready"',
    });

    assert.equal(ensureWtProfileCalls, 0);
  });

  it("splitPane({ profile: 'triflux' })는 ensureWtProfile을 1회 호출한다", async () => {
    let ensureWtProfileCalls = 0;
    globalThis.__wtManagerEnsureWtProfileSpy = () => {
      ensureWtProfileCalls += 1;
    };

    const { createWtManager } = await loadInstrumentedCreateWtManager();
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: harness.deps,
    });

    await manager.splitPane({
      title: "worker-1",
      profile: "triflux",
    });

    assert.equal(ensureWtProfileCalls, 1);
  });

  it("splitPane({ profile 미지정 })는 ensureWtProfile을 호출하지 않는다", async () => {
    let ensureWtProfileCalls = 0;
    globalThis.__wtManagerEnsureWtProfileSpy = () => {
      ensureWtProfileCalls += 1;
    };

    const { createWtManager } = await loadInstrumentedCreateWtManager();
    const harness = createHarness();
    const manager = createWtManager({
      pidDir: createTempPidDir(),
      deps: harness.deps,
    });

    await manager.splitPane({
      title: "worker-1",
    });

    assert.equal(ensureWtProfileCalls, 0);
  });
});

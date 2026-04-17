import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const ORCHESTRATOR_PATH = fileURLToPath(
  new URL("../../hooks/hook-orchestrator.mjs", import.meta.url),
);

function writeHookScript(baseDir) {
  const scriptPath = join(baseDir, "hook-script.mjs");
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [
  markerPath,
  mode = "noop",
  rawCounterPath = "__NONE__",
  label = mode,
] = process.argv.slice(2);
const counterPath = rawCounterPath === "__NONE__" ? "" : rawCounterPath;

if (markerPath) {
  writeFileSync(markerPath, label, "utf8");
}

if (counterPath) {
  const current = existsSync(counterPath)
    ? Number(readFileSync(counterPath, "utf8") || "0")
    : 0;
  writeFileSync(counterPath, String(current + 1), "utf8");
}

if (mode === "output") {
  process.stdout.write(JSON.stringify({ systemMessage: \`handled:\${label}\` }));
}
`,
    "utf8",
  );
  return scriptPath;
}

function hookCommand(scriptPath, markerPath, mode, counterPath, label) {
  const safeCounterPath = counterPath || "__NONE__";
  return `"${process.execPath}" "${scriptPath}" "${markerPath}" "${mode}" "${safeCounterPath}" "${label}"`;
}

function createRegistry(hooks) {
  return {
    version: 1,
    events: {
      PreToolUse: hooks,
    },
  };
}

function runOrchestrator({
  cwd,
  registryPath,
  cacheDir,
  payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "echo hello" },
  },
}) {
  return spawnSync(process.execPath, [ORCHESTRATOR_PATH], {
    cwd,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      TRIFLUX_HOOK_REGISTRY: registryPath,
      TRIFLUX_HOOK_CACHE_DIR: cacheDir,
      TRIFLUX_HOOK_CACHE_TTL_MS: "10000",
    },
  });
}

describe("hook-orchestrator PreToolUse:Bash dedupe", () => {
  let sandboxDir;
  let hookScriptPath;
  let registryPath;
  let cacheDir;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "triflux-hook-orchestrator-"));
    hookScriptPath = writeHookScript(sandboxDir);
    registryPath = join(sandboxDir, "hook-registry.json");
    cacheDir = join(sandboxDir, "cache");
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("highest-priority Bash hook output short-circuits lower-priority hooks", () => {
    const firstMarker = join(sandboxDir, "first.txt");
    const secondMarker = join(sandboxDir, "second.txt");

    writeFileSync(
      registryPath,
      JSON.stringify(
        createRegistry([
          {
            id: "first",
            matcher: "Bash",
            command: hookCommand(
              hookScriptPath,
              firstMarker,
              "output",
              "",
              "first",
            ),
            priority: 0,
            enabled: true,
          },
          {
            id: "second",
            matcher: "Bash",
            command: hookCommand(
              hookScriptPath,
              secondMarker,
              "output",
              "",
              "second",
            ),
            priority: 10,
            enabled: true,
          },
        ]),
        null,
        2,
      ),
      "utf8",
    );

    const result = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(firstMarker));
    assert.equal(existsSync(secondMarker), false);
    assert.match(result.stdout, /handled:first/);
  });

  it("falls through to the next Bash hook when the higher-priority hook is a noop", () => {
    const firstMarker = join(sandboxDir, "first-noop.txt");
    const secondMarker = join(sandboxDir, "second-output.txt");

    writeFileSync(
      registryPath,
      JSON.stringify(
        createRegistry([
          {
            id: "first",
            matcher: "Bash",
            command: hookCommand(
              hookScriptPath,
              firstMarker,
              "noop",
              "",
              "first-noop",
            ),
            priority: 0,
            enabled: true,
          },
          {
            id: "second",
            matcher: "Bash",
            command: hookCommand(
              hookScriptPath,
              secondMarker,
              "output",
              "",
              "second-output",
            ),
            priority: 5,
            enabled: true,
          },
        ]),
        null,
        2,
      ),
      "utf8",
    );

    const result = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(firstMarker));
    assert.ok(existsSync(secondMarker));
    assert.match(result.stdout, /handled:second-output/);
  });

  it("caches identical PreToolUse:Bash results to avoid recomputing hooks", () => {
    const markerPath = join(sandboxDir, "cached-output.txt");
    const counterPath = join(sandboxDir, "counter.txt");

    writeFileSync(
      registryPath,
      JSON.stringify(
        createRegistry([
          {
            id: "cached",
            matcher: "Bash",
            command: hookCommand(
              hookScriptPath,
              markerPath,
              "output",
              counterPath,
              "cached",
            ),
            priority: 0,
            enabled: true,
          },
        ]),
        null,
        2,
      ),
      "utf8",
    );

    const first = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
    });
    const second = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
    });

    assert.equal(first.status, 0);
    assert.equal(second.status, 0);
    assert.equal(readFileSync(counterPath, "utf8"), "1");
    assert.equal(first.stdout, second.stdout);
  });
});

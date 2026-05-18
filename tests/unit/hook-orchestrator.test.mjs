import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
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

function createRegistry(hooks, eventName = "PreToolUse") {
  return {
    version: 1,
    events: {
      [eventName]: hooks,
    },
  };
}

function runOrchestrator({
  cwd,
  registryPath,
  cacheDir,
  env = {},
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
      ...env,
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

  it("does not emit context monitor nudge for unrelated PostToolUse Bash", () => {
    const nudgeMarker = join(tmpdir(), "tfx-compact-nudge-sent");
    rmSync(nudgeMarker, { force: true });

    const homeDir = join(sandboxDir, "home");
    const monitorDir = join(homeDir, ".claude", "cache", "tfx-hub");
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      join(monitorDir, "context-monitor.json"),
      JSON.stringify({ percent: 95 }),
      "utf8",
    );

    const marker = join(sandboxDir, "posttool-bash-noop.txt");
    writeFileSync(
      registryPath,
      JSON.stringify(
        createRegistry(
          [
            {
              id: "noop-posttool-bash",
              matcher: "Bash",
              command: hookCommand(hookScriptPath, marker, "noop", "", "noop"),
              priority: 0,
              enabled: true,
            },
          ],
          "PostToolUse",
        ),
        null,
        2,
      ),
      "utf8",
    );

    const result = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
      env: { HOME: homeDir, USERPROFILE: homeDir, TFX_POST_TOOL_TIPS: "" },
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hello" },
      },
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(marker));
    assert.equal(result.stdout.trim(), "");
    rmSync(nudgeMarker, { force: true });
  });

  it("does not emit compact nudge from hub token monitor snapshots", () => {
    const nudgeMarker = join(tmpdir(), "tfx-compact-nudge-sent");
    rmSync(nudgeMarker, { force: true });

    const homeDir = join(sandboxDir, "home-hub-token-monitor");
    const monitorDir = join(homeDir, ".claude", "cache", "tfx-hub");
    mkdirSync(monitorDir, { recursive: true });
    writeFileSync(
      join(monitorDir, "context-monitor.json"),
      JSON.stringify({
        sessionId: "88b086d5",
        limitTokens: 200_000,
        usedTokens: 12_194_022,
        requestTokens: 142_336,
        responseTokens: 12_051_686,
        totalUpdates: 5_646,
        byTool: { "tools/list": 11_888_383 },
        display: "12.2M/200K (100%)",
        percent: 100,
      }),
      "utf8",
    );

    const marker = join(sandboxDir, "posttool-edit-noop.txt");
    writeFileSync(
      registryPath,
      JSON.stringify(
        createRegistry(
          [
            {
              id: "noop-posttool-edit",
              matcher: "Edit",
              command: hookCommand(hookScriptPath, marker, "noop", "", "noop"),
              priority: 0,
              enabled: true,
            },
          ],
          "PostToolUse",
        ),
        null,
        2,
      ),
      "utf8",
    );

    const result = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
      env: { HOME: homeDir, USERPROFILE: homeDir, TFX_POST_TOOL_TIPS: "" },
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "README.md" },
      },
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(marker));
    assert.equal(result.stdout.trim(), "");
    rmSync(nudgeMarker, { force: true });
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

  it("propagates Stop context-guard block output from a blocking hook", () => {
    const marker = join(sandboxDir, "stop-context-guard.txt");
    writeFileSync(
      hookScriptPath,
      `import { writeFileSync } from "node:fs";\n` +
        `writeFileSync(${JSON.stringify(marker)}, "ran", "utf8");\n` +
        `process.stdout.write(JSON.stringify({ decision: "block", reason: "context high (Block 1/2)" }));\n`,
      "utf8",
    );
    writeFileSync(
      registryPath,
      JSON.stringify(
        createRegistry(
          [
            {
              id: "stop-context-guard",
              matcher: "*",
              command: `"${process.execPath}" "${hookScriptPath}"`,
              priority: 0,
              enabled: true,
              blocking: true,
            },
          ],
          "Stop",
        ),
        null,
        2,
      ),
      "utf8",
    );

    const result = runOrchestrator({
      cwd: sandboxDir,
      registryPath,
      cacheDir,
      payload: {
        hook_event_name: "Stop",
        tool_name: "Stop",
        stop_reason: "end_turn",
      },
    });

    assert.equal(result.status, 0);
    assert.ok(existsSync(marker));
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /Block 1\/2/);
  });
});

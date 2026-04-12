import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  attachWithWindowsTerminal,
  createIsolatedSessionName,
  evaluateContextDrift,
} from "../../scripts/session-spawn-helper.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

describe("session-spawn-helper createIsolatedSessionName()", () => {
  it("uses required tfx-isolated-{timestamp} format", () => {
    const sessionName = createIsolatedSessionName(1735689600123);
    assert.equal(sessionName, "tfx-isolated-1735689600123");
  });
});

describe("session-spawn-helper attachWithWindowsTerminal()", () => {
  it("is async and delegates to wt-manager splitPane", async () => {
    const result = attachWithWindowsTerminal("tfx-isolated-1735689600123", {
      profile: "triflux",
      title: "tfx-isolated-1735689600123",
    });
    // wt-manager splitPane will throw in test env (no WT), but the function is async
    assert.equal(typeof result.then, "function");
    // suppress unhandled rejection from missing WT
    await result.catch(() => {});
  });
});

describe("session-spawn-helper evaluateContextDrift()", () => {
  it("marks drift=true when overlap with task context is too low", () => {
    const result = evaluateContextDrift({
      taskPrompt: "Implement context isolation for psmux attach flow",
      latestOutput: "Updated README badges and npm keywords only",
      minOverlapRatio: 0.5,
    });
    assert.equal(result.drift, true);
    assert.equal(result.reason, "token-overlap-low");
  });

  it("keeps drift=false when output stays on task", () => {
    const result = evaluateContextDrift({
      taskPrompt: "Implement context isolation for psmux attach flow",
      latestOutput: "Implemented psmux isolation and attach flow update",
      minOverlapRatio: 0.3,
    });
    assert.equal(result.drift, false);
    assert.equal(result.reason, "token-overlap-ok");
  });
});

describe("session-spawn-helper CLI", () => {
  it("prints usage text without --spawn", () => {
    const result = spawnSync(
      process.execPath,
      [resolve(ROOT, "scripts", "session-spawn-helper.mjs")],
      { encoding: "utf8", timeout: 5000 },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      /session-spawn-helper: psmux 격리 세션 생성 도구/,
    );
    assert.match(result.stdout, /--spawn/);
  });
});

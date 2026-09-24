import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { writeJson } from "../release/lib.mjs";
import { verifyRelease } from "../release/verify.mjs";

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "tfx-verify-wait-"));
  writeJson(join(root, "package.json"), { version: "1.2.3" });
  writeJson(join(root, "scripts/release/version-manifest.json"), {
    canonicalFile: "package.json",
    canonicalPath: ["version"],
    targets: [{ file: "package.json", paths: [["version"]] }],
  });
  return root;
}

it("waits for all three npm packages to show the release version", async () => {
  const root = makeRepo();
  let now = 0;
  const sleeps = [];
  const calls = new Map();
  try {
    const result = await verifyRelease({
      rootDir: root,
      version: "1.2.3",
      dryRun: false,
      npmWaitSeconds: 40,
      npmPendingOk: true,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      execFileSyncFn: (command, args) => {
        if (command === "gh") return '{"tagName":"v1.2.3"}';
        assert.equal(command, "npm");
        const count = (calls.get(args[1]) || 0) + 1;
        calls.set(args[1], count);
        return count === 1 ? "1.2.2\n" : "1.2.3\n";
      },
    });
    assert.equal(result.ok, true);
    assert.equal(
      result.checks.some((check) => check.status === "pending"),
      false,
    );
    assert.deepEqual(sleeps, [20_000]);
    assert.deepEqual([...calls.values()], [2, 2, 2]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("passes with pending npm checks and emits one Actions warning at the deadline", async () => {
  const root = makeRepo();
  let now = 0;
  const calls = new Map();
  const warnings = [];
  const originalActions = process.env.GITHUB_ACTIONS;
  const originalLog = console.log;
  process.env.GITHUB_ACTIONS = "true";
  console.log = (message) => warnings.push(message);
  try {
    const result = await verifyRelease({
      rootDir: root,
      version: "1.2.3",
      dryRun: false,
      npmWaitSeconds: 20,
      npmPendingOk: true,
      nowFn: () => now,
      sleepFn: async (ms) => {
        now += ms;
      },
      execFileSyncFn: (command, args) => {
        if (command === "gh") return '{"tagName":"v1.2.3"}';
        const count = (calls.get(args[1]) || 0) + 1;
        calls.set(args[1], count);
        if (args[1].startsWith("@triflux/core")) return "1.2.3\n";
        if (args[1].startsWith("@triflux/remote") && count === 2) {
          throw new Error("registry timeout");
        }
        return args[1].startsWith("@triflux/remote") ? "1.2.2\n" : "1.2.1\n";
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual([...calls.values()], [2, 2, 2]);
    assert.deepEqual(
      result.checks
        .filter((check) => check.status === "pending")
        .map((check) => check.name),
      ["npm-view @triflux/remote", "npm-view triflux"],
    );
    assert.match(
      result.checks.find((check) => check.name === "npm-view @triflux/remote")
        .detail,
      /last seen 1\.2\.2; npm publish-time scan may still be processing/,
    );
    assert.match(
      result.checks.find((check) => check.name === "npm-view triflux").detail,
      /last seen 1\.2\.1; npm publish-time scan may still be processing/,
    );
    assert.equal(
      result.checks.find((check) => check.name === "github-release").ok,
      true,
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^::warning::npm registry pending/);
  } finally {
    console.log = originalLog;
    if (originalActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = originalActions;
    rmSync(root, { recursive: true, force: true });
  }
});

it("fails at one shared deadline and reports last seen versions after lookup errors", async () => {
  const root = makeRepo();
  let now = 0;
  const sleeps = [];
  const calls = new Map();
  try {
    const result = await verifyRelease({
      rootDir: root,
      version: "1.2.3",
      dryRun: false,
      npmWaitSeconds: 20,
      nowFn: () => now,
      sleepFn: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      execFileSyncFn: (command, args) => {
        if (command === "gh") return '{"tagName":"v1.2.3"}';
        assert.equal(command, "npm");
        const count = (calls.get(args[1]) || 0) + 1;
        calls.set(args[1], count);
        if (args[1].startsWith("@triflux/remote") && count === 2) {
          throw new Error("registry timeout");
        }
        return args[1].startsWith("triflux") ? "1.2.3\n" : "1.2.2\n";
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(sleeps, [20_000]);
    assert.deepEqual([...calls.values()], [2, 2, 2]);
    assert.match(
      result.checks.find((check) => check.name === "npm-view @triflux/core")
        .detail,
      /got 1\.2\.2/,
    );
    assert.match(
      result.checks.find((check) => check.name === "npm-view @triflux/remote")
        .detail,
      /last seen 1\.2\.2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects invalid npm wait durations", async () => {
  for (const npmWaitSeconds of [-1, Number.POSITIVE_INFINITY, "oops"]) {
    await assert.rejects(verifyRelease({ npmWaitSeconds }), /npm-wait-seconds/);
  }
});

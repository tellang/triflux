import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { compareMirror } from "../../scripts/release/check-packages-mirror.mjs";

const CORE_MIRRORS = new Map([
  ["hub/bridge.mjs", "packages/core/hub/bridge.mjs"],
  ["hub/router.mjs", "packages/core/hub/router.mjs"],
  [
    "hub/team/retry-state-machine.mjs",
    "packages/core/hub/team/retry-state-machine.mjs",
  ],
  [
    "hub/team/claude-agent-session-normalizer.mjs",
    "packages/core/hub/team/claude-agent-session-normalizer.mjs",
  ],
  [
    "hub/team/claude-daemon-control.mjs",
    "packages/core/hub/team/claude-daemon-control.mjs",
  ],
  [
    "hub/team/claude-session-projection.mjs",
    "packages/core/hub/team/claude-session-projection.mjs",
  ],
]);

function write(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function makeFixture(t) {
  const repoRoot = mkdtempSync(join(tmpdir(), "triflux-mirror-"));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));

  for (const [source, target] of CORE_MIRRORS) {
    write(repoRoot, source, `source:${source}\n`);
    write(repoRoot, target, `source:${source}\n`);
  }

  return repoRoot;
}

function findIssue(result, path, kind) {
  return result.issues.find(
    (issue) =>
      issue.path === path && (kind === undefined || issue.kind === kind),
  );
}

test("compareMirror detects a missing packages/core daemon helper mirror", (t) => {
  const repoRoot = makeFixture(t);
  rmSync(join(repoRoot, "packages/core/hub/team/claude-daemon-control.mjs"));

  const result = compareMirror({ fix: false, repoRoot });

  assert.equal(result.ok, false);
  assert.ok(
    findIssue(
      result,
      "packages/core/hub/team/claude-daemon-control.mjs",
      "missing-in-mirror",
    ),
  );
});

test("compareMirror --fix creates missing packages/core daemon helper parents and file", (t) => {
  const repoRoot = makeFixture(t);
  rmSync(join(repoRoot, "packages/core/hub/team"), {
    recursive: true,
    force: true,
  });

  const result = compareMirror({ fix: true, repoRoot });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.fixed.some(
      (fixed) =>
        fixed.kind === "added" &&
        fixed.path === "packages/core/hub/team/claude-daemon-control.mjs",
    ),
  );
  assert.equal(
    readFileSync(
      join(repoRoot, "packages/core/hub/team/claude-daemon-control.mjs"),
      "utf8",
    ),
    readFileSync(join(repoRoot, "hub/team/claude-daemon-control.mjs"), "utf8"),
  );
});

test("compareMirror detects packages/core content drift", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "packages/core/hub/bridge.mjs", "drift\n");

  const result = compareMirror({ fix: false, repoRoot });

  assert.equal(result.ok, false);
  assert.ok(findIssue(result, "packages/core/hub/bridge.mjs", "content-diff"));
});

test("compareMirror keeps existing packages/triflux top-level mirror behavior", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "bin/triflux", "#!/usr/bin/env node\n");

  const result = compareMirror({ fix: false, repoRoot });

  assert.equal(result.ok, false);
  assert.ok(
    findIssue(result, "packages/triflux/bin/triflux", "missing-in-mirror"),
  );
});

// --- packages/core/hud directory mirror tests ---

test("compareMirror detects missing packages/core/hud file", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "hud/constants.mjs", "export const X = 1;\n");
  write(repoRoot, "packages/core/hud/constants.mjs", "export const X = 1;\n");
  // Remove one file from core mirror to simulate drift
  rmSync(join(repoRoot, "packages/core/hud/constants.mjs"));

  const result = compareMirror({ fix: false, repoRoot });

  assert.equal(result.ok, false);
  assert.ok(
    findIssue(result, "packages/core/hud/constants.mjs", "missing-in-mirror"),
  );
});

test("compareMirror detects content drift in packages/core/hud file", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "hud/constants.mjs", "export const X = 1;\n");
  write(repoRoot, "packages/core/hud/constants.mjs", "export const X = 2;\n");

  const result = compareMirror({ fix: false, repoRoot });

  assert.equal(result.ok, false);
  assert.ok(
    findIssue(result, "packages/core/hud/constants.mjs", "content-diff"),
  );
});

test("compareMirror --fix syncs packages/core/hud drift", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "hud/constants.mjs", "export const X = 1;\n");
  write(repoRoot, "packages/core/hud/constants.mjs", "export const X = 2;\n");

  const result = compareMirror({ fix: true, repoRoot });

  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.ok(
    result.fixed.some(
      (f) =>
        f.kind === "updated" && f.path === "packages/core/hud/constants.mjs",
    ),
  );
  assert.equal(
    readFileSync(join(repoRoot, "packages/core/hud/constants.mjs"), "utf8"),
    "export const X = 1;\n",
  );
});

test("compareMirror --fix creates missing packages/core/hud file and parents", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "hud/providers/gemini.mjs", "export const P = 1;\n");

  const result = compareMirror({ fix: true, repoRoot });

  assert.equal(result.ok, true);
  assert.ok(
    result.fixed.some(
      (f) =>
        f.kind === "added" &&
        f.path === "packages/core/hud/providers/gemini.mjs",
    ),
  );
  assert.equal(
    readFileSync(
      join(repoRoot, "packages/core/hud/providers/gemini.mjs"),
      "utf8",
    ),
    "export const P = 1;\n",
  );
});

test("compareMirror detects orphan in packages/core/hud", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "packages/core/hud/orphan.mjs", "// orphan\n");

  const result = compareMirror({ fix: false, repoRoot });

  assert.equal(result.ok, false);
  assert.ok(
    findIssue(result, "packages/core/hud/orphan.mjs", "orphan-in-mirror"),
  );
});

test("compareMirror reports clean when packages/core/hud matches root hud", (t) => {
  const repoRoot = makeFixture(t);
  write(repoRoot, "hud/constants.mjs", "export const X = 1;\n");
  write(repoRoot, "packages/core/hud/constants.mjs", "export const X = 1;\n");

  const result = compareMirror({ fix: false, repoRoot });

  // Only check hud-related issues are absent; other fixtures may add issues
  const hudIssues = result.issues.filter((i) =>
    i.path.startsWith("packages/core/hud/"),
  );
  assert.deepEqual(hudIssues, []);
});

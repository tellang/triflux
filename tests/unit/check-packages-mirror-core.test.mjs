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
  [
    "hub/team/retry-state-machine.mjs",
    "packages/core/hub/team/retry-state-machine.mjs",
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

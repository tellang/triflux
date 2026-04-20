// scanHubWorkerFiles — recursive sync regression guard.
//
// PR #139 fixed a silent sync gap where `hub/workers/lib/jsonrpc-stdio.mjs`
// was never copied to `~/.claude/scripts/` because the scanner only walked
// top-level `hub/workers/*.mjs`. This suite pins the recursive behavior so
// a future refactor cannot silently re-break nested worker deps.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { scanHubWorkerFiles } from "../../scripts/setup.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "tfx-scan-test-"));
  const claude = mkdtempSync(join(tmpdir(), "tfx-scan-claude-"));
  mkdirSync(join(root, "hub", "workers", "lib"), { recursive: true });
  mkdirSync(join(root, "hub", "workers", "deep", "nested"), { recursive: true });
  // top-level workers
  writeFileSync(join(root, "hub", "workers", "factory.mjs"), "// factory");
  writeFileSync(
    join(root, "hub", "workers", "codex-app-server-worker.mjs"),
    "// codex app",
  );
  // nested lib — the exact regression case
  writeFileSync(
    join(root, "hub", "workers", "lib", "jsonrpc-stdio.mjs"),
    "// jsonrpc",
  );
  // deeper nested
  writeFileSync(
    join(root, "hub", "workers", "deep", "nested", "inner.mjs"),
    "// deep",
  );
  // non-mjs (should be skipped)
  writeFileSync(
    join(root, "hub", "workers", "README.md"),
    "# readme",
  );
  writeFileSync(
    join(root, "hub", "workers", "lib", "data.json"),
    "{}",
  );
  // hub-root deps (test covers the existing branch too)
  writeFileSync(join(root, "hub", "cli-adapter-base.mjs"), "// base");
  writeFileSync(join(root, "hub", "platform.mjs"), "// platform");
  return { root, claude };
}

test("scanHubWorkerFiles: includes top-level .mjs workers", () => {
  const { root, claude } = makeFixture();
  try {
    const results = scanHubWorkerFiles(root, claude);
    const labels = results.map((r) => r.label);
    assert.ok(labels.includes("hub/workers/factory.mjs"));
    assert.ok(labels.includes("hub/workers/codex-app-server-worker.mjs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test("scanHubWorkerFiles: includes nested lib/*.mjs (PR #139 regression)", () => {
  const { root, claude } = makeFixture();
  try {
    const results = scanHubWorkerFiles(root, claude);
    const labels = results.map((r) => r.label);
    assert.ok(
      labels.includes("hub/workers/lib/jsonrpc-stdio.mjs"),
      `expected nested lib path, got: ${labels.join(", ")}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test("scanHubWorkerFiles: walks arbitrarily deep subdirectories", () => {
  const { root, claude } = makeFixture();
  try {
    const results = scanHubWorkerFiles(root, claude);
    const labels = results.map((r) => r.label);
    assert.ok(labels.includes("hub/workers/deep/nested/inner.mjs"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test("scanHubWorkerFiles: skips non-.mjs files", () => {
  const { root, claude } = makeFixture();
  try {
    const results = scanHubWorkerFiles(root, claude);
    const labels = results.map((r) => r.label);
    assert.ok(!labels.some((l) => l.endsWith(".md")));
    assert.ok(!labels.some((l) => l.endsWith(".json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test("scanHubWorkerFiles: dst labels use forward slashes regardless of platform", () => {
  const { root, claude } = makeFixture();
  try {
    const results = scanHubWorkerFiles(root, claude);
    for (const r of results) {
      if (r.label.startsWith("hub/workers/")) {
        assert.ok(
          !r.label.includes("\\"),
          `label must use forward slashes, got: ${r.label}`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test("scanHubWorkerFiles: dst path preserves nested structure under claudeDir", () => {
  const { root, claude } = makeFixture();
  try {
    const results = scanHubWorkerFiles(root, claude);
    const nested = results.find(
      (r) => r.label === "hub/workers/lib/jsonrpc-stdio.mjs",
    );
    assert.ok(nested, "nested entry must exist");
    const expectedTail = join(
      "scripts",
      "hub",
      "workers",
      "lib",
      "jsonrpc-stdio.mjs",
    );
    assert.ok(
      nested.dst.endsWith(expectedTail),
      `dst must end with ${expectedTail}, got: ${nested.dst}`,
    );
    assert.ok(nested.dst.startsWith(claude), "dst must live under claudeDir");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

test("scanHubWorkerFiles: empty hub/ returns empty array, no throw", () => {
  const claude = mkdtempSync(join(tmpdir(), "tfx-scan-empty-"));
  const root = mkdtempSync(join(tmpdir(), "tfx-scan-noroot-"));
  try {
    assert.deepEqual(scanHubWorkerFiles(root, claude), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(claude, { recursive: true, force: true });
  }
});

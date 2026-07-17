// packages-mirror — smoke test that check-packages-mirror.mjs reports
// Mirror OK on a healthy tree. If this fails in CI, the dev forgot to
// run `npm run release:check-mirror:fix` after editing any mirrored top
// (bin, config, hooks, hub, hud, mesh, scripts, skills).

import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { compareMirror } from "../../scripts/release/check-packages-mirror.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("packages/triflux mirror is byte-identical to root", () => {
  const result = compareMirror({ fix: false });
  if (!result.ok) {
    const lines = result.issues
      .map((i) => `  ${i.kind.padEnd(18)} ${i.path}`)
      .join("\n");
    assert.fail(
      `packages/triflux mirror drift — run 'npm run release:check-mirror:fix':\n${lines}`,
    );
  }
  assert.equal(result.ok, true);
  assert.equal(result.issues.length, 0);
});

// Lock-in coverage for mirrored tops. Without these in MIRROR_TOPS the
// release gate silently ignores drift in those root directories — caught by
// Codex review on PR #319 follow-up and mirror-policy follow-ups.
function withMirrorProbe(rel, fn) {
  const probePath = join(REPO_ROOT, rel);
  writeFileSync(probePath, "probe");
  try {
    fn();
  } finally {
    rmSync(probePath, { force: true });
  }
}

test("check-packages-mirror walks hooks/ top-level dir", () => {
  withMirrorProbe("hooks/__mirror_probe_temp__.txt", () => {
    const result = compareMirror({ fix: false });
    const found = result.issues.find((i) =>
      i.path.endsWith("hooks/__mirror_probe_temp__.txt"),
    );
    assert.ok(
      found,
      "hooks/ drift was not flagged — check-packages-mirror.mjs MIRROR_TOPS regression",
    );
    assert.equal(found.kind, "missing-in-mirror");
  });
});

test("check-packages-mirror walks hud/ top-level dir", () => {
  withMirrorProbe("hud/__mirror_probe_temp__.txt", () => {
    const result = compareMirror({ fix: false });
    const found = result.issues.find((i) =>
      i.path.endsWith("hud/__mirror_probe_temp__.txt"),
    );
    assert.ok(
      found,
      "hud/ drift was not flagged — check-packages-mirror.mjs MIRROR_TOPS regression",
    );
    assert.equal(found.kind, "missing-in-mirror");
  });
});

test("check-packages-mirror walks config/ top-level dir", () => {
  withMirrorProbe("config/__mirror_probe_temp__.json", () => {
    const result = compareMirror({ fix: false });
    const found = result.issues.find((i) =>
      i.path.endsWith("config/__mirror_probe_temp__.json"),
    );
    assert.ok(
      found,
      "config/ drift was not flagged — check-packages-mirror.mjs MIRROR_TOPS regression",
    );
    assert.equal(found.kind, "missing-in-mirror");
  });
});

test("check-packages-mirror walks skills/ top-level dir", () => {
  withMirrorProbe("skills/__mirror_probe_temp__.txt", () => {
    const result = compareMirror({ fix: false });
    const found = result.issues.find((i) =>
      i.path.endsWith("skills/__mirror_probe_temp__.txt"),
    );
    assert.ok(
      found,
      "skills/ drift was not flagged — check-packages-mirror.mjs MIRROR_TOPS regression",
    );
    assert.equal(found.kind, "missing-in-mirror");
  });
});

test("check-packages-mirror walks adapters/ top-level dir", () => {
  withMirrorProbe("adapters/__mirror_probe_temp__.txt", () => {
    const result = compareMirror({ fix: false });
    const found = result.issues.find((i) =>
      i.path.endsWith("adapters/__mirror_probe_temp__.txt"),
    );
    assert.ok(
      found,
      "adapters/ drift was not flagged — MIRROR_TOPS regression",
    );
    assert.equal(found.kind, "missing-in-mirror");
  });
});

test("check-packages-mirror skips skills/tfx-workspace", () => {
  // tfx-workspace is excluded from npm tarball via
  // packages/triflux/package.json files negation ("!skills/tfx-workspace"),
  // so source-tree drift in that subtree must not fail the release gate.
  withMirrorProbe("skills/tfx-workspace/__mirror_probe_temp__.txt", () => {
    const result = compareMirror({ fix: false });
    const leaked = result.issues.find((i) =>
      i.path.includes("tfx-workspace/__mirror_probe_temp__"),
    );
    assert.equal(
      leaked,
      undefined,
      "tfx-workspace drift was flagged — SKIP_RELS regression",
    );
  });
});

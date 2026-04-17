// tests/unit/packages-sync.test.mjs — PRD-4 packages/* sync verification
//
// Purpose
//  - After `npm run pack`, the root hub/workers files must be byte-identical to
//    their packages/{core,triflux,remote}/hub/workers/ counterparts. This test
//    enforces that contract for the two files PRD-1 and PRD-2 introduced:
//      - hub/workers/codex-app-server-worker.mjs
//      - hub/workers/lib/jsonrpc-stdio.mjs
//
// Gate semantics
//  - If the packages/* copy does not exist at all, the test is SKIPPED with a
//    diagnostic — this is the expected state between PRD-1/2 landing and the
//    next `npm run pack`. Once pack runs, every package must have the file.
//  - If the packages/* copy exists but its sha256 differs from the root copy,
//    the test FAILS. That is the drift signal we want.
//  - Core is always present (it is the canonical source); triflux and remote
//    are permitted to be missing because pack is manual.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");

/** Relative paths (from project root) that PRD-4 must keep in sync. */
const TRACKED_FILES = Object.freeze([
  "hub/workers/codex-app-server-worker.mjs",
  "hub/workers/lib/jsonrpc-stdio.mjs",
]);

/** Downstream package trees that receive copies via `npm run pack`. */
const PACKAGES = Object.freeze(["core", "triflux", "remote"]);

function sha256File(absPath) {
  const buf = readFileSync(absPath);
  return createHash("sha256").update(buf).digest("hex");
}

describe("packages/* sync — PRD-4 gate", () => {
  for (const rel of TRACKED_FILES) {
    describe(rel, () => {
      const rootAbs = resolve(PROJECT_ROOT, rel);
      const rootExists = existsSync(rootAbs);
      const rootHash = rootExists ? sha256File(rootAbs) : null;

      it(
        "root file exists (PRD-1/2 landed)",
        { skip: rootExists ? false : "root file missing; PRD-1/2 not yet landed" },
        () => {
          assert.equal(rootExists, true);
          assert.equal(typeof rootHash, "string");
          assert.equal(rootHash.length, 64);
        },
      );

      for (const pkg of PACKAGES) {
        const pkgAbs = resolve(PROJECT_ROOT, "packages", pkg, rel);
        const pkgExists = existsSync(pkgAbs);

        // Gate: if the root exists but the package copy is missing, SKIP with
        // a diagnostic — pack has not run yet. If both exist, the hashes must
        // match. If the root is missing, skip the entire package check.
        const skipReason = !rootExists
          ? "root file missing"
          : !pkgExists
            ? `packages/${pkg}/${rel} missing — run \`npm run pack\` to sync`
            : false;

        it(
          `packages/${pkg}/${rel} matches root sha256`,
          { skip: skipReason },
          () => {
            assert.equal(pkgExists, true);
            const pkgHash = sha256File(pkgAbs);
            assert.equal(
              pkgHash,
              rootHash,
              `packages/${pkg}/${rel} sha256 drift from root:\n` +
                `  root: ${rootHash}\n` +
                `  pkg:  ${pkgHash}\n` +
                "Run `npm run pack` to re-sync.",
            );
          },
        );
      }
    });
  }
});

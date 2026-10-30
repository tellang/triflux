import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AGY_PEER_WAKE_ORIG_CALL,
  AGY_PEER_WAKE_ORIG_STP,
  AGY_TIME_AFTER_SIG,
  applyAgyPeerWakePatch,
  inspectAgyPeerWakePatch,
  inspectMacTimeoutDependency,
} from "../../scripts/lib/doctor-env-checks.mjs";

function makeSyntheticAgyBinary({
  size = 0x1000,
  timeAfterOffset = 0x100,
  callOffset = 0x400,
} = {}) {
  const buf = Buffer.alloc(size, 0);
  AGY_TIME_AFTER_SIG.copy(buf, timeAfterOffset);
  AGY_PEER_WAKE_ORIG_CALL.copy(buf, callOffset);
  AGY_PEER_WAKE_ORIG_STP.copy(buf, callOffset + 0x38);
  return buf;
}

describe("doctor environment checks", () => {
  it("flags macOS when neither timeout nor gtimeout is available (#227)", () => {
    const result = inspectMacTimeoutDependency({
      platform: "darwin",
      commandExists: () => false,
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "missing");
    assert.match(result.fix, /brew install coreutils/);
  });

  it("accepts gtimeout as the macOS timeout provider (#227)", () => {
    const result = inspectMacTimeoutDependency({
      platform: "darwin",
      commandExists: (name) => name === "gtimeout",
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "gtimeout");
  });

  it("detects unpatched agy binary and applies peer-wake patch with metadata (#1022)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-agy-patch-"));
    try {
      const agyPath = join(dir, "agy");
      writeFileSync(agyPath, makeSyntheticAgyBinary(), { mode: 0o755 });

      const before = inspectAgyPeerWakePatch({
        agyPath,
        platform: "darwin",
        arch: "arm64",
      });
      assert.equal(before.ok, false);
      assert.equal(before.status, "unpatched");
      assert.equal(before.patchable, true);

      const codesignCalls = [];
      const applied = applyAgyPeerWakePatch({
        agyPath,
        version: "1.4.10",
        platform: "darwin",
        arch: "arm64",
        execFileSyncFn: (cmd, args) => {
          codesignCalls.push([cmd, args]);
          return "";
        },
      });
      assert.equal(applied.ok, true);
      assert.equal(applied.changed, true);
      assert.equal(applied.status, "patched");
      assert.equal(codesignCalls.length, 1);
      assert.equal(codesignCalls[0][0], "codesign");

      const after = inspectAgyPeerWakePatch({
        agyPath,
        platform: "darwin",
        arch: "arm64",
      });
      assert.equal(after.ok, true);
      assert.equal(after.status, "patched");

      const meta = JSON.parse(readFileSync(`${agyPath}.patch.json`, "utf8"));
      assert.equal(meta.version, "1.4.10");
      assert.equal(meta.sha256, after.sha256);
      assert.ok(meta.patches.includes("peer-wake"));
      assert.equal(meta.backups["1.4.10-orig"].sha256, before.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refreshes outdated patch.json when binary is already patched (#1022)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-agy-meta-"));
    try {
      const agyPath = join(dir, "agy");
      writeFileSync(agyPath, makeSyntheticAgyBinary(), { mode: 0o755 });

      applyAgyPeerWakePatch({
        agyPath,
        version: "1.4.10",
        platform: "darwin",
        arch: "arm64",
        execFileSyncFn: () => "",
      });
      writeFileSync(
        `${agyPath}.patch.json`,
        JSON.stringify({ sha256: "stale", patches: ["peer-wake"] }),
      );

      const stale = inspectAgyPeerWakePatch({
        agyPath,
        platform: "darwin",
        arch: "arm64",
      });
      assert.equal(stale.ok, false);
      assert.equal(stale.status, "metadata-outdated");
      assert.equal(stale.patchable, true);

      const refreshed = applyAgyPeerWakePatch({
        agyPath,
        version: "1.4.10",
        platform: "darwin",
        arch: "arm64",
        execFileSyncFn: () => {
          throw new Error("codesign should not run for metadata refresh");
        },
      });
      assert.equal(refreshed.ok, true);
      assert.equal(refreshed.changed, true);

      const after = inspectAgyPeerWakePatch({
        agyPath,
        platform: "darwin",
        arch: "arm64",
      });
      assert.equal(after.ok, true);
      assert.equal(after.status, "patched");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("guards against binary replacement, non-object patch.json, and mismatched backup (#1022)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-agy-guard-"));
    try {
      const agyPath = join(dir, "agy");
      writeFileSync(agyPath, makeSyntheticAgyBinary({ callOffset: 0x400 }), {
        mode: 0o755,
      });
      writeFileSync(`${agyPath}.bak-1.4.10-orig`, Buffer.from("older-build"));
      writeFileSync(`${agyPath}.patch.json`, "null");

      assert.throws(() => {
        applyAgyPeerWakePatch({
          agyPath,
          platform: "darwin",
          arch: "arm64",
          execFileSyncFn: (cmd) => {
            if (cmd.endsWith("/agy")) {
              writeFileSync(
                agyPath,
                makeSyntheticAgyBinary({ callOffset: 0x500 }),
                { mode: 0o755 },
              );
              return "agy 1.4.10";
            }
            return "";
          },
        });
      }, /agy binary changed during patch preparation/);

      const applied = applyAgyPeerWakePatch({
        agyPath,
        version: "1.4.10",
        platform: "darwin",
        arch: "arm64",
        execFileSyncFn: () => "",
      });
      assert.equal(applied.ok, true);
      const meta = JSON.parse(readFileSync(`${agyPath}.patch.json`, "utf8"));
      const backupKeys = Object.keys(meta.backups);
      assert.equal(backupKeys.length, 1);
      assert.match(backupKeys[0], /^1\.4\.10-orig-[0-9a-f]{8}$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

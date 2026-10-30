import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  it("rejects conflicting backups before changing the binary or metadata (#1022)", () => {
    const dir = mkdtempSync(join(tmpdir(), "tfx-agy-backup-conflict-"));
    try {
      const agyPath = join(dir, "agy");
      const original = makeSyntheticAgyBinary();
      const sha256 = createHash("sha256").update(original).digest("hex");
      const backupPath = `${agyPath}.bak-1.4.10-orig`;
      const suffixPath = `${backupPath}-${sha256.slice(0, 8)}`;
      const patchJsonPath = `${agyPath}.patch.json`;
      const originalFiles = new Map([
        [agyPath, original],
        [backupPath, Buffer.from("older-build")],
        [suffixPath, Buffer.from("conflicting-build")],
        [patchJsonPath, Buffer.from('{"patches":["existing-patch"]}\n')],
      ]);
      for (const [path, contents] of originalFiles) {
        writeFileSync(path, contents);
      }

      const codesignCalls = [];
      let patchError;
      try {
        applyAgyPeerWakePatch({
          agyPath,
          version: "1.4.10",
          platform: "darwin",
          arch: "arm64",
          execFileSyncFn: (cmd) => {
            codesignCalls.push(cmd);
            return "";
          },
        });
      } catch (error) {
        patchError = error;
      }

      assert.ok(patchError instanceof Error, "backup conflict must throw");
      assert.match(patchError.message, /backup.*(?:conflict|mismatch)/i);
      for (const [path, contents] of originalFiles) {
        assert.deepEqual(
          readFileSync(path),
          contents,
          `${path} must be preserved`,
        );
      }
      assert.deepEqual(codesignCalls, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const backupKind of ["default", "suffix"]) {
    it(`reuses a matching ${backupKind} backup without overwriting it (#1022)`, () => {
      const dir = mkdtempSync(join(tmpdir(), "tfx-agy-backup-reuse-"));
      try {
        const agyPath = join(dir, "agy");
        const original = makeSyntheticAgyBinary();
        const sha256 = createHash("sha256").update(original).digest("hex");
        const defaultPath = `${agyPath}.bak-1.4.10-orig`;
        const backupKey =
          backupKind === "default"
            ? "1.4.10-orig"
            : `1.4.10-orig-${sha256.slice(0, 8)}`;
        const backupPath = `${agyPath}.bak-${backupKey}`;
        writeFileSync(agyPath, original);
        if (backupKind === "suffix") {
          writeFileSync(defaultPath, "older-build");
        }
        writeFileSync(backupPath, original);
        const before = statSync(backupPath, { bigint: true });

        const applied = applyAgyPeerWakePatch({
          agyPath,
          version: "1.4.10",
          platform: "darwin",
          arch: "arm64",
          execFileSyncFn: () => "",
        });

        assert.equal(applied.status, "patched");
        assert.equal(applied.changed, true);
        assert.notDeepEqual(readFileSync(agyPath), original);
        assert.deepEqual(readFileSync(backupPath), original);
        const after = statSync(backupPath, { bigint: true });
        assert.equal(after.ino, before.ino);
        assert.equal(after.mtimeNs, before.mtimeNs);
        if (backupKind === "suffix") {
          assert.equal(readFileSync(defaultPath, "utf8"), "older-build");
        }
        const meta = JSON.parse(readFileSync(`${agyPath}.patch.json`, "utf8"));
        assert.deepEqual(meta.backups[backupKey], {
          path: realpathSync(backupPath),
          sha256,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

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

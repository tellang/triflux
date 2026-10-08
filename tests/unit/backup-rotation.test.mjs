import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BACKUP_KEEP,
  writeRotatedBackup,
} from "../../scripts/lib/backup-rotation.mjs";

test("같은 label 의 백업은 최근 BACKUP_KEEP 개만 남는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "tfx-backup-rotation-"));
  try {
    const target = join(dir, "config.toml");
    writeFileSync(target, "a = 1\n");
    writeFileSync(join(dir, "config.toml.bak-test-manual-1"), "keep");
    for (let i = 0; i < BACKUP_KEEP + 2; i++) {
      const backup = writeRotatedBackup(target, `v${i}`, {
        label: "bak-test",
        suffix: String(i),
        mode: 0o600,
      });
      utimesSync(backup, 1_000 + i, 1_000 + i);
    }
    const left = readdirSync(dir).filter((name) => /bak-test-\d+$/.test(name));
    assert.deepEqual(
      left.sort(),
      [2, 3, 4, 5, 6].map((i) => `config.toml.bak-test-${i}`),
    );
    assert.ok(readdirSync(dir).includes("config.toml.bak-test-manual-1"));
    if (process.platform !== "win32")
      assert.equal(statSync(join(dir, left[0])).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

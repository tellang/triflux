import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
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

test("같은 시각 이름에 다른 원문이 오면 번호를 붙여 따로 백업한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "tfx-backup-rotation-"));
  try {
    const target = join(dir, "config.toml");
    const options = { label: "bak-test", suffix: "20261008-000000" };
    const first = writeRotatedBackup(target, "first", options);
    assert.equal(writeRotatedBackup(target, "first", options), first);
    const second = writeRotatedBackup(target, "second", options);
    assert.notEqual(second, first);
    assert.equal(readFileSync(second, "utf8"), "second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("같은 이름의 백업을 읽지 못하면 덮어쓰지 않고 오류를 낸다", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "tfx-backup-rotation-"));
  try {
    const target = join(dir, "config.toml");
    const options = { label: "bak-test", suffix: "20261008-000000" };
    const first = writeRotatedBackup(target, "first", options);
    chmodSync(first, 0o000);
    assert.throws(() => writeRotatedBackup(target, "second", options), {
      code: "EACCES",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

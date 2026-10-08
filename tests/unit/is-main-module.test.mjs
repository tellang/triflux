import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const helperUrl = new URL(
  "../../scripts/lib/process-utils.mjs",
  import.meta.url,
);

it("공백과 한글이 든 경로에서도 직접 실행을 판정한다", () => {
  const root = mkdtempSync(join(tmpdir(), "tfx-main-"));
  try {
    const dir = join(root, "공백 있는 경로");
    mkdirSync(dir);
    const script = join(dir, "entry.mjs");
    writeFileSync(
      script,
      `import { isMainModule } from ${JSON.stringify(helperUrl.href)};\nconsole.log(isMainModule(import.meta.url));\n`,
    );
    const link = join(root, "link.mjs");
    symlinkSync(script, link);
    for (const args of [[script], ["--preserve-symlinks-main", link]]) {
      const run = spawnSync(process.execPath, args, { encoding: "utf8" });
      assert.equal(run.stdout.trim(), "true", run.stderr);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

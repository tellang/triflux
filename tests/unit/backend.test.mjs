import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getBackend } from "../../hub/team/backend.mjs";

test("Claude 는 프롬프트를 argv 가 아니라 stdin 으로 받는다", {
  skip: process.platform === "win32",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "tfx-s5-backend-"));
  try {
    const fakeCli = join(dir, "claude");
    writeFileSync(
      fakeCli,
      `#!/usr/bin/env node
let stdin = "";
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () =>
  process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), stdin })),
);
`,
    );
    chmodSync(fakeCli, 0o755);
    const resultFile = join(dir, "result's output.txt");
    const injectedFile = join(dir, "injected");
    const prompt = `quotes ' " spaces
$(touch '${injectedFile}') \`touch '${injectedFile}'\``;
    const command = getBackend("claude").buildArgs(prompt, resultFile, {
      isWindows: false,
    });
    execFileSync("/bin/sh", ["-c", command], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    });
    assert.deepEqual(JSON.parse(readFileSync(resultFile, "utf8")), {
      argv: ["--print", "--output-format", "text"],
      stdin: prompt,
    });
    assert.equal(existsSync(injectedFile), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unsupported headless backend fails explicitly", () => {
  assert.throws(() => getBackend("unknown"), /지원하지 않는 CLI/);
});

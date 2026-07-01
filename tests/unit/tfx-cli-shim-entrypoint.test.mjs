import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SHIMS = [
  { name: "tfx-doctor", file: path.resolve("bin/tfx-doctor.mjs") },
  { name: "tfx-setup", file: path.resolve("bin/tfx-setup.mjs") },
];

async function run(cliPath, args) {
  const result = await execFileAsync(process.execPath, [cliPath, ...args], {
    timeout: 20_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  return result.stdout;
}

for (const { name, file } of SHIMS) {
  test(`${name} shim runs triflux.mjs main() directly (regression: argv[1] mismatch silent no-op)`, async () => {
    const stdout = await run(file, ["--help"]);

    assert.notEqual(
      stdout.length,
      0,
      `${name} produced no output — triflux.mjs's isMainModule() guard likely rejected process.argv[1]`,
    );
  });

  test(`${name} shim still runs triflux.mjs main() when invoked through a symlink`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-symlink-`));
    try {
      const symlinkPath = path.join(dir, name);
      await fs.symlink(file, symlinkPath);
      const stdout = await run(symlinkPath, ["--help"]);

      assert.notEqual(stdout.length, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}

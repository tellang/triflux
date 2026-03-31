import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { parseTeamArgs } from "../../hub/team/cli/commands/start/parse-args.mjs";
import { buildHeadlessCommand } from "../../hub/team/headless.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");

describe("headless cwd propagation parity", () => {
  it("parsed cwd가 headless command까지 유지되고 route mode의 explicit cwd 계약과 맞는다", () => {
    const inputCwd = process.platform === "win32"
      ? "/c/nested repo/worktree"
      : "/tmp/nested-repo/worktree";
    const expectedCwd = process.platform === "win32"
      ? resolve("C:/nested repo/worktree")
      : resolve(inputCwd);

    const parsed = parseTeamArgs(["--teammate-mode", "headless", "--cwd", inputCwd, "fix", "bug"]);
    const cmd = buildHeadlessCommand("codex", "test", "/tmp/r.txt", { handoff: false, cwd: parsed.cwd });
    const routeSource = readFileSync(join(ROOT, "scripts/tfx-route.sh"), "utf8");

    assert.equal(parsed.cwd, expectedCwd);
    assert.ok(cmd.startsWith(`Set-Location -LiteralPath '${expectedCwd}';`), `headless cwd preamble: ${cmd}`);
    assert.ok(cmd.includes(`--cwd '${expectedCwd}'`), `headless codex cwd flag: ${cmd}`);
    assert.ok(routeSource.includes('"--cwd" "$PWD"'), "route mode must keep explicit cwd forwarding");
  });
});

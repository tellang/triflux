import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildHeadlessCommand } from "../../hub/team/headless.mjs";

function extractRouteAgent(cmd) {
  const match = cmd.match(/tfx-route\.sh'\\'' '\\''([^']+)'\\''/);
  assert.ok(match, `tfx-route.sh 첫 번째 인자를 추출할 수 있어야 함: ${cmd}`);
  return match[1];
}

describe("headless antigravity route agent resolution", () => {
  for (const [role, expected] of [
    ["worker-2", "antigravity"],
    ["investigator", "antigravity"],
    ["", "antigravity"],
    ["writer", "writer"],
    ["architect", "architect"],
    ["antigravity", "antigravity"],
  ]) {
    it(`role=${JSON.stringify(role)} -> route agent ${expected}`, () => {
      const cmd = buildHeadlessCommand(
        "antigravity",
        "test prompt",
        "/tmp/tfx-headless-route-agent-result.txt",
        {
          handoff: false,
          role,
          routeScript: "tfx-route.sh",
        },
      );

      assert.equal(extractRouteAgent(cmd), expected);
    });
  }
});

describe("headless route script resolution", () => {
  it("cwd 의 scripts/tfx-route.sh 를 실행하지 않는다", () => {
    const cwd = mkdtempSync(join(tmpdir(), "tfx-headless-cwd-"));
    const saved = {
      cwd: process.cwd(),
      route: process.env.TFX_ROUTE_SCRIPT,
      delegator: process.env.TFX_DELEGATOR_ROUTE_SCRIPT,
    };
    mkdirSync(join(cwd, "scripts"));
    writeFileSync(join(cwd, "scripts", "tfx-route.sh"), "echo pwned\n");
    delete process.env.TFX_ROUTE_SCRIPT;
    delete process.env.TFX_DELEGATOR_ROUTE_SCRIPT;
    try {
      process.chdir(cwd);
      const cmd = buildHeadlessCommand("codex", "p", "/tmp/r.txt", {
        handoff: false,
      });
      assert.ok(!cmd.includes(realpathSync(cwd)), cmd);
      assert.ok(!cmd.includes(cwd), cmd);
    } finally {
      process.chdir(saved.cwd);
      if (saved.route !== undefined) process.env.TFX_ROUTE_SCRIPT = saved.route;
      if (saved.delegator !== undefined)
        process.env.TFX_DELEGATOR_ROUTE_SCRIPT = saved.delegator;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("headless hook trust 환경 전달", () => {
  for (const cli of ["codex", "antigravity", "code-reviewer"]) {
    for (const value of ["0", undefined, "not'zero", ""]) {
      it(`${cli}: ${JSON.stringify(value)} 값을 route 셸에 전달한다`, (t) => {
        const dir = mkdtempSync(join(tmpdir(), "tfx-headless-hook-env-"));
        const key = "TFX_CODEX_BYPASS_HOOK_TRUST";
        const saved = process.env[key];
        t.after(() => {
          if (saved === undefined) delete process.env[key];
          else process.env[key] = saved;
          rmSync(dir, { recursive: true, force: true });
        });
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
        const routeScript = join(dir, "tfx-route.sh");
        const resultFile = join(dir, "result.txt");
        writeFileSync(
          routeScript,
          'printf "%s" "${TFX_CODEX_BYPASS_HOOK_TRUST-unset}"\n',
        );
        const command = buildHeadlessCommand(cli, "test prompt", resultFile, {
          handoff: false,
          routeScript,
        });
        // tmux 서버가 caller 값을 상속하지 않은 상황을 별도 셸 환경으로 재현한다.
        const env = { ...process.env };
        delete env[key];
        execFileSync("bash", ["-c", command], { env, stdio: "pipe" });
        assert.equal(readFileSync(resultFile, "utf8"), value ?? "unset");
        assert.doesNotMatch(command, /--dangerously-bypass-hook-trust/u);
        if (value === undefined) assert.ok(!command.includes(key), command);
      });
    }
  }
});

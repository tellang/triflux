import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = fileURLToPath(new URL(".", import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const GUARD_PATH = join(PROJECT_ROOT, "hooks", "safety-guard.mjs");
const TEMP_REPOS = [];

afterEach(() => {
  while (TEMP_REPOS.length > 0) {
    rmSync(TEMP_REPOS.pop(), { recursive: true, force: true });
  }
});

function initRepo(branch = "main") {
  const repoDir = mkdtempSync(join(tmpdir(), "tfx-safety-guard-main-"));
  TEMP_REPOS.push(repoDir);

  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
  execFileSync("git", ["config", "user.name", "triflux test"], {
    cwd: repoDir,
  });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoDir,
  });

  writeFileSync(join(repoDir, "README.md"), "# test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

  if (branch !== "main") {
    execFileSync("git", ["checkout", "-b", branch], { cwd: repoDir });
  }

  return repoDir;
}

function runGuard({ command, cwd, env = process.env }) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  try {
    const stdout = execFileSync("node", [GUARD_PATH], {
      cwd,
      env,
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

describe("safety-guard main commit guard", () => {
  it("branch=main + CODEX_PRD_ACTIVE=1 + git commit → block", () => {
    const repoDir = initRepo("main");
    const result = runGuard({
      command: 'git commit -m "feat: test"',
      cwd: repoDir,
      env: { ...process.env, CODEX_PRD_ACTIVE: "1" },
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Codex PRD 실행 중 main 직접 commit 차단됨/);
  });

  it("branch=feat/x + CODEX_PRD_ACTIVE=1 + git commit → allow", () => {
    const repoDir = initRepo("feat/x");
    const result = runGuard({
      command: 'git commit -m "feat: test"',
      cwd: repoDir,
      env: { ...process.env, CODEX_PRD_ACTIVE: "1" },
    });

    assert.equal(result.status, 0);
  });

  it("branch=main + CODEX_PRD_ACTIVE undefined → allow", () => {
    const repoDir = initRepo("main");
    const env = { ...process.env };
    delete env.CODEX_PRD_ACTIVE;

    const result = runGuard({
      command: 'git commit -m "feat: test"',
      cwd: repoDir,
      env,
    });

    assert.equal(result.status, 0);
  });
});

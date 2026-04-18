import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TEST_DIR, "..", "..");
const GUARD_PATH = resolve(PROJECT_ROOT, "hooks", "safety-guard.mjs");
const TEMP_REPOS = [];

afterEach(() => {
  while (TEMP_REPOS.length > 0) {
    rmSync(TEMP_REPOS.pop(), { recursive: true, force: true });
  }
});

function createTempRepo(hosts) {
  const repoDir = mkdtempSync(join(tmpdir(), "tfx-safety-guard-psmux-"));
  TEMP_REPOS.push(repoDir);
  mkdirSync(join(repoDir, "references"), { recursive: true });
  writeFileSync(
    join(repoDir, "references", "hosts.json"),
    JSON.stringify({ hosts }, null, 2),
  );
  return repoDir;
}

function runGuard(command, cwd = tmpdir()) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  const { TFX_CLEANUP_BYPASS: _unused, ...envClean } = process.env;
  try {
    execFileSync("node", [GUARD_PATH], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: envClean,
    });
    return 0;
  } catch (e) {
    return e.status;
  }
}

describe("safety-guard psmux rules", () => {
  it("raw psmux kill-session 차단", () => {
    assert.equal(runGuard("psmux kill-session -t test"), 2);
  });

  it("chained raw psmux 차단", () => {
    assert.equal(runGuard("echo done && psmux kill-session -t foo"), 2);
  });

  it("git commit 메시지 안 텍스트는 통과", () => {
    assert.equal(runGuard('git commit -m "fix: psmux kill-session safety"'), 0);
  });

  it("echo 안 텍스트는 통과", () => {
    assert.equal(runGuard("echo psmux kill-session is dangerous"), 0);
  });

  it("grep 검색은 통과", () => {
    assert.equal(runGuard('grep -r "psmux kill-session" hooks/'), 0);
  });

  it("internal wrapper는 통과", () => {
    assert.equal(
      runGuard("node hub/team/psmux.mjs --internal kill-by-title tfx-spawn-"),
      0,
    );
  });

  it("psmux kill-server 차단", () => {
    assert.equal(runGuard("psmux kill-server"), 2);
  });

  it("for 루프 안의 psmux kill-session 차단", () => {
    assert.equal(
      runGuard('for s in a b c; do\n  psmux kill-session -t "$s"\ndone'),
      2,
    );
  });

  it("heredoc 본문 안의 텍스트는 통과", () => {
    assert.equal(
      runGuard("cat <<'EOF'\npsmux kill-session is dangerous\nEOF"),
      0,
    );
  });

  it("git commit heredoc 본문 안의 텍스트는 통과", () => {
    assert.equal(
      runGuard(
        "git commit -m \"$(cat <<'EOF'\nfix: psmux kill-session safety\nEOF\n)\"",
      ),
      0,
    );
  });

  it("double-quote heredoc 본문 안의 텍스트는 통과", () => {
    assert.equal(runGuard('cat <<"EOF"\npsmux kill-session foo\nEOF'), 0);
  });

  it("nested ssh.user windows host에도 bash payload 차단", () => {
    const repoDir = createTempRepo({
      winbox: {
        os: "windows",
        ssh: { user: "nested-user" },
        tailscale: { ip: "100.64.0.9" },
      },
    });

    assert.equal(
      runGuard(
        'ssh nested-user@100.64.0.9 "git status 2>/dev/null && echo done"',
        repoDir,
      ),
      2,
    );
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

function runGuard(command) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  try {
    execFileSync("node", ["hooks/safety-guard.mjs"], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
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

  it("safe wrapper는 통과", () => {
    assert.equal(runGuard("node hub/team/psmux.mjs kill --session foo"), 0);
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
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function runGuard(command) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });

  try {
    const stdout = execFileSync("node", ["hooks/safety-guard.mjs"], {
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

describe("safety-guard wt rules", () => {
  it("wt.exe 직접 호출 차단", () => {
    const result = runGuard("wt.exe new-tab -p triflux");

    assert.equal(result.status, 2);
    assert.match(result.stderr, /wt\.exe 직접 호출 차단됨/);
    assert.match(result.stderr, /wt-manager\.mjs/);
  });

  it("wt -w split-pane 직접 호출 차단", () => {
    const result = runGuard("wt -w 0 split-pane -H -p triflux");

    assert.equal(result.status, 2);
  });

  it("Start-Process wt 차단", () => {
    const result = runGuard("Start-Process wt -ArgumentList '-w', '0', 'new-tab'");

    assert.equal(result.status, 2);
    assert.match(result.stderr, /wt\.exe 직접 호출 차단됨/);
  });

  it("echo 안의 wt 문자열은 허용", () => {
    assert.equal(runGuard('echo "wt -w 0 split-pane"').status, 0);
  });

  it("grep 안의 wt 문자열은 허용", () => {
    assert.equal(runGuard('grep -r "wt.exe" hooks/').status, 0);
  });

  it("git commit 메시지 안의 wt 문자열은 허용", () => {
    assert.equal(runGuard('git commit -m "docs: mention wt.exe new-tab rule"').status, 0);
  });

  it("heredoc 본문 안의 wt 문자열은 허용", () => {
    assert.equal(runGuard("cat <<'EOF'\nwt.exe new-tab is blocked\nEOF").status, 0);
  });
});

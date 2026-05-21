import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

function runGuard(command, opts = {}) {
  const input = JSON.stringify({ tool_name: "Bash", tool_input: { command } });
  const env = { ...process.env };
  if (opts.platform) {
    env.SAFETY_GUARD_FORCE_PLATFORM = opts.platform;
  }

  try {
    const stdout = execFileSync("node", ["hooks/safety-guard.mjs"], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env,
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
  // win32 환경 시뮬레이션 — 차단 동작 검증
  it("wt.exe 직접 호출 차단 (win32)", () => {
    const result = runGuard("wt.exe new-tab -p triflux", { platform: "win32" });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /wt\.exe 직접 호출 차단됨/);
    assert.match(result.stderr, /wt-manager\.mjs/);
  });

  it("wt -w split-pane 직접 호출 차단 (win32)", () => {
    const result = runGuard("wt -w 0 split-pane -H -p triflux", {
      platform: "win32",
    });

    assert.equal(result.status, 2);
  });

  it("Start-Process wt 차단 (win32)", () => {
    const result = runGuard(
      "Start-Process wt -ArgumentList '-w', '0', 'new-tab'",
      { platform: "win32" },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /wt\.exe 직접 호출 차단됨/);
  });

  // non-Windows (mac/linux) — 같은 명령이라도 false positive 방지를 위해 통과
  it("wt.exe in darwin은 차단되지 않음 (false positive 방지)", () => {
    const result = runGuard("wt.exe new-tab -p triflux", {
      platform: "darwin",
    });

    assert.equal(result.status, 0);
  });

  it("wt -w split-pane in linux는 차단되지 않음", () => {
    const result = runGuard("wt -w 0 split-pane -H -p triflux", {
      platform: "linux",
    });

    assert.equal(result.status, 0);
  });

  // platform과 무관하게 항상 통과 (heredoc/echo/grep/commit msg 안의 텍스트)
  it("echo 안의 wt 문자열은 허용", () => {
    assert.equal(runGuard('echo "wt -w 0 split-pane"').status, 0);
  });

  it("grep 안의 wt 문자열은 허용", () => {
    assert.equal(runGuard('grep -r "wt.exe" hooks/').status, 0);
  });

  it("git commit 메시지 안의 wt 문자열은 허용", () => {
    assert.equal(
      runGuard('git commit -m "docs: mention wt.exe new-tab rule"').status,
      0,
    );
  });

  it("heredoc 본문 안의 wt 문자열은 허용", () => {
    assert.equal(
      runGuard("cat <<'EOF'\nwt.exe new-tab is blocked\nEOF").status,
      0,
    );
  });
});

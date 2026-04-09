// tests/contract/codex-behavior.test.mjs
//
// Contract tests for Codex CLI behavior assumptions.
// These hit the REAL Codex API — cost ~$0.10-0.40 per run.
//
// Run:  TRIFLUX_CONTRACT_TESTS=1 npm run test:contract
// Skip: omit the env var (default — zero cost)

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

const ENABLED = process.env.TRIFLUX_CONTRACT_TESTS === "1";

// ── Helpers ─────────────────────────────────────────────────────

function execCodex(command, opts = {}) {
  const timeout = opts.timeout ?? 60_000;
  const cwd = opts.cwd ?? process.cwd();
  const env = { ...process.env, ...(opts.env || {}) };

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    const start = Date.now();

    const child = spawn(command, { cwd, env, shell: true, windowsHide: true });

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    const killTimer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5000);
    }, timeout);
    killTimer.unref?.();

    child.on("error", (err) => {
      stderr += String(err?.message || err);
    });

    child.on("close", (code) => {
      clearTimeout(killTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        duration: Date.now() - start,
        killed,
      });
    });
  });
}

function makeTempHome(configToml) {
  const dir = mkdtempSync(join(tmpdir(), "triflux-contract-"));
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex", "config.toml"), configToml, "utf8");
  return dir;
}

// ── Contract Tests ──────────────────────────────────────────────

describe("Codex CLI behavior contracts", {
  skip: !ENABLED && "Set TRIFLUX_CONTRACT_TESTS=1",
}, () => {
  // C1: codex exec이 프롬프트를 실행하고 stdout에 결과를 출력한다
  // Known behavior: codex may produce output but not exit cleanly (F3).
  // Our adapter's stall detection handles this — the contract is about OUTPUT, not exit.
  test("C1: codex exec produces stdout output", {
    timeout: 90_000,
  }, async (t) => {
    const prompt = "Output exactly the text CONTRACT_C1_OK and nothing else";
    const cmd = `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${JSON.stringify(prompt)}`;
    const result = await execCodex(cmd, { timeout: 60_000 });

    t.diagnostic(
      `exit=${result.exitCode} duration=${result.duration}ms killed=${result.killed}`,
    );
    if (result.stdout)
      t.diagnostic(`stdout[0:200]: ${result.stdout.slice(0, 200)}`);

    // Core contract: codex must produce output for a valid prompt
    assert.ok(result.stdout.length > 0, "stdout must not be empty");

    if (result.killed) {
      t.diagnostic(
        "KNOWN F3: codex produced output but did not exit — adapter stall detection required",
      );
    } else {
      assert.equal(
        result.exitCode,
        0,
        `codex must exit 0: ${result.stderr.slice(0, 300)}`,
      );
      t.diagnostic("codex exited cleanly");
    }
  });

  // C2: codex exec이 config.toml approval_mode를 존중하는지 (bypass 없이)
  // Behavioral probe — stall이면 현재 동작 확인, 정상이면 동작 변경 감지
  test("C2: codex exec approval_mode behavior probe", {
    timeout: 45_000,
  }, async (t) => {
    const tmpHome = makeTempHome(
      ['approval_mode = "full-auto"', 'sandbox = "danger-full-access"'].join(
        "\n",
      ),
    );

    try {
      const prompt = "Output exactly CONTRACT_C2_OK";
      const cmd = `codex exec --skip-git-repo-check ${JSON.stringify(prompt)}`;
      const result = await execCodex(cmd, {
        timeout: 30_000,
        env: { HOME: tmpHome, USERPROFILE: tmpHome },
      });

      t.diagnostic(
        `exit=${result.exitCode} duration=${result.duration}ms killed=${result.killed}`,
      );

      if (result.killed) {
        t.diagnostic(
          "CONFIRMED: codex exec ignores config.toml approval_mode — bypass flag required",
        );
      } else if (result.exitCode === 0) {
        t.diagnostic(
          "BEHAVIOR CHANGE: codex exec now respects config.toml — consider removing bypass",
        );
      } else {
        t.diagnostic(
          `REJECTED: exit ${result.exitCode} — ${result.stderr.slice(0, 200)}`,
        );
      }
      // Always passes — documents assumption, alerts on change
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // C3: MCP 서버 실패 시 codex 동작 검증
  // Known failure mode F2: codex hangs on broken MCP server.
  // Behavioral probe — documents F2, our adapter preflight excludes broken servers.
  test("C3: codex behavior with broken MCP server", {
    timeout: 60_000,
  }, async (t) => {
    const tmpHome = makeTempHome(
      [
        'approval_mode = "full-auto"',
        'sandbox = "danger-full-access"',
        "",
        "[mcp_servers.broken_contract_test]",
        'command = "nonexistent-binary-contract-c3"',
        'args = ["--test"]',
      ].join("\n"),
    );

    try {
      const prompt = "Output exactly CONTRACT_C3_OK";
      const cmd = `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${JSON.stringify(prompt)}`;
      const result = await execCodex(cmd, {
        timeout: 45_000,
        env: { HOME: tmpHome, USERPROFILE: tmpHome },
      });

      t.diagnostic(
        `exit=${result.exitCode} duration=${result.duration}ms killed=${result.killed}`,
      );

      if (result.killed) {
        t.diagnostic(
          "CONFIRMED F2: codex hangs on broken MCP — adapter preflight must exclude broken servers",
        );
      } else {
        t.diagnostic(
          `codex handled broken MCP gracefully: exit=${result.exitCode}`,
        );
        assert.notEqual(
          result.exitCode,
          null,
          "codex must terminate with an exit code",
        );
      }
      // Behavioral probe — always passes. Documents failure mode F2.
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  // C4: timeout 내에 완료되거나 실패한다 — kill 메커니즘 검증
  // Windows SIGTERM→SIGKILL 체인은 5s grace + OS overhead로 ~15s 추가 소요.
  test("C4: timeout enforcement within margin", {
    timeout: 45_000,
  }, async (t) => {
    const TIMEOUT_MS = 10_000;
    const MAX_TOTAL_MS = 30_000; // timeout + SIGTERM grace + OS cleanup

    const prompt =
      "Write a comprehensive 10000-word analysis covering every programming language ever created with detailed syntax examples and performance benchmarks for each one";
    const cmd = `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check ${JSON.stringify(prompt)}`;
    const result = await execCodex(cmd, { timeout: TIMEOUT_MS });

    t.diagnostic(
      `exit=${result.exitCode} duration=${result.duration}ms killed=${result.killed}`,
    );

    assert.ok(
      result.duration < MAX_TOTAL_MS,
      `must terminate within ${MAX_TOTAL_MS}ms, took ${result.duration}ms`,
    );
    assert.equal(
      result.killed,
      true,
      "kill mechanism must fire for long-running prompt",
    );
    t.diagnostic("timeout mechanism terminated process within bound");
  });
});

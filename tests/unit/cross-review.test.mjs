import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const TRACKER_PATH = join(process.cwd(), "scripts", "cross-review-tracker.mjs");
const GATE_PATH = join(process.cwd(), "scripts", "cross-review-gate.mjs");
const TEMP_DIRS = [];

function makeTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "triflux-cross-review-"));
  TEMP_DIRS.push(dir);
  return dir;
}

function runScript(scriptPath, payload, options = {}) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: options.cwd || process.cwd(),
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 5000,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readState(projectDir) {
  const statePath = join(projectDir, ".omc", "state", "cross-review.json");
  const text = readFileSync(statePath, "utf8");
  return JSON.parse(text);
}

function writeState(projectDir, state) {
  const statePath = join(projectDir, ".omc", "state", "cross-review.json");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

afterEach(() => {
  while (TEMP_DIRS.length > 0) {
    const dir = TEMP_DIRS.pop();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("cross-review tracker", () => {
  it("Edit/Write 파일을 author=claude, reviewed=false로 기록한다", () => {
    const projectDir = makeTempProject();
    const result = runScript(TRACKER_PATH, {
      tool_name: "Edit",
      tool_input: {
        file_path: "src/foo.mjs",
      },
    }, { cwd: projectDir });

    assert.equal(result.status, 0, result.stderr);

    const state = readState(projectDir);
    assert.equal(typeof state.session_start, "number");
    assert.equal(state.files["src/foo.mjs"].author, "claude");
    assert.equal(state.files["src/foo.mjs"].reviewed, false);
  });

  it("비소스 파일은 추적하지 않는다", () => {
    const projectDir = makeTempProject();
    const excludedPaths = [
      "README.md",
      ".omc/state/cross-review.json",
      ".claude/settings.json",
      "package-lock.json",
      "config/default.yaml",
    ];

    for (const filePath of excludedPaths) {
      const result = runScript(TRACKER_PATH, {
        tool_name: "Write",
        tool_input: { file_path: filePath },
      }, { cwd: projectDir });
      assert.equal(result.status, 0, result.stderr);
    }

    const statePath = join(projectDir, ".omc", "state", "cross-review.json");
    assert.equal(existsSync(statePath), false);
  });

  it("Bash 결과의 cli: codex를 감지하면 claude 작성 파일을 reviewed=true로 전환한다", () => {
    const projectDir = makeTempProject();
    runScript(TRACKER_PATH, {
      tool_name: "Edit",
      tool_input: { file_path: "src/feature.mjs" },
    }, { cwd: projectDir });

    const reviewResult = runScript(TRACKER_PATH, {
      tool_name: "Bash",
      tool_input: { command: "echo review" },
      tool_response: { stdout: "=== TFX-ROUTE RESULT ===\ncli: codex\nstatus: success" },
    }, { cwd: projectDir });

    assert.equal(reviewResult.status, 0, reviewResult.stderr);

    const state = readState(projectDir);
    assert.equal(state.files["src/feature.mjs"].reviewed, true);
    assert.equal(state.files["src/feature.mjs"].reviewer, "codex");
  });

  it("Bash 이벤트에 파일 경로가 있으면 cli actor를 author로 기록한다", () => {
    const projectDir = makeTempProject();

    const result = runScript(TRACKER_PATH, {
      tool_name: "Bash",
      tool_input: { command: "bash scripts/tfx-route.sh", file_path: "src/from-codex.mjs" },
      tool_response: { stdout: "=== TFX-ROUTE RESULT ===\ncli: codex\nstatus: success" },
    }, { cwd: projectDir });

    assert.equal(result.status, 0, result.stderr);
    const state = readState(projectDir);
    assert.equal(state.files["src/from-codex.mjs"].author, "codex");
    assert.equal(state.files["src/from-codex.mjs"].reviewed, false);
  });
});

describe("cross-review gate", () => {
  it("git commit 전에 미검증 파일이 있으면 nudge를 반환한다", () => {
    const projectDir = makeTempProject();
    writeState(projectDir, {
      session_start: Math.floor(Date.now() / 1000),
      files: {
        "src/foo.mjs": { author: "claude", ts: 1711843200, reviewed: false },
      },
    });

    const result = runScript(GATE_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m test" },
    }, { cwd: projectDir });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout.trim());
    assert.equal(output?.hookSpecificOutput?.hookEventName, "PreToolUse");
    assert.match(output?.hookSpecificOutput?.additionalContext || "", /src\/foo\.mjs/u);
    assert.match(output?.hookSpecificOutput?.additionalContext || "", /reviewer=codex/u);
  });

  it("self-approve 상태면 commit을 deny(exit 2)한다", () => {
    const projectDir = makeTempProject();
    writeState(projectDir, {
      session_start: Math.floor(Date.now() / 1000),
      files: {
        "src/foo.mjs": { author: "claude", ts: 1711843200, reviewed: true, reviewer: "claude" },
      },
    });

    const result = runScript(GATE_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m test" },
    }, { cwd: projectDir });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /self-approve/u);
  });

  it("세션이 30분 넘게 지난 상태 파일은 만료되어 commit을 통과시킨다", () => {
    const projectDir = makeTempProject();
    writeState(projectDir, {
      session_start: Math.floor(Date.now() / 1000) - (31 * 60),
      files: {
        "src/foo.mjs": { author: "claude", ts: 1711843200, reviewed: false },
      },
    });

    const statePath = join(projectDir, ".omc", "state", "cross-review.json");
    const result = runScript(GATE_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m test" },
    }, { cwd: projectDir });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
    assert.equal(existsSync(statePath), false);
  });

  it("TFX_SKIP_CROSS_REVIEW=1이면 게이트를 우회한다", () => {
    const projectDir = makeTempProject();
    writeState(projectDir, {
      session_start: Math.floor(Date.now() / 1000),
      files: {
        "src/foo.mjs": { author: "claude", ts: 1711843200, reviewed: false },
      },
    });

    const result = runScript(GATE_PATH, {
      tool_name: "Bash",
      tool_input: { command: "git commit -m test" },
    }, {
      cwd: projectDir,
      env: { TFX_SKIP_CROSS_REVIEW: "1" },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
  });
});

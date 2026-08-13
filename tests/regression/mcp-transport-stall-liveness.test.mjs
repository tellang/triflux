import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { CodexMcpWorker } from "../../hub/workers/codex-mcp.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ROUTE_SCRIPT = path.join(REPO_ROOT, "scripts", "tfx-route.sh");

function extractFunction(name) {
  const source = readFileSync(ROUTE_SCRIPT, "utf8");
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name} 정의를 찾을 수 없음`);
  const end = source.indexOf("\n}\n\n", start);
  assert.ok(end >= 0, `${name} 함수 끝을 찾을 수 없음`);
  return source.slice(start, end + 2);
}

describe("MCP transport stall liveness", () => {
  const cleanupDirs = [];
  after(() => {
    cleanupDirs.forEach((dir) => {
      rmSync(dir, { recursive: true, force: true });
    });
  });

  it("MCP progress notification은 per-run activity sidecar에만 기록한다", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-mcp-progress-"));
    cleanupDirs.push(dir);
    const activityFile = path.join(dir, "activity.log");
    const worker = new CodexMcpWorker({ activityFile });
    worker.start = async () => {
      worker.ready = true;
      worker.client = {
        callTool: async (_request, _schema, options) => {
          options.onprogress({ progress: 1, total: 2 });
          return {
            content: [{ type: "text", text: "done" }],
            structuredContent: { threadId: "thread-progress", content: "done" },
            isError: false,
          };
        },
      };
    };

    const result = await worker.execute("long MCP task");
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(activityFile, "utf8"), "progress\n");
  });

  function runHeartbeat({ writesProgress }) {
    const dir = mkdtempSync(path.join(tmpdir(), "tfx-mcp-heartbeat-"));
    cleanupDirs.push(dir);
    const stdoutLog = path.join(dir, "stdout.log");
    const stderrLog = path.join(dir, "stderr.log");
    const activityFile = path.join(dir, "activity.log");
    const scriptFile = path.join(dir, "run.sh");
    writeFileSync(stdoutLog, "");
    writeFileSync(stderrLog, "");
    writeFileSync(activityFile, "");

    const writer = writesProgress
      ? [
          "(",
          "  for _tick in 1 2 3 4 5 6 7 8 9 10; do",
          '    printf "progress\\n" >> "$TFX_CODEX_MCP_ACTIVITY_FILE"',
          "    sleep 0.4",
          "  done",
          ") &",
          "WRITER_PID=$!",
        ]
      : [];
    const workerCommand = writesProgress ? "sleep 5" : "sleep 30";
    const source = [
      "#!/usr/bin/env bash",
      "set -u",
      "export TFX_HEARTBEAT=1",
      "export TFX_HEARTBEAT_INTERVAL=1",
      "export TFX_STALL_THRESHOLD=2",
      "export TFX_STALL_KILL=kill",
      "export TFX_STALL_KILL_GRACE=1",
      "export CLI_TYPE=codex",
      `export TFX_CODEX_MCP_ACTIVITY_FILE='${activityFile}'`,
      `STDOUT_LOG='${stdoutLog}'`,
      `STDERR_LOG='${stderrLog}'`,
      "TIMESTAMP=$(date +%s)",
      "read_probe_state() { return 1; }",
      extractFunction("_find_fork_pids"),
      extractFunction("_codex_rollout_activity_bytes"),
      extractFunction("heartbeat_monitor"),
      ...writer,
      `${workerCommand} &`,
      "CHILD_PID=$!",
      'heartbeat_monitor "$CHILD_PID" 1 2 &',
      "HB_PID=$!",
      "for _second in 1 2 3 4 5 6 7 8; do",
      "  sleep 1",
      '  if ! kill -0 "$CHILD_PID" 2>/dev/null; then break; fi',
      "done",
      'if kill -0 "$CHILD_PID" 2>/dev/null; then',
      '  kill "$CHILD_PID" 2>/dev/null || true',
      '  wait "$CHILD_PID" 2>/dev/null || true',
      '  echo "RESULT=child_still_alive" >&2',
      "else",
      '  echo "RESULT=child_terminated" >&2',
      "fi",
      'kill "$HB_PID" 2>/dev/null || true',
      'wait "$HB_PID" 2>/dev/null || true',
      '[[ -n "${WRITER_PID:-}" ]] && { kill "$WRITER_PID" 2>/dev/null || true; wait "$WRITER_PID" 2>/dev/null || true; }',
      "true",
    ].join("\n");
    writeFileSync(scriptFile, source);
    return spawnSync("bash", [scriptFile], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: 20_000,
    });
  }

  it("MCP progress가 계속 오면 stdout=0B여도 stall kill 하지 않는다", () => {
    const result = runHeartbeat({ writesProgress: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /status=active/);
    assert.match(result.stderr, /RESULT=child_terminated/);
    assert.doesNotMatch(result.stderr, /status=STALL_KILL/);
  });

  it("MCP activity sidecar도 조용하면 기존 stall kill이 계속 작동한다", () => {
    const result = runHeartbeat({ writesProgress: false });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /status=STALL_KILL/);
    assert.match(result.stderr, /RESULT=child_terminated/);
  });
});

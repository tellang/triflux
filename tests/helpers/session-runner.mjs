/**
 * Claude CLI subprocess runner for skill E2E testing.
 *
 * Spawns `claude -p` as a completely independent process (not via Agent SDK),
 * so it works inside Claude Code sessions. Pipes prompt via stdin, streams
 * NDJSON output for real-time progress, scans for tfx errors.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TFX_EVAL_DIR = path.join(os.homedir(), ".claude", "cache", "tfx-eval");
const HEARTBEAT_PATH = path.join(TFX_EVAL_DIR, "e2e-live.json");
const PROJECT_DIR = TFX_EVAL_DIR;

/**
 * 테스트 이름을 파일 이름으로 사용할 수 있도록 정제합니다.
 * 앞부분의 슬래시를 제거하고 중간의 슬래시를 하이픈(-)으로 교체합니다.
 *
 * @param {string} name - 정제할 테스트 이름
 * @returns {string} 정제된 이름
 */
export function sanitizeTestName(name) {
  return name.replace(/^\/+/, "").replace(/\//g, "-");
}

/** Atomic write: write to .tmp then rename. Non-fatal on error. */
function atomicWriteSync(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

// --- Testable NDJSON parser ---

/**
 * NDJSON 라인 배열을 구조화된 트랜스크립트 데이터로 파싱합니다.
 * I/O가 없는 순수 함수로, 스트리밍 리더와 유닛 테스트에서 공통으로 사용됩니다.
 *
 * @param {string[]} lines - 파싱할 NDJSON 라인 배열
 * @returns {{ transcript: any[], resultLine: any|null, turnCount: number, toolCallCount: number, toolCalls: Array<{tool: string, input: any, output: string}> }} 파싱된 결과 데이터
 */
export function parseNDJSON(lines) {
  const transcript = [];
  let resultLine = null;
  let turnCount = 0;
  let toolCallCount = 0;
  const toolCalls = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      transcript.push(event);

      // Track turns and tool calls from assistant events
      if (event.type === "assistant") {
        turnCount++;
        const content = event.message?.content || [];
        for (const item of content) {
          if (item.type === "tool_use") {
            toolCallCount++;
            toolCalls.push({
              tool: item.name || "unknown",
              input: item.input || {},
              output: "",
            });
          }
        }
      }

      if (event.type === "result") resultLine = event;
    } catch {
      /* skip malformed lines */
    }
  }

  return { transcript, resultLine, turnCount, toolCallCount, toolCalls };
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const TFX_ERROR_PATTERNS = [
  /Hub.*failed/i,
  /tfx-route.*not found/i,
  /worker.*timeout/i,
];

// --- Main runner ---

/**
 * Claude CLI 하위 프로세스를 실행하여 스킬 E2E 테스트를 수행합니다.
 * `claude -p`를 독립된 프로세스로 실행하고 stdin으로 프롬프트를 전달하며,
 * NDJSON 출력을 실시간으로 파싱하여 진행 상황을 추적하고 tfx 오류를 검사합니다.
 *
 * @param {object} options - 실행 옵션
 * @param {string} options.prompt - 실행할 프롬프트
 * @param {string} options.workingDirectory - 작업 디렉토리
 * @param {number} [options.maxTurns=15] - 최대 턴 수
 * @param {string[]} [options.allowedTools=['Bash', 'Read', 'Write']] - 허용된 도구 목록
 * @param {number} [options.timeout=120000] - 최대 실행 시간 (ms)
 * @param {string} [options.testName] - 테스트 이름 (로그 및 파일 생성용)
 * @param {string} [options.runId] - 실행 ID (결과 디렉토리 구분용)
 * @param {string} [options.model] - 사용할 모델 이름
 * @returns {Promise<{
 *   toolCalls: Array<{tool: string, input: any, output: string}>,
 *   tfxErrors: string[],
 *   exitReason: string,
 *   duration: number,
 *   output: string,
 *   costEstimate: {inputChars: number, outputChars: number, estimatedTokens: number, estimatedCost: number, turnsUsed: number},
 *   transcript: any[],
 *   model: string,
 *   firstResponseMs: number,
 *   maxInterTurnMs: number,
 * }>} 테스트 실행 결과 데이터
 */
export async function runSkillTest(options) {
  const {
    prompt,
    workingDirectory,
    maxTurns = 15,
    allowedTools = ["Bash", "Read", "Write"],
    timeout = 120_000,
    testName,
    runId,
  } = options;
  const model = options.model ?? process.env.EVALS_MODEL ?? "claude-sonnet-4-6";

  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // Set up per-run log directory if runId is provided
  let runDir = null;
  const safeName = testName ? sanitizeTestName(testName) : null;
  if (runId) {
    try {
      runDir = path.join(PROJECT_DIR, "e2e-runs", runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch {
      /* non-fatal */
    }
  }

  // Spawn claude -p with streaming NDJSON output. Prompt piped via stdin to
  // avoid shell escaping issues. --verbose is required for stream-json mode.
  const args = [
    "-p",
    "--model",
    model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--max-turns",
    String(maxTurns),
    "--allowed-tools",
    ...allowedTools,
  ];

  // Write prompt to a temp file OUTSIDE workingDirectory to avoid race conditions
  // where afterAll cleanup deletes the dir before cat reads the file (especially
  // with --concurrent --retry). Using os.tmpdir() + unique suffix keeps it stable.
  const promptFile = path.join(
    os.tmpdir(),
    `.prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(promptFile, prompt);

  const shellCmd = `cat "${promptFile}" | claude ${args.map((a) => `"${a}"`).join(" ")}`;
  const proc = spawn("sh", ["-c", shellCmd], {
    cwd: workingDirectory,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Race against timeout
  const stderrChunks = [];
  let exitReason = "unknown";
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  // Collect stderr
  proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  const stderrPromise = new Promise((resolve) => {
    proc.stderr.on("end", () =>
      resolve(Buffer.concat(stderrChunks).toString("utf8")),
    );
    proc.stderr.on("error", () =>
      resolve(Buffer.concat(stderrChunks).toString("utf8")),
    );
  });

  // Stream NDJSON from stdout for real-time progress
  const collectedLines = [];
  let liveTurnCount = 0;
  let liveToolCount = 0;
  let firstResponseMs = 0;
  let lastToolTime = 0;
  let maxInterTurnMs = 0;

  const stdoutDone = new Promise((resolve, reject) => {
    let buf = "";
    const decoder = new TextDecoder();

    proc.stdout.on("data", (chunk) => {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        // Real-time progress to stderr + persistent logs
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant") {
            liveTurnCount++;
            const content = event.message?.content || [];
            for (const item of content) {
              if (item.type === "tool_use") {
                liveToolCount++;
                const now = Date.now();
                const elapsed = Math.round((now - startTime) / 1000);
                // Track timing telemetry
                if (firstResponseMs === 0) firstResponseMs = now - startTime;
                if (lastToolTime > 0) {
                  const interTurn = now - lastToolTime;
                  if (interTurn > maxInterTurnMs) maxInterTurnMs = interTurn;
                }
                lastToolTime = now;
                const progressLine = `  [${elapsed}s] turn ${liveTurnCount} tool #${liveToolCount}: ${item.name}(${truncate(JSON.stringify(item.input || {}), 80)})\n`;
                process.stderr.write(progressLine);

                // Persist progress.log
                if (runDir) {
                  try {
                    fs.appendFileSync(
                      path.join(runDir, "progress.log"),
                      progressLine,
                    );
                  } catch {
                    /* non-fatal */
                  }
                }

                // Write heartbeat (atomic)
                if (runId && testName) {
                  try {
                    const toolDesc = `${item.name}(${truncate(JSON.stringify(item.input || {}), 60)})`;
                    atomicWriteSync(
                      HEARTBEAT_PATH,
                      JSON.stringify(
                        {
                          runId,
                          pid: proc.pid,
                          startedAt,
                          currentTest: testName,
                          status: "running",
                          turn: liveTurnCount,
                          toolCount: liveToolCount,
                          lastTool: toolDesc,
                          lastToolAt: new Date().toISOString(),
                          elapsedSec: elapsed,
                        },
                        null,
                        2,
                      ) + "\n",
                    );
                  } catch {
                    /* non-fatal */
                  }
                }
              }
            }
          }
        } catch {
          /* skip — parseNDJSON will handle it later */
        }

        // Append raw NDJSON line to per-test transcript file
        if (runDir && safeName) {
          try {
            fs.appendFileSync(
              path.join(runDir, `${safeName}.ndjson`),
              line + "\n",
            );
          } catch {
            /* non-fatal */
          }
        }
      }
    });

    proc.stdout.on("end", () => {
      // Flush remaining buffer
      if (buf.trim()) collectedLines.push(buf);
      resolve();
    });

    proc.stdout.on("error", reject);
  });

  // Wait for exit
  const exitCodePromise = new Promise((resolve) => {
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });

  try {
    await stdoutDone;
  } catch {
    /* stream read error — fall through to exit code handling */
  }

  const stderr = await stderrPromise;
  const exitCode = await exitCodePromise;
  clearTimeout(timeoutId);

  try {
    fs.unlinkSync(promptFile);
  } catch {
    /* non-fatal */
  }

  if (timedOut) {
    exitReason = "timeout";
  } else if (exitCode === 0) {
    exitReason = "success";
  } else {
    exitReason = `exit_code_${exitCode}`;
  }

  const duration = Date.now() - startTime;

  // Parse all collected NDJSON lines
  const parsed = parseNDJSON(collectedLines);
  const { transcript, resultLine, toolCalls } = parsed;
  const tfxErrors = [];

  // Scan transcript + stderr for tfx errors
  const allText =
    transcript.map((e) => JSON.stringify(e)).join("\n") + "\n" + stderr;
  for (const pattern of TFX_ERROR_PATTERNS) {
    const match = allText.match(pattern);
    if (match) {
      tfxErrors.push(match[0].slice(0, 200));
    }
  }

  // Use resultLine for structured result data
  if (resultLine) {
    if (resultLine.is_error) {
      // claude -p can return subtype=success with is_error=true (e.g. API connection failure)
      exitReason = "error_api";
    } else if (resultLine.subtype === "success") {
      exitReason = "success";
    } else if (resultLine.subtype) {
      exitReason = resultLine.subtype;
    }
  }

  // Save failure transcript to persistent run directory (or fallback to workingDirectory)
  if (tfxErrors.length > 0 || exitReason !== "success") {
    try {
      const failureDir =
        runDir ||
        path.join(
          workingDirectory,
          ".claude",
          "cache",
          "tfx-eval",
          "test-transcripts",
        );
      fs.mkdirSync(failureDir, { recursive: true });
      const failureName = safeName
        ? `${safeName}-failure.json`
        : `e2e-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      fs.writeFileSync(
        path.join(failureDir, failureName),
        JSON.stringify(
          {
            prompt: prompt.slice(0, 500),
            testName: testName || "unknown",
            exitReason,
            tfxErrors,
            duration,
            turnAtTimeout: timedOut ? liveTurnCount : undefined,
            lastToolCall:
              liveToolCount > 0 ? `tool #${liveToolCount}` : undefined,
            stderr: stderr.slice(0, 2000),
            result: resultLine
              ? {
                  type: resultLine.type,
                  subtype: resultLine.subtype,
                  result: resultLine.result?.slice?.(0, 500),
                }
              : null,
          },
          null,
          2,
        ),
      );
    } catch {
      /* non-fatal */
    }
  }

  // Cost from result line (exact) or estimate from chars
  const turnsUsed = resultLine?.num_turns || 0;
  const estimatedCost = resultLine?.total_cost_usd || 0;
  const inputChars = prompt.length;
  const outputChars = (resultLine?.result || "").length;
  const estimatedTokens =
    (resultLine?.usage?.input_tokens || 0) +
    (resultLine?.usage?.output_tokens || 0) +
    (resultLine?.usage?.cache_read_input_tokens || 0);

  const costEstimate = {
    inputChars,
    outputChars,
    estimatedTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    turnsUsed,
  };

  return {
    toolCalls,
    tfxErrors,
    exitReason,
    duration,
    output: resultLine?.result || "",
    costEstimate,
    transcript,
    model,
    firstResponseMs,
    maxInterTurnMs,
  };
}

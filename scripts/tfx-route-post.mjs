#!/usr/bin/env node
// tfx-route-post.mjs v2.0 — tfx-route.sh 후처리 (단일 프로세스)
//
// cli-route.sh v1.x의 5개 런타임(jq, python3, node)을 node 단일로 통합.
// ~100ms (node 1회 기동) vs ~1000ms (python3×2 + jq×3 + node×2)
//
// 처리:
//   1. 토큰 추출 (Codex stderr / Gemini session JSON)
//   2. Codex JSON-line 출력 필터링
//   3. 실행 로그 기록 (JSONL)
//   4. 토큰 누적 (sv-accumulator.json)
//   5. AIMD 배치 이벤트 기록 (append-only JSONL — 락 불필요)
//   6. CLI 이슈 자동 수집
//   7. 구조화된 결과 출력 (=== TFX-ROUTE RESULT ===)

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const HOME = homedir();
const CACHE_DIR = join(HOME, ".claude", "cache");
const LOG_DIR = join(HOME, ".claude", "logs");

// ── 인자 파싱 ──
function parseArgs() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith("--")) {
      const key = process.argv[i].slice(2).replace(/-/g, "_");
      args[key] = process.argv[i + 1] || "";
      i++;
    }
  }
  return args;
}

// ── 토큰 추출 ──
function extractTokens(cliType, stderrFile) {
  if (cliType === "codex") {
    // Codex CLI: stderr에 "tokens used\n76,239" 형식
    try {
      const stderr = readFileSync(stderrFile, "utf-8");
      const match = stderr.match(/tokens used\s*\n\s*([\d,]+)/i);
      if (match) {
        const total = parseInt(match[1].replace(/,/g, ""));
        if (total > 0) return { input: total, output: 0 };
      }
    } catch {}
    return { input: 0, output: 0 };
  }

  if (cliType === "gemini") {
    // Gemini CLI: ~/.gemini/tmp/*/chats/session-*.json에서 최신 세션
    const geminiTmp = join(HOME, ".gemini", "tmp");
    if (!existsSync(geminiTmp)) return { input: 0, output: 0 };

    let latestFile = null;
    let latestMtime = 0;

    try {
      for (const dir of readdirSync(geminiTmp)) {
        const chatsDir = join(geminiTmp, dir, "chats");
        if (!existsSync(chatsDir)) continue;
        for (const f of readdirSync(chatsDir)) {
          if (!f.startsWith("session-") || !f.endsWith(".json")) continue;
          const fp = join(chatsDir, f);
          try {
            const mtime = statSync(fp).mtimeMs;
            if (mtime > latestMtime) {
              latestMtime = mtime;
              latestFile = fp;
            }
          } catch {}
        }
      }
    } catch {}

    if (!latestFile) return { input: 0, output: 0 };

    try {
      const data = JSON.parse(readFileSync(latestFile, "utf-8"));
      let inp = 0,
        out = 0;
      for (const msg of data.messages || []) {
        inp += msg.tokens?.input || 0;
        out += msg.tokens?.output || 0;
      }
      if (inp + out > 0) return { input: inp, output: out };
    } catch {}
    return { input: 0, output: 0 };
  }

  return { input: 0, output: 0 };
}

// ── Codex JSON-line 출력 필터링 ──
// 단일 패스: JSON이면 파싱, 아니면 그대로 출력 (python3 이중 호출 제거)
function filterCodexOutput(rawOutput) {
  const lines = rawOutput.split("\n");
  const result = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const obj = JSON.parse(trimmed);
      if (["message", "completed", "output_text"].includes(obj.type)) {
        const text = obj.text || obj.content || obj.output || "";
        if (text) result.push(text);
      }
    } catch {
      // JSON 아님 → 그대로 통과
      result.push(line);
    }
  }

  return result.join("\n");
}

function cleanTuiArtifacts(output, cliType) {
  if (!output) return output;

  const normalizedCliType = cliType || "";

  let cleaned = output
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*[mGKHJsu]/g, "");

  cleaned = cleaned.replace(/\r/g, "");

  if (normalizedCliType.startsWith("codex")) {
    cleaned = cleaned
      .replace(/^[^\S\n]*[╭╮╰╯│─┌┐└┘├┤┬┴┼].*$/gm, "")
      .replace(/^[^\S\n]*[›❯]\s*$/gm, "")
      .replace(/^\s*codex\s*$/gm, "")
      .replace(/^[^\S\n]*[›❯]\s*Applied.*$/gm, "");
  } else if (normalizedCliType.startsWith("gemini")) {
    cleaned = cleaned.replace(/^[^\S\n]*[╭╮╰╯│─═].*$/gm, "").replace(/^[^\S\n]*>\s*$/gm, "");
  } else if (normalizedCliType.startsWith("claude")) {
    cleaned = cleaned.replace(/^[^\S\n]*[━─]{5,}.*$/gm, "");
  }

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.trim();

  return cleaned;
}

// ── 실행 로그 기록 (JSONL, append-only) ──
function logExecution(params) {
  const logFile = join(LOG_DIR, "tfx-route-stats.jsonl");

  try {
    mkdirSync(LOG_DIR, { recursive: true });

    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      agent: params.agent,
      cli: params.cli,
      effort: params.effort,
      run_mode: params.run_mode,
      opus_oversight: params.opus,
      status: params.status,
      exit_code: params.exit_code,
      elapsed_sec: params.elapsed,
      timeout_sec: params.timeout,
      mcp_profile: params.mcp_profile,
      input_tokens: params.tokens.input,
      output_tokens: params.tokens.output,
      total_tokens: params.tokens.input + params.tokens.output,
    });

    appendFileSync(logFile, entry + "\n");
  } catch {}
}

// ── 토큰 누적 (sv-accumulator.json) ──
function accumulateTokens(cliType, tokens) {
  if (tokens.input + tokens.output === 0) return;

  const accFile = join(CACHE_DIR, "sv-accumulator.json");
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    let data;
    try {
      data = JSON.parse(readFileSync(accFile, "utf-8"));
    } catch {
      data = {};
    }

    if (!data.codex) data.codex = { tokens: 0, calls: 0 };
    if (!data.gemini) data.gemini = { tokens: 0, calls: 0 };

    const key = cliType === "gemini" ? "gemini" : "codex";
    data[key].tokens += tokens.input + tokens.output;
    data[key].calls += 1;
    data.lastUpdated = new Date().toISOString();

    writeFileSync(accFile, JSON.stringify(data, null, 2));
  } catch {}
}

// ── AIMD 배치 이벤트 (append-only JSONL — 락 불필요) ──
// 오케스트레이터가 이 파일을 읽어 batch_size를 계산
function recordBatchEvent(result, agent) {
  const eventsFile = join(CACHE_DIR, "batch-events.jsonl");
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    appendFileSync(eventsFile, JSON.stringify({ ts: Date.now(), agent, result }) + "\n");

    // 자동 회전: 200줄 초과 시 최근 100줄 유지
    const content = readFileSync(eventsFile, "utf-8").trim();
    const lines = content.split("\n");
    if (lines.length > 200) {
      writeFileSync(eventsFile, lines.slice(-100).join("\n") + "\n");
    }
  } catch {}
}

// ── CLI 이슈 추적 ──
function trackCliIssue(cliType, agent, stderrText, exitCode) {
  if (!stderrText && exitCode === 0) return;

  const patterns = [
    { regex: /sandbox image.*missing/i, pattern: "sandbox_missing", msg: "Docker sandbox image not found", severity: "warn" },
    { regex: /rate.limit|429|too many requests/i, pattern: "rate_limit", msg: "API rate limit exceeded", severity: "warn" },
    { regex: /ECONNREFUSED|ENOTFOUND|network/i, pattern: "network_error", msg: "Network connection failed", severity: "error" },
    { regex: /deprecated/i, pattern: "deprecated_flag", msg: "Deprecated flag/feature detected", severity: "warn" },
    { regex: /API_KEY.*not.set|auth.*fail|unauthorized|401/i, pattern: "auth_error", msg: "Authentication failed", severity: "error" },
    { regex: /ENOMEM|out of memory|heap/i, pattern: "oom", msg: "Out of memory", severity: "error" },
  ];

  let matched = null;
  for (const p of patterns) {
    if (p.regex.test(stderrText)) {
      matched = p;
      break;
    }
  }

  if (!matched && exitCode !== 0 && exitCode !== 124) {
    matched = { pattern: "unknown_error", msg: `Exit code ${exitCode}`, severity: "warn" };
  }

  if (!matched) return;

  const issuesFile = join(CACHE_DIR, "cli-issues.jsonl");
  try {
    mkdirSync(CACHE_DIR, { recursive: true });

    // 중복 방지: 같은 패턴+cli가 최근 5분 내 기록됐으면 건너뜀
    if (existsSync(issuesFile)) {
      const lines = readFileSync(issuesFile, "utf-8").trim().split("\n").slice(-5);
      const now = Date.now();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.pattern === matched.pattern && entry.cli === cliType && now - entry.ts < 300000) return;
        } catch {}
      }
    }

    const snippet = stderrText.substring(0, 200).replace(/\n/g, " ");

    appendFileSync(
      issuesFile,
      JSON.stringify({
        ts: Date.now(),
        cli: cliType,
        agent,
        pattern: matched.pattern,
        msg: matched.msg,
        severity: matched.severity,
        snippet,
        resolved: false,
      }) + "\n",
    );

    // 자동 회전
    const content = readFileSync(issuesFile, "utf-8").trim();
    const allLines = content.split("\n");
    if (allLines.length > 200) {
      writeFileSync(issuesFile, allLines.slice(-100).join("\n") + "\n");
    }
  } catch {}
}

// ── 출력 절삭 ──
function truncateOutput(text, maxBytes) {
  const buf = Buffer.from(text);
  if (buf.length > maxBytes) {
    return (
      buf.subarray(0, maxBytes).toString("utf-8") +
      `\n--- [출력 ${buf.length}B → ${maxBytes}B로 절삭됨] ---`
    );
  }
  return text;
}

// ── 메인 ──
function main() {
  const a = parseArgs();

  const agent = a.agent || "unknown";
  const cliType = a.cli || "codex";
  const effort = a.effort || "high";
  const runMode = a.run_mode || "bg";
  const opus = a.opus || "false";
  const exitCode = parseInt(a.exit_code || "0");
  const elapsed = parseInt(a.elapsed || "0");
  const timeout = parseInt(a.timeout || "300");
  const mcpProfile = a.mcp_profile || "auto";
  const stderrLog = a.stderr_log || "";
  const stdoutLog = a.stdout_log || "";
  const maxBytes = parseInt(a.max_bytes || "51200");
  const cliCmd = a.cli_cmd || cliType;

  // stderr/stdout 읽기
  let stderrContent = "";
  try {
    stderrContent = readFileSync(stderrLog, "utf-8");
  } catch {}
  let rawOutput = "";
  try {
    rawOutput = readFileSync(stdoutLog, "utf-8");
  } catch {}

  // 1. 토큰 추출
  const tokens = extractTokens(cliType, stderrLog);

  // 2. 상태 판단
  let status;
  if (exitCode === 0) {
    status = stderrContent ? "success_with_warnings" : "success";
  } else if (exitCode === 124) {
    status = "timeout";
  } else {
    status = "failed";
  }

  // 3. 실행 로그
  logExecution({
    agent,
    cli: cliType,
    effort,
    run_mode: runMode,
    opus,
    status,
    exit_code: exitCode,
    elapsed,
    timeout,
    mcp_profile: mcpProfile,
    tokens,
  });

  // 4. 성공 시 토큰 누적
  if (exitCode === 0) accumulateTokens(cliType, tokens);

  // 5. AIMD 배치 이벤트
  const aimdResult = exitCode === 0 ? "success" : exitCode === 124 ? "timeout" : "failed";
  recordBatchEvent(aimdResult, agent);

  // 6. CLI 이슈 추적
  trackCliIssue(cliType, agent, stderrContent, exitCode);

  // 7. 구조화된 결과 출력
  console.log("=== TFX-ROUTE RESULT ===");
  console.log(`agent: ${agent}`);
  console.log(`cli: ${cliType} (${cliCmd})`);
  console.log(`effort: ${effort}`);
  console.log(`run_mode: ${runMode}`);
  console.log(`opus_oversight: ${opus}`);
  console.log(`exit_code: ${exitCode}`);
  console.log(`timeout: ${timeout}s`);
  console.log(`elapsed: ${elapsed}s`);
  console.log(`mcp_profile: ${mcpProfile}`);
  console.log(`stderr_log: ${stderrLog}`);

  if (exitCode === 0) {
    if (stderrContent) {
      console.log("status: success_with_warnings");
      console.log(`warnings: ${stderrContent.split("\n").slice(0, 3).join(" ")}`);
    } else {
      console.log("status: success");
    }
    console.log("=== OUTPUT ===");
    let filtered = cliType === "codex" ? filterCodexOutput(rawOutput) : rawOutput;
    if (a.clean_tui !== "false" && process.env.TFX_CLEAN_TUI !== "0") {
      filtered = cleanTuiArtifacts(filtered, cliType);
    }
    console.log(truncateOutput(filtered, maxBytes));
  } else if (exitCode === 124) {
    console.log(`status: timeout (${timeout}s 초과)`);
    console.log("=== PARTIAL OUTPUT ===");
    let partialFiltered = rawOutput;
    if (a.clean_tui !== "false" && process.env.TFX_CLEAN_TUI !== "0") {
      partialFiltered = cleanTuiArtifacts(partialFiltered, cliType);
    }
    console.log(truncateOutput(partialFiltered, maxBytes));
    console.log("=== STDERR ===");
    console.log(stderrContent.split("\n").slice(-10).join("\n"));
  } else {
    console.log(`status: failed (exit_code=${exitCode})`);
    console.log("=== STDERR ===");
    console.log(stderrContent.split("\n").slice(-20).join("\n"));
    if (rawOutput) {
      console.log("=== PARTIAL OUTPUT ===");
      let partialFiltered = rawOutput;
      if (a.clean_tui !== "false" && process.env.TFX_CLEAN_TUI !== "0") {
        partialFiltered = cleanTuiArtifacts(partialFiltered, cliType);
      }
      console.log(truncateOutput(partialFiltered, maxBytes));
    }
  }
}

import { fileURLToPath } from "url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}

export { cleanTuiArtifacts };

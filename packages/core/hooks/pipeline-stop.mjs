#!/usr/bin/env node
// hooks/pipeline-stop.mjs — Stop 훅: 컨텍스트 가드와 활성 파이프라인 감지
//
// Claude Code Stop 이벤트에서 실행.
// 컨텍스트 한계/사용자 중단 신호는 조용히 통과시키고, 높은 컨텍스트 사용량은
// 세션별 제한 횟수만 block 한다. 이후 비터미널 단계의 파이프라인이 있으면
// decision:"block" + reason으로 중단을 방지한다.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let getPipelineStateDbPath;
let ensurePipelineTable;
let listPipelineStates;
try {
  ({ getPipelineStateDbPath, ensurePipelineTable, listPipelineStates } =
    await import("../hub/pipeline/state.mjs"));
} catch {
  // hub/pipeline 모듈 없으면 훅 무동작
  process.exit(0);
}

const PROJECT_ROOT = process.env.CLAUDE_CWD || process.cwd();
const HUB_DB_PATH = getPipelineStateDbPath(PROJECT_ROOT);
const TERMINAL = new Set(["complete", "failed"]);

const DEFAULT_CONTEXT_THRESHOLD = 75;
const DEFAULT_CRITICAL_THRESHOLD = 95;
const DEFAULT_MAX_BLOCKS = 2;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$/;

const CONTEXT_LIMIT_PATTERNS = [
  "context_limit",
  "context_window",
  "context_exceeded",
  "context_full",
  "max_context",
  "token_limit",
  "max_tokens",
  "conversation_too_long",
  "input_too_long",
];
const USER_ABORT_EXACT = new Set([
  "aborted",
  "abort",
  "cancel",
  "cancelled",
  "interrupt",
]);
const USER_ABORT_SUBSTRINGS = [
  "user_cancel",
  "user_interrupt",
  "ctrl_c",
  "manual_stop",
  "keyboard_interrupt",
];

function readStopPayload() {
  try {
    const raw = readFileSync(0, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function stopReason(payload) {
  return String(
    payload.stop_reason ??
      payload.stopReason ??
      payload.reason ??
      payload.error ??
      "",
  ).toLowerCase();
}

function isContextLimitStop(payload) {
  const reason = stopReason(payload);
  return CONTEXT_LIMIT_PATTERNS.some((pattern) => reason.includes(pattern));
}

function isUserAbortStop(payload) {
  if (payload.user_requested === true || payload.userRequested === true) {
    return true;
  }

  const reason = stopReason(payload).trim();
  return (
    USER_ABORT_EXACT.has(reason) ||
    USER_ABORT_SUBSTRINGS.some((pattern) => reason.includes(pattern))
  );
}

function numericPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function tokenPercent(used, max) {
  const usedNumber = Number(used);
  const maxNumber = Number(max);
  if (
    !Number.isFinite(usedNumber) ||
    !Number.isFinite(maxNumber) ||
    maxNumber <= 0
  ) {
    return null;
  }
  return (usedNumber / maxNumber) * 100;
}

function contextPercentsFromObject(value) {
  if (!value || typeof value !== "object") return [];

  const candidates = [
    value.used_percentage,
    value.usedPercentage,
    value.used_percent,
    value.usedPercent,
    value.percentage,
    value.percent,
    value.context_percent,
    value.contextPercent,
  ];

  const currentUsage = value.current_usage ?? value.currentUsage ?? {};
  const maxTokens =
    value.context_window_size ??
    value.contextWindowSize ??
    value.max_context_tokens ??
    value.maxContextTokens ??
    value.max_tokens ??
    value.maxTokens ??
    value.total_tokens ??
    value.totalTokens;
  candidates.push(
    tokenPercent(value.used_tokens ?? value.usedTokens, maxTokens),
    tokenPercent(
      currentUsage.input_tokens ?? currentUsage.inputTokens,
      maxTokens,
    ),
    tokenPercent(
      currentUsage.total_tokens ?? currentUsage.totalTokens,
      maxTokens,
    ),
  );

  return candidates.map(numericPercent).filter((percent) => percent !== null);
}

function contextPercentFromPayload(payload) {
  const percents = [
    ...contextPercentsFromObject(payload.context_window),
    ...contextPercentsFromObject(payload.contextWindow),
  ];
  return percents.length > 0 ? Math.max(...percents) : null;
}

function parseJsonCandidate(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readTranscriptTail(transcriptPath) {
  let fd;
  try {
    const stat = statSync(transcriptPath);
    if (!stat.isFile()) return null;

    const bytesToRead = Math.min(stat.size, 64 * 1024);
    const offset = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);

    fd = openSync(transcriptPath, "r");
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, offset);
    return buffer.toString("utf8", 0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close failures: transcript reads are best-effort only.
      }
    }
  }
}

function contextPercentFromTranscript(payload) {
  const transcriptPath = payload.transcript_path ?? payload.transcriptPath;
  if (!transcriptPath || typeof transcriptPath !== "string") return null;

  const tail = readTranscriptTail(transcriptPath);
  if (tail === null) return 0;

  const percents = [];
  for (const line of tail.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseJsonCandidate(trimmed);
    if (!parsed) continue;
    const percent = contextPercentFromPayload(parsed);
    if (percent !== null) percents.push(percent);
  }
  return percents.length > 0 ? Math.max(...percents) : null;
}

function isHubTokenMonitorSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return false;
  return (
    Object.hasOwn(snapshot, "requestTokens") ||
    Object.hasOwn(snapshot, "responseTokens") ||
    Object.hasOwn(snapshot, "totalUpdates") ||
    (snapshot.byTool && typeof snapshot.byTool === "object")
  );
}

function contextPercentFromCache() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;
  const cachePath = join(
    home,
    ".claude",
    "cache",
    "tfx-hub",
    "context-monitor.json",
  );
  if (!existsSync(cachePath)) return null;

  try {
    const parsed = parseJsonCandidate(readFileSync(cachePath, "utf8"));
    if (!parsed) return null;
    if (isHubTokenMonitorSnapshot(parsed)) return null;
    const direct = contextPercentFromPayload(parsed);
    if (direct !== null) return direct;
    const percents = contextPercentsFromObject(parsed);
    return percents.length > 0 ? Math.max(...percents) : null;
  } catch {
    return null;
  }
}

function contextPercent(payload) {
  return (
    contextPercentFromPayload(payload) ??
    contextPercentFromTranscript(payload) ??
    contextPercentFromCache()
  );
}

function guardKey(payload) {
  const sessionId = payload.session_id ?? payload.sessionId;
  if (typeof sessionId === "string" && SESSION_ID_PATTERN.test(sessionId)) {
    return sessionId;
  }

  const fallback = JSON.stringify({
    cwd: PROJECT_ROOT,
    transcript: payload.transcript_path ?? payload.transcriptPath ?? "",
  });
  return createHash("sha256").update(fallback).digest("hex");
}

function stateDir() {
  return (
    process.env.TRIFLUX_CONTEXT_GUARD_STATE_DIR ||
    join(tmpdir(), "tfx-context-guard-stop")
  );
}

function statePathForKey(key) {
  const safeKey = SESSION_ID_PATTERN.test(key)
    ? key
    : createHash("sha256").update(key).digest("hex");
  return join(stateDir(), `${safeKey}.json`);
}

function readGuardState(path) {
  try {
    const parsed = parseJsonCandidate(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function maybeContextGuardBlock(payload) {
  const percent = contextPercent(payload);
  if (percent === null) return null;

  const threshold = envNumber(
    "TFX_CONTEXT_GUARD_THRESHOLD",
    DEFAULT_CONTEXT_THRESHOLD,
  );
  const criticalThreshold = envNumber(
    "TFX_CONTEXT_GUARD_CRITICAL_THRESHOLD",
    DEFAULT_CRITICAL_THRESHOLD,
  );
  const maxBlocks = Math.max(
    0,
    Math.floor(envNumber("TFX_CONTEXT_GUARD_MAX_BLOCKS", DEFAULT_MAX_BLOCKS)),
  );

  if (percent >= criticalThreshold) return null;
  if (percent < threshold || maxBlocks === 0) return null;

  try {
    const path = statePathForKey(guardKey(payload));
    const state = readGuardState(path);
    const blockCount = Math.max(0, Math.floor(Number(state.blockCount) || 0));
    if (blockCount >= maxBlocks) return null;

    const nextBlockCount = blockCount + 1;
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        blockCount: nextBlockCount,
        percent,
        updatedAt: new Date().toISOString(),
      }),
      "utf8",
    );

    return {
      decision: "block",
      reason:
        `[tfx context guard] context usage ${percent.toFixed(1)}% is above ` +
        `${threshold}% threshold. Compact or reduce context before stopping. ` +
        `(Block ${nextBlockCount}/${maxBlocks})`,
    };
  } catch {
    // Context guard state is best-effort. If retry-state I/O fails, fail open
    // for the guard only so active pipeline Stop blocks can still run.
    return null;
  }
}

async function checkActivePipelines() {
  if (!existsSync(HUB_DB_PATH)) return [];

  try {
    const { default: Database } = await import("better-sqlite3");

    const db = new Database(HUB_DB_PATH, { readonly: true });
    ensurePipelineTable(db);
    const states = listPipelineStates(db);
    db.close();

    return states.filter((s) => !TERMINAL.has(s.phase));
  } catch {
    return [];
  }
}

function activePipelineBlock(active) {
  const lines = active.map(
    (s) =>
      `  - 팀 ${s.team_name}: ${s.phase} 단계 (fix: ${s.fix_attempt}/${s.fix_max}, ralph: ${s.ralph_iteration}/${s.ralph_max})`,
  );

  const reason =
    `[tfx-multi 파이프라인 진행 중]\n` +
    `활성 파이프라인 ${active.length}개가 아직 완료되지 않았습니다:\n` +
    `${lines.join("\n")}\n\n` +
    `파이프라인을 이어서 진행하려면 /tfx-multi status 로 상태를 확인하세요.\n` +
    `강제 종료하려면 /tfx-multi cancel 을 먼저 실행하세요.`;

  return {
    decision: "block",
    reason,
  };
}

try {
  const payload = readStopPayload();

  if (isContextLimitStop(payload) || isUserAbortStop(payload)) {
    process.exit(0);
  }

  const contextBlock = maybeContextGuardBlock(payload);
  if (contextBlock) {
    process.stdout.write(JSON.stringify(contextBlock));
    process.exit(0);
  }

  const active = await checkActivePipelines();

  if (active.length === 0) {
    // 활성 파이프라인 없음 → 정상 종료 허용
    process.exit(0);
  }

  // 활성 파이프라인 발견 → 구조화 decision으로 block
  process.stdout.write(JSON.stringify(activePipelineBlock(active)));
} catch {
  // 훅 실패 시 종료 허용
  process.exit(0);
}

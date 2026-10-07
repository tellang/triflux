import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { codexThreadNames } from "../lib/codex-session-registry.mjs";
import { findCodexRollout } from "./session-context.mjs";

const execFileAsync = promisify(execFile);
const THREAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIRST_LINE_LIMIT = 1024 * 1024;

export function isCodexThreadId(value) {
  return THREAD_ID_RE.test(String(value ?? ""));
}

function codexHome(env) {
  return env.CODEX_HOME || join(env.HOME || homedir(), ".codex");
}

function realCwd(value) {
  if (!value) return null;
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 같은 이름이 여러 번 등록될 수 있어 sinceMs 이후 마지막 항목을 쓴다.
export async function codexThreadIdByName(
  name,
  { env = process.env, sinceMs = 0 } = {},
) {
  let data;
  try {
    data = await readFile(join(codexHome(env), "session_index.jsonl"), "utf8");
  } catch {
    return null;
  }
  let threadId = null;
  for (const line of data.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (
        entry.thread_name === name &&
        isCodexThreadId(entry.id) &&
        Date.parse(entry.updated_at) >= sinceMs
      )
        threadId = entry.id;
    } catch {
      // 기록 중인 마지막 줄은 건너뛴다.
    }
  }
  return threadId;
}

async function readFirstLine(path) {
  const handle = await open(path, "r");
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(64 * 1024);
    let text = "";
    let position = 0;
    while (position < FIRST_LINE_LIMIT) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) break;
      position += bytesRead;
      text += decoder.write(buffer.subarray(0, bytesRead));
      const end = text.indexOf("\n");
      if (end >= 0) return text.slice(0, end);
    }
    return text;
  } finally {
    await handle.close();
  }
}

// rollout 첫 줄 session_meta 의 cwd 가 같은 thread 가 정확히 하나일 때만 돌려준다.
export async function findCodexThreadByCwd(
  cwd,
  { env = process.env, sinceMs = 0, days = 2 } = {},
) {
  const target = realCwd(cwd);
  if (!target) return { threadId: null, reason: "cwd-unknown" };
  const root = join(codexHome(env), "sessions");
  const dayDirs = [];
  for (const year of (await readdir(root).catch(() => [])).sort().reverse()) {
    for (const month of (await readdir(join(root, year)).catch(() => []))
      .sort()
      .reverse()) {
      for (const day of (await readdir(join(root, year, month)).catch(() => []))
        .sort()
        .reverse()) {
        dayDirs.push(join(root, year, month, day));
        if (dayDirs.length >= days) break;
      }
      if (dayDirs.length >= days) break;
    }
    if (dayDirs.length >= days) break;
  }
  const matches = new Set();
  for (const dir of dayDirs) {
    for (const file of await readdir(dir).catch(() => [])) {
      if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
      try {
        const { payload } = JSON.parse(await readFirstLine(join(dir, file)));
        if (
          isCodexThreadId(payload?.id) &&
          realCwd(payload.cwd) === target &&
          Date.parse(payload.timestamp) >= sinceMs
        )
          matches.add(payload.id);
      } catch {
        // session_meta 가 아닌 파일은 무시한다.
      }
    }
  }
  if (matches.size === 1) return { threadId: [...matches][0] };
  return {
    threadId: null,
    reason: matches.size ? "thread-ambiguous" : "thread-not-found",
  };
}

export async function queueCodexMessage({
  threadId,
  message,
  env = process.env,
  execFn = execFileAsync,
}) {
  // cwd 의 프로젝트 .codex/config.toml 이 깨져 있으면 queue 가 실패하므로 HOME 에서 실행한다.
  const { stdout } = await execFn(
    "codex",
    ["queue", "--thread", threadId, "--message", message],
    {
      env,
      cwd: env.HOME || homedir(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const match = String(stdout).match(/Queued message (\S+) for thread/);
  if (!match) {
    const error = new Error(
      `unexpected codex queue output: ${String(stdout).trim()}`,
    );
    // 종료 코드 0 이면 이미 쌓였을 수 있어 폴백 재전송을 막는다.
    error.maybeQueued = true;
    throw error;
  }
  return { queuedMessageId: match[1] };
}

function userTexts(entry) {
  const payload = entry.payload ?? {};
  if (
    entry.type === "response_item" &&
    payload.type === "message" &&
    payload.role === "user"
  )
    return {
      turnId: payload.internal_chat_message_metadata_passthrough?.turn_id,
      texts: (payload.content ?? []).map((item) => item.text ?? ""),
    };
  if (
    entry.type === "event_msg" &&
    payload.type === "item_completed" &&
    payload.item?.type === "UserMessage"
  )
    return {
      turnId: payload.turn_id,
      texts: (payload.item.content ?? []).map((item) => item.text ?? ""),
    };
  return null;
}

export function createCodexTurnTracker(requestId) {
  const tag = `[tfx-live req=${requestId}]`;
  const finished = new Map();
  let turnId = null;
  let deliveredAt = null;
  return {
    accept(line) {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        return;
      }
      const payload = entry.payload ?? {};
      if (entry.type === "event_msg" && payload.type === "task_complete")
        finished.set(payload.turn_id, {
          status: "completed",
          response: payload.last_agent_message ?? "",
          completedAt: entry.timestamp,
        });
      else if (entry.type === "event_msg" && payload.type === "turn_aborted")
        finished.set(payload.turn_id, {
          status: "failed",
          error: `turn aborted: ${payload.reason ?? "unknown"}`,
          completedAt: entry.timestamp,
        });
      if (turnId) return;
      const user = userTexts(entry);
      if (user?.turnId && user.texts.some((text) => text.includes(tag))) {
        turnId = user.turnId;
        deliveredAt = entry.timestamp;
      }
    },
    state() {
      if (!turnId) return { status: "queued", delivered: false, done: false };
      const end = finished.get(turnId);
      if (!end)
        return {
          status: "working",
          delivered: true,
          deliveredAt,
          turnId,
          done: false,
        };
      return {
        ...end,
        delivered: true,
        deliveredAt,
        turnId,
        done: end.status === "completed",
      };
    },
  };
}

async function readNewLines(reader, onLine) {
  const handle = await open(reader.path, "r");
  try {
    const buffer = Buffer.alloc(256 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        reader.offset,
      );
      if (!bytesRead) break;
      reader.offset += bytesRead;
      const lines = (
        reader.carry + reader.decoder.write(buffer.subarray(0, bytesRead))
      ).split("\n");
      reader.carry = lines.pop();
      for (const line of lines) if (line) onLine(line);
    }
  } finally {
    await handle.close();
  }
}

// rollout 은 첫 턴에 생기므로 파일이 없으면 아직 배달 전으로 본다.
export async function waitCodexRequest({
  threadId,
  requestId,
  timeoutMs = 0,
  pollIntervalMs = 1000,
  findRollout = findCodexRollout,
}) {
  const tracker = createCodexTurnTracker(requestId);
  const reader = {
    path: null,
    offset: 0,
    carry: "",
    decoder: new StringDecoder("utf8"),
  };
  const deadline = Date.now() + timeoutMs;
  while (true) {
    reader.path ||= await findRollout(threadId);
    if (reader.path) await readNewLines(reader, (line) => tracker.accept(line));
    const state = tracker.state();
    const final = state.done || state.status === "failed";
    if (final || Date.now() >= deadline)
      return {
        cli: "codex",
        threadId,
        requestId,
        rolloutPath: reader.path,
        ...state,
        ...(final ? {} : { timedOut: true }),
      };
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

function oneLine(value) {
  const line = String(value ?? "")
    .split(/\r?\n/)[0]
    .trim();
  return line ? line.slice(0, 80) : null;
}

// 보낸 쪽 세션 이름. Claude 는 세션 기록, Codex 는 session_index 에서 찾는다.
export async function resolveSenderName({ env = process.env } = {}) {
  if (env.TFX_LIVE_FROM) return oneLine(env.TFX_LIVE_FROM);
  if (env.CLAUDE_PID) {
    const dir = join(
      env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"),
      "sessions",
    );
    try {
      const name = oneLine(
        JSON.parse(await readFile(join(dir, `${env.CLAUDE_PID}.json`), "utf8"))
          .name,
      );
      if (name) return name;
    } catch {
      // 세션 기록이 없으면 다음 출처로 넘어간다.
    }
  }
  if (isCodexThreadId(env.CODEX_THREAD_ID)) {
    const name = codexThreadNames({
      indexPath: join(codexHome(env), "session_index.jsonl"),
    }).get(env.CODEX_THREAD_ID);
    if (oneLine(name)) return oneLine(name);
  }
  return null;
}

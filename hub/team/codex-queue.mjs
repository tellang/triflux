import { execFile, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
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
        // 같은 cwd 의 exec 워커와 서브에이전트 thread 는 TUI 대상이 아니다.
        if (
          isCodexThreadId(payload?.id) &&
          (payload.source ?? "cli") === "cli" &&
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

// 같은 cwd 에서 도는 Codex TUI 수. 확인할 수 없으면 null.
export async function countCodexTuiInCwd(cwd, { execFn = execFileAsync } = {}) {
  const target = realCwd(cwd);
  let listed = "";
  try {
    ({ stdout: listed } = await execFn(
      "lsof",
      ["-a", "-c", "codex", "-d", "cwd", "-Fpn"],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    ));
  } catch (error) {
    // lsof 는 일치하는 프로세스가 없어도 1 로 끝난다.
    if (error.code !== 1) return null;
    listed = error.stdout ?? "";
  }
  const pids = [];
  let pid = null;
  for (const line of String(listed).split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid && realCwd(line.slice(1)) === target)
      pids.push(pid);
  }
  if (!pids.length) return 0;
  try {
    const { stdout } = await execFn(
      "ps",
      ["-o", "args=", "-p", pids.join(",")],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
    );
    return String(stdout)
      .split("\n")
      .filter((line) => line.trim() && !/\bapp-server\b/.test(line)).length;
  } catch {
    return null;
  }
}

export async function queueCodexMessage({
  threadId,
  message,
  env = process.env,
  execFn = execFileAsync,
}) {
  let stdout;
  try {
    // cwd 의 프로젝트 .codex/config.toml 이 깨져 있으면 queue 가 실패하므로 HOME 에서 실행한다.
    ({ stdout } = await execFn(
      "codex",
      ["queue", `--thread=${threadId}`, `--message=${message}`],
      {
        env,
        cwd: env.HOME || homedir(),
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    ));
  } catch (error) {
    // 비정상 종료라도 이미 쌓였을 수 있으면 폴백 재전송을 막는다.
    if (!/Queued message/.test(String(error.stdout ?? ""))) {
      if (error.killed || String(error.stdout ?? "").trim())
        error.maybeQueued = true;
      throw error;
    }
    stdout = error.stdout;
  }
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

// 공식 app-server 를 stdio 로 잠깐 띄워 요청을 보낸다. 큐 조회와 삭제가 실험 API 라 experimentalApi 를 켠다.
export async function withCodexAppServer(
  run,
  { env = process.env, timeoutMs = 30_000, spawnFn = spawn } = {},
) {
  const child = spawnFn("codex", ["app-server"], {
    env,
    cwd: env.HOME || homedir(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  let nextId = 0;
  let closed = null;
  const settleAll = (error) => {
    closed ??= error;
    for (const { reject } of pending.values()) reject(closed);
    pending.clear();
  };
  child.on("error", settleAll);
  // 먼저 끝난 app-server 에 쓰면 EPIPE 가 stdin 에서 나므로 요청 실패로 돌린다.
  child.stdin.on("error", settleAll);
  child.on("exit", (code) =>
    settleAll(new Error(`codex app-server exited (${code})`)),
  );
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error)
      waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
    else waiter.resolve(message.result);
  });
  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const request = (method, params) => {
    if (closed) return Promise.reject(closed);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      send({ id, method, params });
    });
  };
  const timer = setTimeout(
    () => settleAll(new Error("codex app-server timed out")),
    timeoutMs,
  );
  try {
    await request("initialize", {
      clientInfo: { name: "triflux-tfx-live", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    return await run(request);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}

function queuedRequestId(texts) {
  return texts.join("\n").match(/\[tfx-live req=([^\]\s]+)\]/)?.[1] ?? null;
}

// TUI 가 가져가기 전의 항목만 보인다. 가져간 뒤의 처리 여부는 wait 가 rollout 으로 본다.
export function listCodexQueue(threadId, options = {}) {
  return withCodexAppServer(async (request) => {
    const items = [];
    let cursor = null;
    do {
      const page = await request("thread/queue/list", { threadId, cursor });
      for (const item of page?.data ?? []) {
        const texts = (item.input ?? []).map((part) => part.text ?? "");
        items.push({
          id: item.id,
          requestId: queuedRequestId(texts),
          text: texts.join("\n"),
        });
      }
      cursor = page?.nextCursor ?? null;
    } while (cursor);
    return items;
  }, options);
}

// 지우기 전에 TUI 가 가져간 항목은 deleted: false 라 missing 으로 돌려준다.
export function deleteCodexQueueItems(threadId, ids, options = {}) {
  return withCodexAppServer(async (request) => {
    const deleted = [];
    const missing = [];
    for (const id of ids) {
      const result = await request("thread/queue/delete", {
        threadId,
        queuedSubmissionId: id,
      });
      (result?.deleted === true ? deleted : missing).push(id);
    }
    return { deleted, missing };
  }, options);
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

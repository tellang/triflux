import { realpath } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import {
  createActivityLifecycle,
  isActivityLifecycleEnabled,
  resolveHardCeilingMs,
} from "../lib/worker-lifecycle.mjs";
import { JsonRpcWsUdsClient } from "../workers/lib/jsonrpc-ws-uds.mjs";
import { contextGuard, readCodexContext } from "./session-context.mjs";

const DEFAULT_CODEX_APP_SERVER_UDS_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS = 12_000;

function codexClient(socketPath, timeoutMs, clientFactory) {
  return clientFactory({ socketPath, connectTimeoutMs: timeoutMs });
}

async function initializeCodexClient(client, timeoutMs, remainingMs) {
  await client.connect();
  await client.request(
    "initialize",
    { clientInfo: { name: "triflux-tfx-live", version: "1.0.0" } },
    remainingMs ? Math.max(1, remainingMs()) : timeoutMs,
  );
  client.notify("initialized", {});
}

async function runCodexAppServerTurn({
  client,
  threadId,
  prompt,
  timeoutMs,
  maxTurnMs,
  expectedTurnId,
  noWait = false,
}) {
  const messages = new Map();
  const pending = [];
  let turnId = null;
  let startedTurnId = null;
  let retries = 0;
  let settled = false;
  let timer = null;
  let resolveCompletion;
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const lifecycle = createActivityLifecycle({
    enabled: isActivityLifecycleEnabled(),
    interventionMs: timeoutMs,
    hardCeilingMs: maxTurnMs,
  });
  const finish = (result) => {
    if (settled) return;
    settled = true;
    resolveCompletion(result);
  };
  const matching = (params) =>
    (!params?.threadId || params.threadId === threadId) &&
    (!params?.turnId || params.turnId === turnId) &&
    (!params?.turn?.id || params.turn.id === turnId);
  const receive = (kind, params) => {
    if (!turnId) {
      pending.push([kind, params]);
      return;
    }
    if (!matching(params)) return;
    if (kind === "started" && params?.turn?.id === turnId) {
      startedTurnId = turnId;
    } else if (kind === "delta" && typeof params?.delta === "string") {
      const itemId = params?.itemId || "__unidentified_agent_message__";
      if (!messages.has(itemId))
        messages.set(itemId, { text: "", phase: null });
      messages.get(itemId).text += params.delta;
      lifecycle.observe();
    } else if (
      kind === "itemCompleted" &&
      params?.item?.type === "agentMessage"
    ) {
      const itemId = params.item.id;
      if (itemId) {
        if (!messages.has(itemId))
          messages.set(itemId, { text: "", phase: null });
        const message = messages.get(itemId);
        if (typeof params.item.text === "string")
          message.text = params.item.text;
        message.phase = params.item.phase || null;
      }
    } else if (kind === "completed" && params?.turn?.id === turnId) {
      finish({
        status: params?.turn?.status || "unknown",
        matchedCompletion: true,
      });
    } else if (kind === "error") {
      if (params?.willRetry === true) {
        retries++;
        lifecycle.observe();
        return;
      }
      finish({
        status: "failed",
        message:
          params?.error?.message || params?.message || "codex app-server error",
        matchedCompletion: false,
      });
    }
  };
  const offDelta = client.onNotification("item/agentMessage/delta", (p) =>
    receive("delta", p),
  );
  const offItemCompleted = client.onNotification("item/completed", (p) =>
    receive("itemCompleted", p),
  );
  const offStarted = client.onNotification("turn/started", (p) =>
    receive("started", p),
  );
  const offDone = client.onNotification("turn/completed", (p) =>
    receive("completed", p),
  );
  const offError = client.onNotification("error", (p) => receive("error", p));
  const offActivity = client.onNotification("*", (params) => {
    if (matching(params)) lifecycle.observe();
  });
  const armTimer = () => {
    timer = setTimeout(async () => {
      if (settled) return;
      if (!isActivityLifecycleEnabled()) {
        finish({ status: "timeout", matchedCompletion: false });
        return;
      }
      const reason = await lifecycle.check();
      if (settled) return;
      if (reason)
        finish({ status: "timeout", reason, matchedCompletion: false });
      else armTimer();
    }, timeoutMs);
  };
  armTimer();
  try {
    const input = [{ type: "text", text: prompt }];
    const started = expectedTurnId
      ? await client.request(
          "turn/steer",
          { threadId, input, expectedTurnId },
          timeoutMs,
        )
      : await client.request("turn/start", { threadId, input }, timeoutMs);
    turnId = started?.turn?.id || started?.turnId;
    if (!turnId)
      throw new Error("codex app-server turn/start returned no turn id");
    if (noWait) {
      return {
        status: "submitted",
        inputSent: true,
        done: false,
        turnId,
        submittedAt: new Date().toISOString(),
        target: threadId,
      };
    }
    for (const [kind, params] of pending) receive(kind, params);
    const result = await completion;
    const entries = [...messages.values()].map((item) => ({
      ...item,
      text: item.text.trim(),
    }));
    const finals = entries.filter((item) => item.phase === "final_answer");
    const answer = finals.length ? finals : entries.slice(-1);
    const commentary = entries.filter(
      (item) => item.phase === "commentary" && item.text,
    );
    return {
      ...result,
      turnId,
      response: answer
        .map((item) => item.text)
        .filter(Boolean)
        .join("\n\n"),
      commentary: commentary.map((item) => item.text),
      retries,
      steered:
        result.matchedCompletion &&
        (expectedTurnId === turnId || startedTurnId !== turnId),
      timedOut: result.status === "timeout",
    };
  } finally {
    clearTimeout(timer);
    offDelta();
    offItemCompleted();
    offStarted();
    offDone();
    offError();
    offActivity();
  }
}

async function readCodexThread(client, threadId, timeoutMs) {
  const result = await client.request("thread/read", { threadId }, timeoutMs);
  if (!result?.thread)
    throw new Error(`codex thread/read returned no thread: ${threadId}`);
  return result.thread;
}

async function normalizedCwd(cwd) {
  if (!cwd) return null;
  try {
    return await realpath(cwd);
  } catch (error) {
    if (error?.code === "ENOENT") return pathResolve(cwd);
    throw error;
  }
}

// timeoutMs 는 RPC 하나의 상한이다. remainingMs 를 주면 조회 전체가 그 안에 끝나야 한다.
async function loadedCodexThreads(client, cwd, timeoutMs, remainingMs) {
  const limit = () => {
    if (!remainingMs) return timeoutMs;
    const left = remainingMs();
    if (left <= 0) throw new Error("codex thread listing timed out");
    return left;
  };
  const wantedCwd = await normalizedCwd(cwd);
  const threads = [];
  let cursor;
  do {
    const result = await client.request(
      "thread/loaded/list",
      cursor ? { cursor } : {},
      limit(),
    );
    for (const threadId of result?.data || []) {
      const thread = await readCodexThread(client, threadId, limit());
      if (wantedCwd && (await normalizedCwd(thread.cwd)) !== wantedCwd)
        continue;
      threads.push({
        threadId,
        cwd: thread.cwd,
        name: thread.name,
        status: thread.status,
        source: thread.source,
      });
    }
    cursor = result?.nextCursor;
  } while (cursor);
  return threads;
}

export async function listCodexAppServerThreads({
  socketPath,
  cwd,
  timeoutMs = DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
  clientFactory = (opts) => new JsonRpcWsUdsClient(opts),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const remainingMs = () => deadline - Date.now();
  const client = codexClient(socketPath, timeoutMs, clientFactory);
  try {
    await initializeCodexClient(client, timeoutMs, remainingMs);
    return await loadedCodexThreads(client, cwd, timeoutMs, remainingMs);
  } finally {
    client.close();
  }
}

export async function renameCodexAppServerThread({
  socketPath,
  threadId,
  name,
  clientFactory = (opts) => new JsonRpcWsUdsClient(opts),
} = {}) {
  const timeoutMs = DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS;
  const client = codexClient(socketPath, timeoutMs, clientFactory);
  try {
    await initializeCodexClient(client, timeoutMs);
    await client.request("thread/name/set", { threadId, name }, timeoutMs);
    return {
      ok: true,
      cli: "codex",
      transport: "uds",
      threadId,
      name,
      nameApplied: true,
    };
  } finally {
    client.close();
  }
}

export async function askCodexAppServerThread({
  socketPath,
  threadId,
  cwd,
  prompt,
  timeoutMs = DEFAULT_CODEX_APP_SERVER_UDS_TIMEOUT_MS,
  maxTurnMs = Math.min(resolveHardCeilingMs(), 15 * 60_000),
  ifBusy = "wait",
  busyTimeoutMs = timeoutMs,
  pollIntervalMs = 200,
  noWait = false,
  warnContextPct,
  maxContextPct,
  clientFactory = (opts) => new JsonRpcWsUdsClient(opts),
} = {}) {
  if (typeof prompt !== "string" || !prompt.trim())
    throw new Error("codex UDS ask requires a non-empty prompt");
  if (!threadId) throw new Error("codex UDS ask requires --thread <id|auto>");
  if (!["wait", "fail", "steer"].includes(ifBusy))
    throw new Error(`invalid --if-busy: ${ifBusy}`);
  const client = codexClient(
    socketPath,
    DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
    clientFactory,
  );
  try {
    await initializeCodexClient(
      client,
      DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
    );
    let selectedId = threadId;
    if (threadId === "auto") {
      const candidates = await loadedCodexThreads(
        client,
        cwd,
        DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
      );
      if (!candidates.length)
        throw new Error(
          "no loaded Codex threads; open the TUI and send its first message before using --thread auto",
        );
      if (candidates.length !== 1)
        throw new Error(
          `multiple loaded Codex threads; pass --thread ID: ${JSON.stringify(candidates)}`,
        );
      selectedId = candidates[0].threadId;
    }
    const busyStarted = Date.now();
    let thread = await readCodexThread(
      client,
      selectedId,
      DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
    );
    const initiallyBusy = thread.status?.type === "active";
    if (thread.status?.type === "active" && ifBusy === "fail")
      throw new Error(`target busy (--if-busy fail): ${selectedId}`);
    const busyDeadline = busyStarted + busyTimeoutMs;
    const busyError = () =>
      new Error(
        `target busy after ${Math.ceil(busyTimeoutMs / 1000)}s (--if-busy wait)`,
      );
    while (thread.status?.type === "active" && ifBusy === "wait") {
      const waitMs = Math.min(
        pollIntervalMs,
        Math.max(0, busyDeadline - Date.now()),
      );
      if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      const remainingMs = busyDeadline - Date.now();
      try {
        thread = await readCodexThread(
          client,
          selectedId,
          Math.min(
            DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
            Math.max(1, remainingMs),
          ),
        );
      } catch (error) {
        if (Date.now() >= busyDeadline) throw busyError();
        throw error;
      }
      if (Date.now() >= busyDeadline && thread.status?.type === "active")
        throw busyError();
    }
    const busyWaitedMs =
      ifBusy === "wait" && initiallyBusy ? Date.now() - busyStarted : 0;
    const resumed = await client.request(
      "thread/resume",
      { threadId: selectedId, excludeTurns: true },
      DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
    );
    const context = await readCodexContext(
      resumed?.thread?.path || thread.path,
      selectedId,
    );
    const guard = contextGuard("codex", context, {
      warnContextPct,
      maxContextPct,
    });
    if (guard.ok === false) {
      return {
        ...guard,
        status: "failed",
        done: false,
        cli: "codex",
        transport: "uds",
        threadId: selectedId,
      };
    }
    let activeTurns = null;
    if (resumed?.thread?.status?.type === "active")
      activeTurns = resumed.thread.turns?.length
        ? resumed.thread.turns
        : thread.turns;
    else if (!resumed?.thread && thread.status?.type === "active")
      activeTurns = thread.turns;
    const expectedTurnId =
      ifBusy === "steer"
        ? activeTurns?.findLast((turn) => turn.status === "inProgress")?.id
        : undefined;
    const turn = await runCodexAppServerTurn({
      client,
      threadId: selectedId,
      prompt,
      timeoutMs,
      maxTurnMs,
      expectedTurnId,
      noWait,
    });
    if (turn.message) throw new Error(turn.message);
    return {
      ...turn,
      ...context,
      ...guard,
      cli: "codex",
      transport: "uds",
      threadId: selectedId,
      turnId: turn.turnId,
      response: turn.response,
      done: turn.status === "completed",
      matchedCompletion: turn.matchedCompletion,
      ...(noWait ? {} : { timedOut: turn.timedOut }),
      ...(noWait ? { ok: true } : {}),
      status: turn.status,
      commentary: turn.commentary,
      meta: { retries: turn.retries },
      ifBusy,
      busyWaitedMs,
      steered: turn.steered,
      socketPath,
    };
  } finally {
    client.close();
  }
}

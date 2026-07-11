import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";

import { execute as defaultExecuteCodex } from "../codex-adapter.mjs";
import {
  createActivityLifecycle,
  isActivityLifecycleEnabled,
  resolveHardCeilingMs,
} from "../lib/worker-lifecycle.mjs";
import { JsonRpcWsUdsClient } from "../workers/lib/jsonrpc-ws-uds.mjs";
import {
  buildClaudePromptDispatchPayload,
  deriveClaudeDaemonPaths,
  dispatchClaudeDaemonJob,
  teardownClaudeDaemonJob,
} from "./claude-daemon-control.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_CODEX_APP_SERVER_UDS_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS = 12_000;

function requireEndpoint(endpoint, name) {
  if (!endpoint || typeof endpoint.ask !== "function") {
    throw new Error(`${name} endpoint with ask(prompt) is required`);
  }
  return endpoint;
}

function turn(endpoint, response, role) {
  return {
    role,
    endpoint: response.endpoint || endpoint.name || role,
    text: response.text || "",
    done: response.done === true,
    meta: response.meta || undefined,
  };
}

function codexLeadPrompt(task) {
  return `Lead as Codex. Create a concise plan for this task, then stop.\n\nTask:\n${task}`;
}

function claudeLeadPrompt(task) {
  return `Lead as Claude. Create a concise plan for this task, then stop.\n\nTask:\n${task}`;
}

function claudeReviewCodexPrompt(task, codexPlan) {
  return `Review Codex's plan for this task. Return risks and one improvement.\n\nTask:\n${task}\n\nCodex plan:\n${codexPlan}`;
}

function codexReviewClaudePrompt(task, claudePlan) {
  return `Review Claude's plan for this task. Return risks and one improvement.\n\nTask:\n${task}\n\nClaude plan:\n${claudePlan}`;
}

function codexFinalPrompt(task, codexPlan, claudeReview) {
  return `Finalize as Codex using Claude's review. Return the final orchestration decision.\n\nTask:\n${task}\n\nCodex plan:\n${codexPlan}\n\nClaude review:\n${claudeReview}`;
}

function claudeFinalPrompt(task, claudePlan, codexReview) {
  return `Finalize as Claude using Codex's review. Return the final orchestration decision.\n\nTask:\n${task}\n\nClaude plan:\n${claudePlan}\n\nCodex review:\n${codexReview}`;
}

function peerPrompt(agentName, task) {
  return `Act as a peer collaborator named ${agentName}. Independently answer this task in a concise way.\n\nTask:\n${task}`;
}

function peerSynthesisPrompt(task, claudeAnswer, codexAnswer) {
  return `Synthesize peer answers from Claude and Codex. Return the agreed next action and conflicts.\n\nTask:\n${task}\n\nClaude answer:\n${claudeAnswer}\n\nCodex answer:\n${codexAnswer}`;
}

export async function runUdsOrchestration({ mode, task, claude, codex } = {}) {
  const selectedMode = mode || "peer";
  const claudeEndpoint = requireEndpoint(claude, "claude");
  const codexEndpoint = requireEndpoint(codex, "codex");
  if (!task || typeof task !== "string") throw new Error("task is required");

  const turns = [];
  if (selectedMode === "codex-led") {
    const codexPlan = await codexEndpoint.ask(codexLeadPrompt(task), {
      mode: selectedMode,
      phase: "lead",
    });
    turns.push(turn(codexEndpoint, codexPlan, "lead"));

    const claudeReview = await claudeEndpoint.ask(
      claudeReviewCodexPrompt(task, codexPlan.text),
      { mode: selectedMode, phase: "review" },
    );
    turns.push(turn(claudeEndpoint, claudeReview, "review"));

    const final = await codexEndpoint.ask(
      codexFinalPrompt(task, codexPlan.text, claudeReview.text),
      { mode: selectedMode, phase: "final" },
    );
    turns.push(turn(codexEndpoint, final, "final"));
    return { mode: selectedMode, task, turns, final: turns.at(-1) };
  }

  if (selectedMode === "claude-led") {
    const claudePlan = await claudeEndpoint.ask(claudeLeadPrompt(task), {
      mode: selectedMode,
      phase: "lead",
    });
    turns.push(turn(claudeEndpoint, claudePlan, "lead"));

    const codexReview = await codexEndpoint.ask(
      codexReviewClaudePrompt(task, claudePlan.text),
      { mode: selectedMode, phase: "review" },
    );
    turns.push(turn(codexEndpoint, codexReview, "review"));

    const final = await claudeEndpoint.ask(
      claudeFinalPrompt(task, claudePlan.text, codexReview.text),
      { mode: selectedMode, phase: "final" },
    );
    turns.push(turn(claudeEndpoint, final, "final"));
    return { mode: selectedMode, task, turns, final: turns.at(-1) };
  }

  if (selectedMode === "peer") {
    const [claudePeer, codexPeer] = await Promise.all([
      claudeEndpoint.ask(peerPrompt("Claude", task), {
        mode: selectedMode,
        phase: "peer",
      }),
      codexEndpoint.ask(peerPrompt("Codex", task), {
        mode: selectedMode,
        phase: "peer",
      }),
    ]);
    turns.push(turn(claudeEndpoint, claudePeer, "peer"));
    turns.push(turn(codexEndpoint, codexPeer, "peer"));

    const final = await claudeEndpoint.ask(
      peerSynthesisPrompt(task, claudePeer.text, codexPeer.text),
      { mode: selectedMode, phase: "synthesis" },
    );
    turns.push(turn(claudeEndpoint, final, "synthesis"));
    return { mode: selectedMode, task, turns, final: turns.at(-1) };
  }

  throw new Error(`Unsupported UDS orchestration mode: ${selectedMode}`);
}

function scanMessage(message, marker, state, onActivity = () => {}) {
  const scan = (text) => {
    // Only stream/snapshot content advances liveness. "state" heartbeats do
    // not keep an otherwise silent turn alive forever.
    onActivity();
    state.streamBytes += Buffer.byteLength(text);
    state.stream.push(text);
    if (/⏺/.test(stripAnsi(text))) state.assistantStarted = true;
    if (state.assistantStarted && text.includes(marker)) {
      state.markerSeen = true;
    }
  };

  state.messageCount += 1;
  if (message.type === "snapshot") {
    for (const line of message.streamTail || []) scan(line);
  } else if (message.type === "stream" && typeof message.line === "string") {
    scan(message.line);
  } else if (message.type === "state") {
    state.stateCount += 1;
  } else if (message.type === "settled") {
    state.settled = message.outcome || "settled";
  }
}

export function subscribeClaudeUntilMarker(
  controlSock,
  short,
  marker,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxTurnMs = Math.min(resolveHardCeilingMs(), 15 * 60_000),
  } = {},
) {
  return new Promise((resolve) => {
    const socket = net.connect(controlSock);
    let data = "";
    let finished = false;
    const startedAt = Date.now();
    const state = {
      short,
      marker,
      markerSeen: false,
      settled: null,
      messageCount: 0,
      stateCount: 0,
      streamBytes: 0,
      stream: [],
      assistantStarted: false,
    };
    const activityEnabled = isActivityLifecycleEnabled();
    const lifecycle = createActivityLifecycle({
      enabled: activityEnabled,
      interventionMs: timeoutMs,
      hardCeilingMs: maxTurnMs,
    });
    let timer = null;

    const armTimer = () => {
      timer = setTimeout(async () => {
        if (!activityEnabled) return finish({ timedOut: true });
        const reason = await lifecycle.check();
        if (reason) return finish({ timedOut: true, timeoutReason: reason });
        armTimer();
      }, timeoutMs);
    };
    armTimer();

    function finish(extra = {}) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ...state, elapsedMs: Date.now() - startedAt, ...extra });
    }

    socket.on("error", (error) => finish({ error: error.message }));
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ proto: 1, op: "subscribe", short, tail: 80, marker })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
      while (data.includes("\n")) {
        const index = data.indexOf("\n");
        const line = data.slice(0, index).trim();
        data = data.slice(index + 1);
        if (!line) continue;
        try {
          scanMessage(JSON.parse(line), marker, state, () =>
            lifecycle.observe(),
          );
        } catch (_error) {
          state.messageCount += 1;
        }
        if (state.markerSeen || state.settled) finish();
      }
    });
    socket.on("close", () => finish({ closed: true }));
  });
}

export function stripAnsi(text) {
  return String(text)
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[78]/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function isClaudeUdsNoiseLine(line) {
  return (
    /Claude Code|Opus|remote-control|Brewed|Baked|Cogitated|Crunched|▐|▛|▜|▝|▘|Max|context/.test(
      line,
    ) ||
    /^[╭╮╰╯│─┌┐└┘├┤┬┴┼\s]+$/.test(line) ||
    /^\s*[❯✳✻]\s*/.test(line)
  );
}

export function extractClaudeUdsText(text, marker) {
  const cleaned = stripAnsi(String(text).replaceAll(marker, "")).replace(
    /\r/g,
    "\n",
  );
  const lines = cleaned
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const assistantIndex = lines.findLastIndex((line) => /^\s*⏺\s*/.test(line));
  if (assistantIndex >= 0) {
    const useful = lines
      .slice(assistantIndex)
      .map((line, index) => (index === 0 ? line.replace(/^\s*⏺\s*/, "") : line))
      .filter((line) => !isClaudeUdsNoiseLine(line));
    return useful.join("\n").trim();
  }
  const useful = lines.filter((line) => !isClaudeUdsNoiseLine(line));
  return useful.at(-1)?.trim() || cleaned.trim();
}

export function createClaudeUdsEndpoint({
  controlSock,
  daemonPaths = deriveClaudeDaemonPaths(),
  cwd = process.cwd(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxTurnMs = Math.min(resolveHardCeilingMs(), 15 * 60_000),
  markerFactory = () =>
    `TFX_UDS_ORCH_DONE_${crypto.randomBytes(6).toString("hex")}`,
  shortFactory,
  sessionIdFactory,
  dispatchDaemonJob = dispatchClaudeDaemonJob,
  teardownDaemonJob = teardownClaudeDaemonJob,
} = {}) {
  const sock = controlSock || daemonPaths.controlSock;
  return {
    name: "claude-uds",
    async ask(prompt, meta = {}) {
      const marker = markerFactory();
      const wrappedPrompt = `${prompt}\n\nWhen finished, print this exact completion marker on its own line: ${marker}`;
      const name =
        meta.name ||
        `tfx uds ${meta.mode || "orchestration"} ${meta.phase || "ask"}`;
      const payload = buildClaudePromptDispatchPayload({
        short: shortFactory?.(),
        sessionId: sessionIdFactory?.(),
        cwd,
        prompt: wrappedPrompt,
        name,
      });
      const dispatch = await dispatchDaemonJob({
        paths: daemonPaths,
        controlSock: sock,
        payload,
        agent: "claude",
        name,
        cwd,
        dispatchTimeoutMs: 5000,
      });
      const subscription = await subscribeClaudeUntilMarker(
        sock,
        payload.short,
        marker,
        { timeoutMs, maxTurnMs },
      );
      await teardownDaemonJob({
        controlSock: sock,
        paths: daemonPaths,
        short: payload.short,
        sessionProjectionPath: dispatch.sessionProjectionPath,
        sessionId: payload.sessionId,
      });
      return {
        endpoint: "claude-uds",
        text: extractClaudeUdsText(subscription.stream.join(""), marker),
        done: subscription.markerSeen === true,
        dispatch,
        subscription: {
          markerSeen: subscription.markerSeen,
          elapsedMs: subscription.elapsedMs,
          messageCount: subscription.messageCount,
          streamBytes: subscription.streamBytes,
          timedOut: subscription.timedOut === true,
          settled: subscription.settled,
        },
        cleanup: { ok: true },
        meta: { short: payload.short, marker },
      };
    },
  };
}

export function createCodexExecEndpoint({
  executeCodex = defaultExecuteCodex,
  workdir = process.cwd(),
  timeout = 120_000,
  profile,
} = {}) {
  return {
    name: "codex",
    async ask(prompt) {
      const result = await executeCodex({ prompt, workdir, timeout, profile });
      if (result?.ok === false) {
        throw new Error(
          `Codex exec failed: ${result.stderr || result.error || "unknown error"}`,
        );
      }
      return {
        endpoint: "codex",
        text: String(
          result?.output ?? result?.stdout ?? result?.text ?? "",
        ).trim(),
        done: true,
      };
    },
  };
}

function extractCodexThreadId(result) {
  if (!result || typeof result !== "object") return null;
  if (typeof result.threadId === "string") return result.threadId;
  if (result.thread && typeof result.thread.id === "string") {
    return result.thread.id;
  }
  return null;
}

async function waitForSocketFile(sockPath, deadlineMs) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      if ((await stat(sockPath)).isSocket()) return true;
    } catch {
      /* not bound yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * SIGTERM a child, wait up to graceMs for it to actually exit, then SIGKILL if
 * still alive. Liveness is `exitCode === null && signalCode === null` — NOT
 * `child.killed`, which only means "a signal was sent" and would suppress the
 * SIGKILL fallback when the child ignores SIGTERM.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [graceMs]
 */
async function terminateChild(child, graceMs = 1000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once("exit", () => resolve("exited"));
  });
  try {
    child.kill("SIGTERM");
  } catch {}
  const outcome = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve("timeout"), graceMs)),
  ]);
  if (
    outcome !== "exited" &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
}

/**
 * Experimental Codex endpoint that drives a real `codex app-server` over its
 * WebSocket-over-Unix-Domain-Socket control plane (the symmetric peer of the
 * Claude daemon `control.sock` path). Same `ask(prompt) -> {endpoint,text,done}`
 * contract as `createCodexExecEndpoint`, so it is a drop-in for
 * `runUdsOrchestration`'s `codex` slot — but it is NOT the default.
 *
 * Two modes:
 *   - spawnServer (default): mkdtemp a private socket, spawn
 *     `codex app-server --listen unix://PATH`, attach, run one turn, tear down.
 *   - attach (socketPath + spawnServer=false): connect to an already-running
 *     daemon socket (e.g. $CODEX_HOME/app-server-control/app-server-control.sock).
 *
 * Wire transport proven against codex-cli 0.135.0 — see
 * experiments/native-bridge-feasibility/codex-app-server-uds-smoke.mjs.
 *
 * @param {object} [options]
 * @param {string|null} [options.socketPath] Existing daemon socket to attach to.
 * @param {boolean} [options.spawnServer] Spawn a private app-server (default true).
 * @param {string} [options.codexBin]
 * @param {string} [options.cwd]
 * @param {string} [options.model]
 * @param {number} [options.timeoutMs] Turn timeout.
 * @param {number} [options.bootstrapTimeoutMs] Connect + handshake timeout.
 * @param {(opts: object) => JsonRpcWsUdsClient} [options.clientFactory]
 * @param {(command: string, args: string[], options: object) => import('node:child_process').ChildProcess} [options.spawnFn]
 */
export function createCodexAppServerUdsEndpoint({
  socketPath = null,
  spawnServer = true,
  codexBin = process.env.CODEX_BIN || "codex",
  cwd = process.cwd(),
  model,
  timeoutMs = DEFAULT_CODEX_APP_SERVER_UDS_TIMEOUT_MS,
  maxTurnMs = Math.min(resolveHardCeilingMs(), 15 * 60_000),
  bootstrapTimeoutMs = DEFAULT_CODEX_APP_SERVER_UDS_BOOTSTRAP_MS,
  clientFactory = (opts) => new JsonRpcWsUdsClient(opts),
  spawnFn = spawn,
} = {}) {
  return {
    name: "codex-app-server-uds",
    async ask(prompt, _meta = {}) {
      if (typeof prompt !== "string" || !prompt.trim()) {
        throw new Error(
          "codex-app-server-uds endpoint requires a non-empty prompt",
        );
      }

      let dir = null;
      let child = null;
      let client = null;
      let resolvedSock = socketPath;

      try {
        if (spawnServer && !socketPath) {
          dir = await mkdtemp(pathJoin(tmpdir(), "tfx-codex-appserver-uds-"));
          resolvedSock = pathJoin(dir, "app-server.sock");
          child = spawnFn(
            codexBin,
            ["app-server", "--listen", `unix://${resolvedSock}`],
            { stdio: ["ignore", "pipe", "pipe"], cwd, env: process.env },
          );
          let stderr = "";
          child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
            if (stderr.length > 8000) stderr = stderr.slice(-8000);
          });
          const earlyExit = new Promise((resolve) => {
            child.once("error", (err) =>
              resolve(`spawn error: ${err.message}`),
            );
            child.once("exit", (code, sig) =>
              resolve(`exited early code=${code} sig=${sig || ""}`),
            );
          });
          const ready = await Promise.race([
            waitForSocketFile(resolvedSock, bootstrapTimeoutMs).then((ok) =>
              ok ? "ready" : "no-socket",
            ),
            earlyExit,
          ]);
          if (ready !== "ready") {
            throw new Error(
              `codex app-server did not bind socket: ${ready}${
                stderr ? ` — ${stderr.slice(-400)}` : ""
              }`,
            );
          }
        }
        if (!resolvedSock) {
          throw new Error(
            "codex-app-server-uds endpoint needs socketPath or spawnServer=true",
          );
        }

        client = clientFactory({
          socketPath: resolvedSock,
          connectTimeoutMs: bootstrapTimeoutMs,
        });
        await client.connect();
        await client.request(
          "initialize",
          { clientInfo: { name: "triflux-tfx-live", version: "1.0.0" } },
          bootstrapTimeoutMs,
        );
        client.notify("initialized", {});

        const threadParams = {
          sandbox: "read-only",
          approvalPolicy: "never",
          ephemeral: true,
        };
        if (typeof model === "string" && model) threadParams.model = model;
        if (cwd) threadParams.cwd = cwd;
        const threadStart = await client.request(
          "thread/start",
          threadParams,
          bootstrapTimeoutMs,
        );
        const threadId = extractCodexThreadId(threadStart);
        if (!threadId) {
          throw new Error(
            "codex app-server thread/start returned no thread id",
          );
        }

        const parts = [];
        let offDelta = () => {};
        let offError = () => {};
        let offDone = () => {};
        let offActivity = () => {};
        const cleanup = () => {
          offDelta();
          offError();
          offDone();
          offActivity();
        };
        const completion = new Promise((resolve) => {
          offDelta = client.onNotification(
            "item/agentMessage/delta",
            (params) => {
              if (typeof params?.delta === "string") parts.push(params.delta);
            },
          );
          offError = client.onNotification("error", (params) => {
            cleanup();
            resolve({
              status: "failed",
              message: params?.message || "codex app-server error",
            });
          });
          offDone = client.onNotification("turn/completed", (params) => {
            cleanup();
            resolve({ status: params?.turn?.status || "unknown" });
          });
        });

        await client.request(
          "turn/start",
          { threadId, input: [{ type: "text", text: prompt }] },
          timeoutMs,
        );
        const activityEnabled = isActivityLifecycleEnabled();
        const lifecycle = createActivityLifecycle({
          enabled: activityEnabled,
          interventionMs: timeoutMs,
          hardCeilingMs: maxTurnMs,
        });
        offActivity = client.onNotification("*", () => lifecycle.observe());
        let timeoutHandle = null;
        const timeoutPromise = new Promise((resolve) => {
          const arm = () => {
            timeoutHandle = setTimeout(async () => {
              if (!activityEnabled) {
                cleanup();
                resolve({ status: "timeout" });
                return;
              }
              const reason = await lifecycle.check();
              if (reason) {
                cleanup();
                resolve({ status: "timeout", reason });
                return;
              }
              arm();
            }, timeoutMs);
          };
          arm();
        });
        let settled;
        try {
          settled = await Promise.race([completion, timeoutPromise]);
        } finally {
          // Clear the timer whichever side won, so a completed turn does not
          // keep the event loop alive until timeoutMs.
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        return {
          endpoint: "codex-app-server-uds",
          text: parts.join("").trim(),
          done: settled.status === "completed",
          meta: {
            threadId,
            status: settled.status,
            socketPath: resolvedSock,
            spawned: Boolean(child),
            ...(settled.message ? { error: settled.message } : {}),
          },
        };
      } finally {
        try {
          client?.close();
        } catch {}
        if (child) await terminateChild(child);
        if (dir)
          await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

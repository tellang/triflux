import crypto from "node:crypto";
import net from "node:net";

import { execute as defaultExecuteCodex } from "../codex-adapter.mjs";
import {
  buildClaudePromptDispatchPayload,
  deriveClaudeDaemonPaths,
  dispatchClaudeDaemonJob,
  teardownClaudeDaemonJob,
} from "./claude-daemon-control.mjs";

const DEFAULT_TIMEOUT_MS = 90_000;

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

function scanMessage(message, marker, state) {
  const scan = (text) => {
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
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
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
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs);

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
          scanMessage(JSON.parse(line), marker, state);
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
        { timeoutMs },
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

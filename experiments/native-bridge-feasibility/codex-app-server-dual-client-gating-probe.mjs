#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JsonRpcWsUdsClient } from "../../hub/workers/lib/jsonrpc-ws-uds.mjs";
import {
  capturePsmuxPane,
  createPsmuxSession,
  hasMultiplexer,
  killPsmuxSession,
  psmuxExec,
  psmuxSessionExists,
  sendKeysToPane,
} from "../../hub/team/psmux.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(
  HERE,
  "codex-app-server-dual-client-gating-latest-report.json",
);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const RUN_REAL_PROBE =
  process.env.TFX_RUN_REAL_CODEX_DUAL_CLIENT_GATE === "1";
const REPO_ROOT = dirname(dirname(HERE));
const DEFAULT_TIMEOUT_MS = Number.parseInt(
  process.env.TFX_CODEX_DUAL_CLIENT_TIMEOUT_MS || "90000",
  10,
);
const TUI_STATE_TIMEOUT_MS = Number.parseInt(
  process.env.TFX_CODEX_DUAL_CLIENT_TUI_STATE_TIMEOUT_MS || "120000",
  10,
);
const SYNC_REPETITIONS = Number.parseInt(
  process.env.TFX_CODEX_DUAL_CLIENT_SYNC_REPETITIONS || "5",
  10,
);
const TUI_POLL_MS = 250;

function nowIso() {
  return new Date().toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeNonce(prefix) {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function pathKind(path) {
  try {
    const info = await stat(path);
    if (info.isSocket()) return "socket";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "other";
  } catch {
    return "missing";
  }
}

async function waitForSocket(sockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await pathKind(sockPath)) === "socket") return true;
    await delay(100);
  }
  return false;
}

function extractThreadId(result) {
  if (typeof result?.threadId === "string") return result.threadId;
  if (typeof result?.thread?.id === "string") return result.thread.id;
  return null;
}

function extractTurnId(result) {
  if (typeof result?.turnId === "string") return result.turnId;
  if (typeof result?.turn?.id === "string") return result.turn.id;
  return null;
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function getThread(history) {
  return history?.thread && typeof history.thread === "object"
    ? history.thread
    : history;
}

function userMessageText(item) {
  if (item?.type !== "userMessage" || !Array.isArray(item.content)) return "";
  return extractText(item.content);
}

export function correlateNonce(history, nonce) {
  const thread = getThread(history);
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      const text = userMessageText(item);
      if (!text.includes(nonce)) continue;
      return {
        threadId: thread?.id || null,
        turnId: turn?.id || null,
        turnStatus: turn?.status || null,
        itemId: item?.id || null,
        clientUserMessageId: item?.clientId || null,
        text,
      };
    }
  }
  return null;
}

export function classifyCollision(history, programNonce, humanNonce) {
  const program = correlateNonce(history, programNonce);
  const human = correlateNonce(history, humanNonce);
  if (program && human && program.turnId === human.turnId) return "steer";
  if (program && human) return "queue";
  return "reject";
}

export function classifyTuiPaneState(text) {
  const paneText = String(text || "")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-18)
    .join("\n");
  const working = /\bWorking \(/iu.test(paneText);
  const interruptHint = /esc to interrupt/iu.test(paneText);
  const queueHint = /tab to queue message/iu.test(paneText);
  const composerVisible = /(?:^|\n)\s*›\s/u.test(paneText);
  const busy = working || interruptHint || queueHint;
  return {
    busy,
    working,
    interruptHint,
    queueHint,
    composerVisible,
    notBusy: composerVisible && !busy,
  };
}

export function summarizeLatencyMs(measurements) {
  const valuesMs = measurements
    .map((measurement) => measurement?.latencyMs)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const middle = Math.floor(valuesMs.length / 2);
  const medianMs = valuesMs.length === 0
    ? null
    : valuesMs.length % 2 === 1
      ? valuesMs[middle]
      : (valuesMs[middle - 1] + valuesMs[middle]) / 2;
  return {
    repetitions: measurements.length,
    completed: valuesMs.length,
    timedOut: measurements.filter((measurement) => measurement?.timedOut)
      .length,
    medianMs,
    maxMs: valuesMs.length > 0 ? valuesMs.at(-1) : null,
    valuesMs,
  };
}

function countNonce(history, nonce) {
  const thread = getThread(history);
  let count = 0;
  for (const turn of thread?.turns || []) {
    for (const item of turn?.items || []) {
      if (userMessageText(item).includes(nonce)) count += 1;
    }
  }
  return count;
}

function turnStatus(history, turnId) {
  const thread = getThread(history);
  return (
    (thread?.turns || []).find((turn) => turn?.id === turnId)?.status || null
  );
}

function historyCorrelationMap(history) {
  const thread = getThread(history);
  const byTurn = new Map();
  for (const turn of thread?.turns || []) {
    const ids = [];
    for (const item of turn?.items || []) {
      if (item?.type !== "userMessage") continue;
      if (typeof item.clientId === "string" && item.clientId) {
        ids.push(item.clientId);
      }
    }
    byTurn.set(turn?.id, [...new Set(ids)]);
  }
  return byTurn;
}

function classify(status, evidence, blocker = null) {
  return { status, evidence, blocker };
}

function eventSummary(method, params, phase, threadIdFallback) {
  const item = params?.item;
  const turn = params?.turn;
  const text = userMessageText(item);
  return {
    at: nowIso(),
    phase,
    kind: "notification",
    method,
    threadId:
      params?.threadId || params?.thread?.id || threadIdFallback || null,
    turnId: params?.turnId || turn?.id || null,
    clientUserMessageId:
      params?.clientUserMessageId ||
      (typeof item?.clientId === "string" ? item.clientId : null),
    clientUserMessageIds: [],
    itemId: params?.itemId || item?.id || null,
    itemType: item?.type || null,
    turnStatus: turn?.status || null,
    text: text || null,
    delta: typeof params?.delta === "string" ? params.delta : null,
    message: typeof params?.message === "string" ? params.message : null,
    error: params?.error || turn?.error || null,
  };
}

class RecordingJsonRpcWsUdsClient extends JsonRpcWsUdsClient {
  constructor(options, onServerRequest) {
    super(options);
    this._probeOnServerRequest = onServerRequest;
  }

  _handleInboundMessage(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      super._handleInboundMessage(line);
      return;
    }
    if (
      frame &&
      typeof frame === "object" &&
      Object.hasOwn(frame, "id") &&
      typeof frame.method === "string"
    ) {
      this._probeOnServerRequest?.(frame);
      return;
    }
    super._handleInboundMessage(line);
  }

  respondToServerRequest(id, result) {
    this._sendText(JSON.stringify({ id, result }));
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { signal: null, forced: false };
  }
  let forced = false;
  try {
    child.kill("SIGTERM");
  } catch {}
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(1200).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    forced = true;
    try {
      child.kill("SIGKILL");
    } catch {}
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(800),
    ]);
  }
  return { signal: child.signalCode || null, forced };
}

async function main() {
  const report = {
    kind: "codex-app-server-same-thread-dual-client-gating-probe",
    schemaVersion: "tfx.codex-dual-client-gate.v2",
    startedAt: nowIso(),
    realTurnsEnabled: RUN_REAL_PROBE,
    codexBin: CODEX_BIN,
    repo: REPO_ROOT,
    server: {
      argv: null,
      pid: null,
      socketPath: null,
      ready: false,
      stderrTail: "",
    },
    controller: {
      label: "A",
      initialize: null,
      errors: [],
      serverRequests: [],
    },
    thread: {
      id: null,
      startResponse: null,
      ephemeral: false,
      materialization: null,
    },
    tui: {
      sessions: [],
      currentPane: null,
      launchArgv: null,
      readiness: [],
    },
    actions: [],
    events: [],
    paneCaptures: [],
    tuiStateMeasurements: [],
    historySnapshots: [],
    scenarios: {},
    checks: {},
    priorRunAssessment: null,
    verdict: null,
    cleanup: {
      ownedSessions: [],
      killedSessions: [],
      remainingSessions: [],
      appServerStop: null,
      appServerExited: false,
      socketAfterCleanup: null,
      tempDirAfterCleanup: null,
    },
    fatalError: null,
  };

  let tempDir = null;
  let sockPath = null;
  let server = null;
  let serverStderr = "";
  let client = null;
  let currentPhase = "bootstrap";
  let currentPane = null;
  let threadId = null;
  const ownedSessions = new Set();
  const programClientIds = new Map();

  const addAction = (action) => {
    const entry = { at: nowIso(), phase: currentPhase, ...action };
    report.actions.push(entry);
    return entry;
  };

  const rpc = async (method, params, timeoutMs = DEFAULT_TIMEOUT_MS) => {
    const action = addAction({
      client: "A",
      kind: "rpc-request",
      method,
      threadId: params?.threadId || threadId || null,
      turnId: params?.turnId || null,
      clientUserMessageId: params?.clientUserMessageId || null,
      params,
      outcome: null,
    });
    try {
      const result = await client.request(method, params, timeoutMs);
      action.outcome = "result";
      action.result = result;
      action.completedAt = nowIso();
      return result;
    } catch (error) {
      action.outcome = "error";
      action.error = error instanceof Error ? error.message : String(error);
      action.errorCode = error?.code ?? null;
      action.completedAt = nowIso();
      throw error;
    }
  };

  const capturePane = (label, lines = 220) => {
    const text = currentPane ? capturePsmuxPane(currentPane, lines) : "";
    const capture = {
      at: nowIso(),
      phase: currentPhase,
      label,
      pane: currentPane,
      text,
    };
    report.paneCaptures.push(capture);
    return capture;
  };

  const paneTail = (text, lines = 24) =>
    String(text || "").split("\n").slice(-lines).join("\n");

  const capturePaneState = (label, storeCapture = true) => {
    const text = currentPane ? capturePsmuxPane(currentPane, 120) : "";
    const state = classifyTuiPaneState(text);
    const capture = {
      at: nowIso(),
      phase: currentPhase,
      label,
      pane: currentPane,
      state,
      text,
    };
    if (storeCapture) report.paneCaptures.push(capture);
    return capture;
  };

  const waitForTuiState = async ({
    label,
    predicate,
    expected,
    timeoutMs = TUI_STATE_TIMEOUT_MS,
    sinceAt = null,
    stableMs = 0,
  }) => {
    const startedAt = nowIso();
    const deadline = Date.now() + timeoutMs;
    const transitions = [];
    let lastSignature = null;
    let polls = 0;
    let latest = null;
    let matchingSinceMs = null;
    while (Date.now() < deadline) {
      polls += 1;
      latest = capturePaneState(`${label}-poll`, false);
      const signature = JSON.stringify(latest.state);
      if (signature !== lastSignature) {
        transitions.push({
          at: latest.at,
          state: latest.state,
          tail: paneTail(latest.text),
        });
        lastSignature = signature;
      }
      if (predicate(latest.state)) {
        if (matchingSinceMs === null) matchingSinceMs = Date.now();
      } else {
        matchingSinceMs = null;
      }
      if (
        matchingSinceMs !== null &&
        Date.now() - matchingSinceMs >= stableMs
      ) {
        const resolved = capturePaneState(`${label}-${expected}`);
        const resolvedAt = resolved.at;
        const measurement = {
          phase: currentPhase,
          label,
          expected,
          startedAt,
          sinceAt,
          resolvedAt,
          latencyMs: new Date(resolvedAt).getTime() -
            new Date(sinceAt || startedAt).getTime(),
          timedOut: false,
          timeoutMs,
          stableMs,
          polls,
          initialState: transitions[0]?.state || null,
          finalState: resolved.state,
          transitions,
          finalCaptureLabel: resolved.label,
        };
        report.tuiStateMeasurements.push(measurement);
        return measurement;
      }
      await delay(TUI_POLL_MS);
    }
    const timedOut = capturePaneState(`${label}-timeout`);
    const measurement = {
      phase: currentPhase,
      label,
      expected,
      startedAt,
      sinceAt,
      resolvedAt: null,
      latencyMs: null,
      timedOut: true,
      timeoutMs,
      stableMs,
      polls,
      initialState: transitions[0]?.state || null,
      finalState: timedOut.state,
      transitions,
      finalCaptureLabel: timedOut.label,
    };
    report.tuiStateMeasurements.push(measurement);
    addAction({
      client: "probe",
      kind: "wait-timeout",
      label: `${label}: TUI did not become ${expected}`,
      timeoutMs,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
    return measurement;
  };

  const waitForTuiNotBusy = (label, options = {}) =>
    waitForTuiState({
      label,
      expected: "not-busy",
      predicate: (state) => state.notBusy,
      stableMs: 750,
      ...options,
    });

  const waitForTuiBusy = (label, options = {}) =>
    waitForTuiState({
      label,
      expected: "busy",
      predicate: (state) => state.busy,
      ...options,
    });

  const readHistory = async (label, store = true) => {
    const result = await rpc(
      "thread/read",
      { threadId, includeTurns: true },
      20_000,
    );
    if (store) {
      report.historySnapshots.push({
        at: nowIso(),
        phase: currentPhase,
        label,
        threadId,
        result,
      });
    }
    return result;
  };

  const waitForEvent = async (predicate, afterIndex, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = report.events.slice(afterIndex).find(predicate);
      if (match) return match;
      await delay(50);
    }
    addAction({
      client: "probe",
      kind: "wait-timeout",
      label,
      afterEventIndex: afterIndex,
      timeoutMs,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
    return null;
  };

  const waitForCondition = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await predicate();
      if (value) return value;
      await delay(50);
    }
    addAction({
      client: "probe",
      kind: "wait-timeout",
      label,
      timeoutMs,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
    return null;
  };

  const waitForHistoryNonce = async (nonce, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let history = null;
    while (Date.now() < deadline) {
      try {
        history = await readHistory(`poll-${nonce}`, false);
        const correlation = correlateNonce(history, nonce);
        if (correlation) return { history, correlation };
      } catch {}
      await delay(500);
    }
    return { history, correlation: null };
  };

  const waitForHistoryTurnEnd = async (turnIdToWait, timeoutMs) => {
    if (!turnIdToWait) return { history: null, status: null };
    const deadline = Date.now() + timeoutMs;
    let history = null;
    let status = null;
    while (Date.now() < deadline) {
      try {
        history = await readHistory(`poll-turn-${turnIdToWait}`, false);
        status = turnStatus(history, turnIdToWait);
        if (status && status !== "inProgress") return { history, status };
      } catch {}
      await delay(250);
    }
    return { history, status };
  };

  const waitForTurnEnd = async (turnIdToWait, afterIndex, timeoutMs) => {
    if (!turnIdToWait) return null;
    return waitForEvent(
      (event) =>
        event.method === "turn/completed" && event.turnId === turnIdToWait,
      afterIndex,
      timeoutMs,
      `turn/completed ${turnIdToWait}`,
    );
  };

  const waitForHumanTurnEvidence = async (
    nonce,
    afterIndex,
    timeoutMs,
    label,
  ) => {
    const deadline = Date.now() + timeoutMs;
    let history = null;
    while (Date.now() < deadline) {
      const itemEvent = report.events.slice(afterIndex).find(
        (event) =>
          event.itemType === "userMessage" && event.text?.includes(nonce),
      ) || null;
      try {
        history = await readHistory(`poll-human-${nonce}`, false);
      } catch {}
      const correlation = correlateNonce(history, nonce);
      if (itemEvent || correlation) {
        return { itemEvent, history, correlation };
      }
      await delay(250);
    }
    addAction({
      client: "probe",
      kind: "wait-timeout",
      label,
      afterEventIndex: afterIndex,
      timeoutMs,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
    return { itemEvent: null, history, correlation: null };
  };

  const humanLifecycle = (nonce, afterIndex, turnId) => {
    const events = report.events.slice(afterIndex);
    return {
      turnStarted: events.find(
        (event) => event.method === "turn/started" && event.turnId === turnId,
      ) || null,
      userItem: events.find(
        (event) =>
          event.itemType === "userMessage" && event.text?.includes(nonce),
      ) || null,
      turnCompleted: events.find(
        (event) => event.method === "turn/completed" && event.turnId === turnId,
      ) || null,
    };
  };

  const launchTui = async (suffix) => {
    const sessionName = `tfx-codex-dual-gate-${process.pid}-${suffix}`;
    if (psmuxSessionExists(sessionName)) {
      throw new Error(`owned session name unexpectedly exists: ${sessionName}`);
    }
    const created = createPsmuxSession(sessionName, {
      layout: "1xN",
      paneCount: 1,
    });
    psmuxExec([
      "set-window-option",
      "-t",
      `${sessionName}:0`,
      "remain-on-exit",
      "on",
    ]);
    ownedSessions.add(sessionName);
    report.cleanup.ownedSessions.push(sessionName);
    report.tui.sessions.push({
      sessionName,
      panes: created.panes,
      attachedAt: nowIso(),
    });
    currentPane = created.panes[0];
    report.tui.currentPane = currentPane;
    const remote = `unix://${sockPath}`;
    const argv = [
      CODEX_BIN,
      "resume",
      threadId,
      "--remote",
      remote,
      "--no-alt-screen",
    ];
    report.tui.launchArgv = argv;
    const command = `cd ${shellQuote(REPO_ROOT)} && exec ${argv
      .map(shellQuote)
      .join(" ")}`;
    sendKeysToPane(currentPane, command, true);
    addAction({
      client: "TUI",
      kind: "launch",
      sessionName,
      pane: currentPane,
      argv,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
    const deadline = Date.now() + 25_000;
    let readyText = "";
    while (Date.now() < deadline) {
      readyText = capturePsmuxPane(currentPane, 80);
      if (/›|OpenAI Codex|for shortcuts|Tip:/iu.test(readyText)) break;
      await delay(250);
    }
    const readyCapture = {
      at: nowIso(),
      phase: currentPhase,
      label: `tui-ready-${suffix}`,
      pane: currentPane,
      text: readyText,
    };
    report.paneCaptures.push(readyCapture);
    report.tui.readiness.push({
      suffix,
      ready: /›|OpenAI Codex|for shortcuts|Tip:/iu.test(
        readyCapture?.text || "",
      ),
      captureLabel: readyCapture?.label || null,
      paneState: psmuxExec([
        "list-panes",
        "-t",
        sessionName,
        "-F",
        "#{pane_dead} #{pane_dead_status} #{pane_current_command}",
      ]),
    });
    if (!report.tui.readiness.at(-1).ready) {
      throw new Error(
        `TUI did not become ready in ${sessionName}: ${readyText.slice(-1200)}`,
      );
    }
    return { sessionName, pane: currentPane, capture: readyCapture };
  };

  const killOwnedTui = (sessionName, reason) => {
    addAction({
      client: "probe",
      kind: "tui-detach",
      sessionName,
      reason,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
    killPsmuxSession(sessionName);
    report.cleanup.killedSessions.push(sessionName);
    currentPane = null;
    report.tui.currentPane = null;
  };

  const sendTuiText = (text, label) => {
    if (!currentPane) throw new Error(`no TUI pane for ${label}`);
    const sentAt = nowIso();
    sendKeysToPane(currentPane, text, true);
    return addAction({
      client: "TUI",
      kind: "direct-input",
      label,
      text,
      pane: currentPane,
      sentAt,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
  };

  const stageTuiText = (text, label) => {
    if (!currentPane) throw new Error(`no TUI pane for ${label}`);
    const stagedAt = nowIso();
    sendKeysToPane(currentPane, text, false);
    return addAction({
      client: "TUI",
      kind: "staged-input",
      label,
      text,
      pane: currentPane,
      stagedAt,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
  };

  const sendTuiKey = (key, label) => {
    if (!currentPane) throw new Error(`no TUI pane for ${label}`);
    psmuxExec(["send-keys", "-t", currentPane, key]);
    addAction({
      client: "TUI",
      kind: "key",
      label,
      key,
      pane: currentPane,
      threadId,
      turnId: null,
      clientUserMessageId: null,
    });
  };

  const startProgramTurn = async (
    prompt,
    clientUserMessageId,
    overrides = {},
  ) => {
    const response = await rpc(
      "turn/start",
      {
        threadId,
        input: [{ type: "text", text: prompt }],
        clientUserMessageId,
        effort: "low",
        ...overrides,
      },
      30_000,
    );
    const turnId = extractTurnId(response);
    if (turnId) programClientIds.set(turnId, clientUserMessageId);
    return { response, turnId };
  };

  const runScenario = async (name, fn) => {
    currentPhase = name;
    try {
      report.scenarios[name] = await fn();
    } catch (error) {
      report.scenarios[name] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return report.scenarios[name];
  };

  try {
    const previous = JSON.parse(await readFile(REPORT_PATH, "utf8"));
    const previousCompleted =
      previous?.scenarios?.program_to_tui_and_history?.completed?.at || null;
    const previousInput = previous?.actions?.find(
      (action) =>
        action?.phase === "human_to_controller_and_history" &&
        action?.kind === "direct-input" &&
        action?.label === "H1 direct input",
    ) || null;
    const previousReady = previous?.paneCaptures?.find(
      (capture) => capture?.label === "tui-ready-h1",
    ) || null;
    const previousAfter = previous?.paneCaptures?.find(
      (capture) => capture?.label === "after-H1",
    ) || null;
    if (
      previous?.schemaVersion === "tfx.codex-dual-client-gate.v1" &&
      previousCompleted &&
      previousInput &&
      previousReady &&
      previousAfter
    ) {
      const inputAt = previousInput.sentAt || previousInput.at;
      report.priorRunAssessment = {
        sourceSchemaVersion: previous.schemaVersion,
        controllerP1CompletedAt: previousCompleted,
        tuiReadyBeforeH1At: previousReady.at,
        tuiReadyBeforeH1State: classifyTuiPaneState(previousReady.text),
        h1InputSentAt: inputAt,
        afterH1CaptureAt: previousAfter.at,
        afterH1CaptureState: classifyTuiPaneState(previousAfter.text),
        controllerCompletionToInputMs:
          new Date(inputAt).getTime() - new Date(previousCompleted).getTime(),
        inputToBusyCaptureMs:
          new Date(previousAfter.at).getTime() - new Date(inputAt).getTime(),
        conclusion:
          "the prior raw report does not show H1 being typed while busy: its immediate pre-input readiness capture was not-busy, while the Working capture was taken later after H1 submission; that Working state cannot be attributed to P1 from the prior evidence alone",
      };
    }
  } catch {}

  try {
    if (!RUN_REAL_PROBE) {
      report.verdict =
        "SKIPPED: set TFX_RUN_REAL_CODEX_DUAL_CLIENT_GATE=1 to run model/TUI turns";
      return;
    }
    if (!hasMultiplexer()) {
      throw new Error("tmux/psmux primary multiplexer is unavailable");
    }

    tempDir = await mkdtemp(join(tmpdir(), "tfx-codex-dual-gate-"));
    sockPath = join(tempDir, "app-server.sock");
    report.server.socketPath = sockPath;
    report.server.argv = ["app-server", "--listen", `unix://${sockPath}`];
    server = spawn(CODEX_BIN, report.server.argv, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    report.server.pid = server.pid || null;
    server.stdout.on("data", (chunk) => {
      serverStderr += `[stdout] ${String(chunk)}`;
      if (serverStderr.length > 24000) serverStderr = serverStderr.slice(-24000);
    });
    server.stderr.on("data", (chunk) => {
      serverStderr += String(chunk);
      if (serverStderr.length > 24000) serverStderr = serverStderr.slice(-24000);
    });
    const earlyExit = new Promise((resolve) => {
      server.once("error", (error) => resolve(`spawn error: ${error.message}`));
      server.once("exit", (code, signal) =>
        resolve(`early exit code=${code} signal=${signal || ""}`),
      );
    });
    const ready = await Promise.race([
      waitForSocket(sockPath, 15_000).then((ok) =>
        ok ? "ready" : "socket timeout",
      ),
      earlyExit,
    ]);
    report.server.ready = ready === "ready";
    if (ready !== "ready") throw new Error(`app-server not ready: ${ready}`);

    client = new RecordingJsonRpcWsUdsClient(
      {
        socketPath: sockPath,
        onError: (error) => {
          report.controller.errors.push({
            at: nowIso(),
            phase: currentPhase,
            message: error.message,
          });
        },
      },
      (frame) => {
        const request = {
          at: nowIso(),
          phase: currentPhase,
          client: "A",
          kind: "server-request",
          id: frame.id,
          method: frame.method,
          threadId: frame.params?.threadId || threadId || null,
          turnId: frame.params?.turnId || null,
          clientUserMessageId: null,
          params: frame.params || null,
          responded: false,
        };
        report.controller.serverRequests.push(request);
        report.actions.push(request);
      },
    );
    await client.connect();
    client.onNotification("*", (params, method) => {
      const summary = eventSummary(method, params, currentPhase, threadId);
      const knownId = summary.turnId
        ? programClientIds.get(summary.turnId)
        : null;
      if (!summary.clientUserMessageId && knownId) {
        summary.clientUserMessageId = knownId;
      }
      report.events.push(summary);
    });

    report.controller.initialize = await rpc(
      "initialize",
      {
        clientInfo: {
          name: "tfx-codex-dual-client-gating-probe",
          version: "0.0.0",
        },
      },
      10_000,
    );
    client.notify("initialized", {});
    addAction({
      client: "A",
      kind: "rpc-notification",
      method: "initialized",
      threadId: null,
      turnId: null,
      clientUserMessageId: null,
    });

    report.thread.startResponse = await rpc(
      "thread/start",
      {
        cwd: REPO_ROOT,
        sandbox: "read-only",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        ephemeral: false,
        personality: "none",
        developerInstructions:
          "Use minimal tokens. Obey exact reply requests. Do not modify files.",
      },
      20_000,
    );
    threadId = extractThreadId(report.thread.startResponse);
    report.thread.id = threadId;
    if (!threadId) throw new Error("thread/start returned no thread id");

    currentPhase = "materialize_durable_thread";
    const rolloutPath = report.thread.startResponse?.thread?.path || null;
    const seedNonce = makeNonce("P0_SEED");
    const seedClientUserMessageId = `program-${seedNonce}`;
    const seedEventStart = report.events.length;
    const rolloutBeforeSeed = rolloutPath
      ? await pathKind(rolloutPath)
      : "path-not-returned";
    const seedTurn = await startProgramTurn(
      `Reply exactly ${seedNonce}.`,
      seedClientUserMessageId,
      { approvalPolicy: "never" },
    );
    const seedCompleted = await waitForTurnEnd(
      seedTurn.turnId,
      seedEventStart,
      DEFAULT_TIMEOUT_MS,
    );
    const rolloutReady = rolloutPath
      ? await waitForCondition(
          async () =>
            (await pathKind(rolloutPath)) === "file" ? "file" : null,
          10_000,
          "durable rollout materialized after P0 seed",
        )
      : null;
    const seedHistory = await readHistory("after-P0-seed");
    report.thread.materialization = {
      reason:
        "codex 0.147.0 thread/start returns a durable id/path before the rollout file exists; TUI thread/resume requires the rollout",
      rolloutPath,
      rolloutBeforeSeed,
      rolloutAfterSeed: rolloutPath
        ? await pathKind(rolloutPath)
        : "path-not-returned",
      rolloutReady,
      seedNonce,
      seedClientUserMessageId,
      seedTurnId: seedTurn.turnId,
      seedCompleted,
      seedHistoryCorrelation: correlateNonce(seedHistory, seedNonce),
    };
    if (!seedCompleted || report.thread.materialization.rolloutAfterSeed !== "file") {
      throw new Error(
        `P0 seed did not materialize durable rollout: ${JSON.stringify(report.thread.materialization)}`,
      );
    }

    currentPhase = "attach_initial_tui";
    const firstTui = await launchTui("initial");
    const initialIdle = await waitForTuiNotBusy("initial-attach-idle", {
      timeoutMs: 25_000,
    });
    if (initialIdle.timedOut) {
      throw new Error("initial TUI never reached a stable not-busy composer");
    }

    await runScenario("controller_to_tui_sync_latency", async () => {
      const trials = [];
      const repetitions = Math.max(3, SYNC_REPETITIONS);
      for (let trial = 1; trial <= repetitions; trial += 1) {
        const preTurnIdle = await waitForTuiNotBusy(
          `sync-${trial}-pre-turn-idle`,
        );
        const nonce = makeNonce(trial === 1 ? "P1" : `P_SYNC_${trial}`);
        const clientUserMessageId = `program-${nonce}`;
        const eventStart = report.events.length;
        const { turnId, response } = await startProgramTurn(
          `Reply exactly ${nonce}.`,
          clientUserMessageId,
          { approvalPolicy: "never" },
        );
        const busyObservation = await waitForTuiBusy(
          `sync-${trial}-controller-turn-busy`,
          { timeoutMs: 10_000 },
        );
        const completed = await waitForTurnEnd(
          turnId,
          eventStart,
          DEFAULT_TIMEOUT_MS,
        );
        const notBusy = await waitForTuiNotBusy(
          `sync-${trial}-after-controller-completed`,
          {
            sinceAt: completed?.at || nowIso(),
            timeoutMs: TUI_STATE_TIMEOUT_MS,
          },
        );
        const pane = capturePane(`sync-${trial}-final-pane`);
        const history = await readHistory(`sync-${trial}-history`);
        trials.push({
          trial,
          nonce,
          clientUserMessageId,
          turnId,
          response,
          preTurnIdle,
          busyObservation,
          completed,
          controllerCompletedAt: completed?.at || null,
          notBusy,
          latencyMs: notBusy.latencyMs,
          timedOut: notBusy.timedOut,
          paneContainsNonce: pane.text.includes(nonce),
          historyCorrelation: correlateNonce(history, nonce),
        });
        if (!completed || notBusy.timedOut) break;
      }
      return {
        requestedRepetitions: repetitions,
        trials,
        latency: summarizeLatencyMs(trials),
      };
    });

    await runScenario("human_to_controller_and_history", async () => {
      const nonce = makeNonce("H1");
      const preInputIdle = await waitForTuiNotBusy("H1-pre-input-idle");
      const beforeInput = capturePaneState("H1-immediately-before-input");
      const eventStart = report.events.length;
      const inputAction = sendTuiText(`Reply exactly ${nonce}.`, "H1 direct input");
      await delay(100);
      const afterInput = capturePaneState("H1-immediately-after-input");
      const busyObservation = await waitForTuiBusy("H1-after-input-busy", {
        timeoutMs: 10_000,
      });
      const notBusyAfterInput = await waitForTuiNotBusy(
        "H1-after-input-not-busy",
        { timeoutMs: TUI_STATE_TIMEOUT_MS },
      );
      const history = await readHistory("after-H1");
      const correlation = correlateNonce(history, nonce);
      const turnId = correlation?.turnId ||
        report.events.slice(eventStart).find(
          (event) =>
            event.itemType === "userMessage" && event.text?.includes(nonce),
        )?.turnId || null;
      const lifecycle = humanLifecycle(nonce, eventStart, turnId);
      return {
        nonce,
        turnId,
        clientUserMessageId:
          lifecycle.userItem?.clientUserMessageId ||
          correlation?.clientUserMessageId ||
          null,
        preInputIdle,
        beforeInput: {
          at: beforeInput.at,
          state: beforeInput.state,
          label: beforeInput.label,
        },
        inputAction,
        afterInput: {
          at: afterInput.at,
          state: afterInput.state,
          label: afterInput.label,
        },
        busyObservation,
        notBusyAfterInput,
        lifecycle,
        historyCorrelation: correlation,
        historyStatus: turnStatus(history, turnId),
        events: report.events.slice(eventStart),
        pane: capturePane("after-H1-final").text,
      };
    });

    await runScenario("program_interrupts_human_turn", async () => {
      const nonce = makeNonce("H_PROGRAM_INTERRUPT");
      const preInputIdle = await waitForTuiNotBusy(
        "program-interrupt-human-pre-input-idle",
      );
      const beforeInput = capturePaneState(
        "program-interrupt-human-immediately-before-input",
      );
      const eventStart = report.events.length;
      const inputAction = sendTuiText(
        `Call clock.sleep for 12000ms, then reply ${nonce}.`,
        "human long turn for program interrupt",
      );
      const busyObservation = await waitForTuiBusy(
        "program-interrupt-human-busy",
        { timeoutMs: 10_000 },
      );
      const evidence = await waitForHumanTurnEvidence(
        nonce,
        eventStart,
        20_000,
        `A/history sees human interrupt target ${nonce}`,
      );
      const turnId = evidence.itemEvent?.turnId ||
        evidence.correlation?.turnId || null;
      const statusAtInterruptRequest = turnStatus(evidence.history, turnId);
      let interruptResult = null;
      let interruptError = null;
      let interruptAttempted = false;
      if (turnId && statusAtInterruptRequest === "inProgress") {
        interruptAttempted = true;
        try {
          interruptResult = await rpc(
            "turn/interrupt",
            { threadId, turnId },
            15_000,
          );
        } catch (error) {
          interruptError = error instanceof Error ? error.message : String(error);
        }
      }
      const notBusyAfterInterrupt = await waitForTuiNotBusy(
        "program-interrupt-human-after-interrupt-not-busy",
        { timeoutMs: TUI_STATE_TIMEOUT_MS },
      );
      const history = await readHistory("after-program-interrupt-human");
      const lifecycle = humanLifecycle(nonce, eventStart, turnId);
      return {
        nonce,
        turnId,
        preInputIdle,
        beforeInput: {
          at: beforeInput.at,
          state: beforeInput.state,
          label: beforeInput.label,
        },
        inputAction,
        busyObservation,
        evidence,
        statusAtInterruptRequest,
        interruptAttempted,
        interruptResult,
        interruptError,
        notBusyAfterInterrupt,
        lifecycle,
        historyStatus: turnStatus(history, turnId),
        historyCorrelation: correlateNonce(history, nonce),
        pane: capturePane("after-program-interrupt-human").text,
      };
    });

    await runScenario("human_escape_interrupts_program_turn", async () => {
      const nonce = makeNonce("P_HUMAN_INTERRUPT");
      const clientUserMessageId = `program-${nonce}`;
      const preTurnIdle = await waitForTuiNotBusy(
        "human-escape-program-pre-turn-idle",
      );
      const eventStart = report.events.length;
      const { turnId, response } = await startProgramTurn(
        `Call clock.sleep for 12000ms, then reply ${nonce}.`,
        clientUserMessageId,
        { approvalPolicy: "never" },
      );
      const busyObservation = await waitForTuiBusy(
        "human-escape-program-busy",
        { timeoutMs: 15_000 },
      );
      sendTuiKey("Escape", "human ESC interrupts program turn");
      let historyEnd = await waitForHistoryTurnEnd(turnId, 20_000);
      let cleanupInterrupt = null;
      if (historyEnd.status !== "interrupted") {
        try {
          cleanupInterrupt = await rpc(
            "turn/interrupt",
            { threadId, turnId },
            10_000,
          );
        } catch {}
        historyEnd = await waitForHistoryTurnEnd(turnId, 10_000);
      }
      const completed = report.events.slice(eventStart).find(
        (event) =>
          event.method === "turn/completed" && event.turnId === turnId,
      ) || null;
      const notBusyAfterInterrupt = await waitForTuiNotBusy(
        "human-escape-program-after-interrupt-not-busy",
      );
      const history = historyEnd.history ||
        (await readHistory("after-human-escape-program"));
      report.historySnapshots.push({
        at: nowIso(),
        phase: currentPhase,
        label: "after-human-escape-program",
        threadId,
        result: history,
      });
      return {
        nonce,
        clientUserMessageId,
        turnId,
        response,
        preTurnIdle,
        busyObservation,
        completed,
        cleanupInterrupt,
        notBusyAfterInterrupt,
        historyStatus: turnStatus(history, turnId),
        historyCorrelation: correlateNonce(history, nonce),
        pane: capturePane("after-human-escape-program").text,
      };
    });

    await runScenario("near_simultaneous_submission", async () => {
      const enterTrials = [];
      for (let trial = 1; trial <= 2; trial += 1) {
        const preTurnIdle = await waitForTuiNotBusy(
          `collision-enter-${trial}-pre-turn-idle`,
        );
        const programNonce = makeNonce(`C${trial}_P`);
        const humanNonce = makeNonce(`C${trial}_H_ENTER`);
        const clientUserMessageId = `program-${programNonce}`;
        const eventStart = report.events.length;
        const { turnId, response } = await startProgramTurn(
          `Call clock.sleep for 6000ms, then reply ${programNonce}.`,
          clientUserMessageId,
          { approvalPolicy: "never" },
        );
        const busyObservation = await waitForTuiBusy(
          `collision-enter-${trial}-program-busy`,
          { timeoutMs: 15_000 },
        );
        const beforeInput = capturePaneState(
          `collision-enter-${trial}-immediately-before-input`,
        );
        const inputAction = sendTuiText(
          `Reply exactly ${humanNonce}.`,
          `collision Enter trial ${trial}`,
        );
        await delay(100);
        const afterInput = capturePaneState(
          `collision-enter-${trial}-immediately-after-input`,
        );
        const completed = await waitForTurnEnd(
          turnId,
          eventStart,
          DEFAULT_TIMEOUT_MS,
        );
        const notBusy = await waitForTuiNotBusy(
          `collision-enter-${trial}-final-not-busy`,
          { timeoutMs: TUI_STATE_TIMEOUT_MS },
        );
        const history = await readHistory(`collision-enter-${trial}-history`);
        const programCorrelation = correlateNonce(history, programNonce);
        const humanCorrelation = correlateNonce(history, humanNonce);
        enterTrials.push({
          trial,
          mode: "Enter while program turn busy",
          programNonce,
          humanNonce,
          clientUserMessageId,
          programTurnId: turnId,
          response,
          preTurnIdle,
          busyObservation,
          beforeInput: {
            at: beforeInput.at,
            state: beforeInput.state,
          },
          inputAction,
          afterInput: {
            at: afterInput.at,
            state: afterInput.state,
          },
          completed,
          notBusy,
          policy: classifyCollision(history, programNonce, humanNonce),
          programCorrelation,
          humanCorrelation,
          events: report.events.slice(eventStart),
        });
      }

      const preQueueIdle = await waitForTuiNotBusy(
        "collision-tab-queue-pre-turn-idle",
      );
      const programNonce = makeNonce("CQ_P");
      const humanNonce = makeNonce("CQ_H_TAB");
      const clientUserMessageId = `program-${programNonce}`;
      const eventStart = report.events.length;
      const { turnId, response } = await startProgramTurn(
        `Call clock.sleep for 6000ms, then reply ${programNonce}.`,
        clientUserMessageId,
        { approvalPolicy: "never" },
      );
      const busyObservation = await waitForTuiBusy(
        "collision-tab-queue-program-busy",
        { timeoutMs: 15_000 },
      );
      const beforeStage = capturePaneState(
        "collision-tab-queue-immediately-before-stage",
      );
      const stageAction = stageTuiText(
        `Reply exactly ${humanNonce}.`,
        "collision Tab queue staged input",
      );
      await delay(100);
      const stagedCapture = capturePaneState(
        "collision-tab-queue-staged-before-tab",
      );
      sendTuiKey("Tab", "queue staged message during program turn");
      await delay(100);
      const afterTab = capturePaneState("collision-tab-queue-after-tab");
      const programCompleted = await waitForTurnEnd(
        turnId,
        eventStart,
        DEFAULT_TIMEOUT_MS,
      );
      const queuedEvidence = await waitForHistoryNonce(
        humanNonce,
        TUI_STATE_TIMEOUT_MS,
      );
      const queuedTurnId = queuedEvidence.correlation?.turnId || null;
      const queuedHistoryEnd = await waitForHistoryTurnEnd(
        queuedTurnId,
        TUI_STATE_TIMEOUT_MS,
      );
      const notBusy = await waitForTuiNotBusy(
        "collision-tab-queue-final-not-busy",
        { timeoutMs: TUI_STATE_TIMEOUT_MS },
      );
      const history = queuedHistoryEnd.history || queuedEvidence.history ||
        (await readHistory("collision-tab-queue-history"));
      report.historySnapshots.push({
        at: nowIso(),
        phase: currentPhase,
        label: "collision-tab-queue-history",
        threadId,
        result: history,
      });
      const queuedTrial = {
        mode: "Tab queue while program turn busy",
        programNonce,
        humanNonce,
        clientUserMessageId,
        programTurnId: turnId,
        queuedTurnId,
        response,
        preTurnIdle: preQueueIdle,
        busyObservation,
        beforeStage: {
          at: beforeStage.at,
          state: beforeStage.state,
        },
        stageAction,
        stagedCapture: {
          at: stagedCapture.at,
          state: stagedCapture.state,
        },
        afterTab: {
          at: afterTab.at,
          state: afterTab.state,
        },
        programCompleted,
        notBusy,
        policy: classifyCollision(history, programNonce, humanNonce),
        programCorrelation: correlateNonce(history, programNonce),
        humanCorrelation: correlateNonce(history, humanNonce),
        events: report.events.slice(eventStart),
      };
      const enterPolicies = enterTrials.map((trial) => trial.policy);
      return {
        enterTrials,
        enterDeterministic:
          enterPolicies.length === 2 && enterPolicies[0] === enterPolicies[1],
        enterPolicy:
          enterPolicies.length === 2 && enterPolicies[0] === enterPolicies[1]
            ? enterPolicies[0]
            : "nondeterministic",
        queuedTrial,
      };
    });

    await runScenario("approval_routing", async () => {
      const preTurnIdle = await waitForTuiNotBusy(
        "approval-routing-pre-turn-idle",
      );
      const nonce = makeNonce("APPROVAL");
      const clientUserMessageId = `program-${nonce}`;
      const eventStart = report.events.length;
      const requestStart = report.controller.serverRequests.length;
      const { turnId, response } = await startProgramTurn(
        `Use shell once to run printf ${nonce} with escalation approval; do not answer without attempting the tool.`,
        clientUserMessageId,
        {
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        },
      );
      const request = await waitForCondition(
        () => report.controller.serverRequests[requestStart] || null,
        30_000,
        `approval request for ${turnId}`,
      );
      void request;
      const controllerRequests = report.controller.serverRequests
        .slice(requestStart)
        .filter((entry) => entry.turnId === turnId || !entry.turnId);
      await delay(750);
      const paneBeforeResolution = capturePane("approval-routing-pending");
      const approvalRequest = controllerRequests.find((entry) =>
        /requestApproval|Approval$/u.test(entry.method),
      );
      let resolution = null;
      if (approvalRequest) {
        client.respondToServerRequest(approvalRequest.id, {
          decision: "decline",
        });
        approvalRequest.responded = true;
        approvalRequest.response = { decision: "decline" };
        resolution = "controller-declined";
        addAction({
          client: "A",
          kind: "server-response",
          requestId: approvalRequest.id,
          method: approvalRequest.method,
          result: { decision: "decline" },
          threadId,
          turnId,
          clientUserMessageId,
        });
      } else {
        try {
          await rpc("turn/interrupt", { threadId, turnId }, 10_000);
          resolution = "controller-interrupted-no-request";
        } catch (error) {
          resolution = `cleanup-error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const completed = await waitForTurnEnd(turnId, eventStart, 40_000);
      const notBusy = await waitForTuiNotBusy(
        "approval-routing-final-not-busy",
        { timeoutMs: 40_000 },
      );
      const history = await readHistory("after-approval-routing");
      const paneText = paneBeforeResolution.text;
      return {
        nonce,
        clientUserMessageId,
        turnId,
        response,
        preTurnIdle,
        controllerRequests,
        tuiApprovalUiPattern:
          /Would you like to run|Yes, allow|Press enter to confirm|Esc to cancel|Do you want to proceed/iu.test(
            paneText,
          ),
        paneBeforeResolution: paneText,
        resolution,
        completed,
        notBusy,
        historyCorrelation: correlateNonce(history, nonce),
      };
    });

    await runScenario("detach_reattach", async () => {
      const preDetachIdle = await waitForTuiNotBusy("detach-pre-idle");
      const preDetachHistory = await readHistory("before-detach");
      const priorItemIds = new Set(
        (getThread(preDetachHistory)?.turns || []).flatMap((turn) =>
          (turn?.items || []).map((item) => item?.id).filter(Boolean),
        ),
      );
      const initialSession = firstTui.sessionName;
      killOwnedTui(initialSession, "required detach probe");
      const detachedNonce = makeNonce("P_DETACHED");
      const detachedClientId = `program-${detachedNonce}`;
      const detachedEventStart = report.events.length;
      const detachedTurn = await startProgramTurn(
        `Reply exactly ${detachedNonce}.`,
        detachedClientId,
      );
      const detachedCompleted = await waitForTurnEnd(
        detachedTurn.turnId,
        detachedEventStart,
        DEFAULT_TIMEOUT_MS,
      );
      const eventsBeforeReattach = report.events.length;
      const reattached = await launchTui("reattach");
      const reattachIdle = await waitForTuiNotBusy(
        "reattach-before-human-input-idle",
        { timeoutMs: TUI_STATE_TIMEOUT_MS },
      );
      const reattachCapture = capturePane("after-reattach-history");
      const replayEvents = report.events.slice(eventsBeforeReattach);
      const replayedPriorItems = replayEvents.filter(
        (event) => event.itemId && priorItemIds.has(event.itemId),
      );

      const humanNonce = makeNonce("H_REATTACHED");
      const humanEventStart = report.events.length;
      const beforeHumanInput = capturePaneState(
        "reattach-immediately-before-human-input",
      );
      const inputAction = sendTuiText(
        `Reply exactly ${humanNonce}.`,
        "post-reattach human input",
      );
      const humanBusy = await waitForTuiBusy("reattach-human-input-busy", {
        timeoutMs: 10_000,
      });
      const humanNotBusy = await waitForTuiNotBusy(
        "reattach-human-input-final-not-busy",
        { timeoutMs: TUI_STATE_TIMEOUT_MS },
      );
      const finalHistory = await readHistory("after-reattach-human");
      const humanCorrelation = correlateNonce(finalHistory, humanNonce);
      const humanTurnId = humanCorrelation?.turnId ||
        report.events.slice(humanEventStart).find(
          (event) =>
            event.itemType === "userMessage" &&
            event.text?.includes(humanNonce),
        )?.turnId || null;
      const lifecycle = humanLifecycle(
        humanNonce,
        humanEventStart,
        humanTurnId,
      );
      report.historySnapshots.push({
        at: nowIso(),
        phase: currentPhase,
        label: "after-reattach-human",
        threadId,
        result: finalHistory,
      });
      return {
        preDetachIdle,
        detachedSession: initialSession,
        reattachedSession: reattached.sessionName,
        detachedNonce,
        detachedTurnId: detachedTurn.turnId,
        detachedCompleted,
        reattachIdle,
        detachedHistoryVisibleOnReattach: reattachCapture.text.includes(detachedNonce),
        replayedPriorItemEvents: replayedPriorItems,
        humanNonce,
        humanTurnId,
        beforeHumanInput: {
          at: beforeHumanInput.at,
          state: beforeHumanInput.state,
        },
        inputAction,
        humanBusy,
        humanNotBusy,
        humanItem: lifecycle.userItem,
        humanCompleted: lifecycle.turnCompleted,
        lifecycle,
        humanHistoryCorrelation: humanCorrelation,
        detachedHistoryCorrelation: correlateNonce(finalHistory, detachedNonce),
        humanInputCount: countNonce(finalHistory, humanNonce),
        detachedInputCount: countNonce(finalHistory, detachedNonce),
      };
    });

    const sync = report.scenarios.controller_to_tui_sync_latency;
    const p1 = sync?.trials?.[0];
    const h1 = report.scenarios.human_to_controller_and_history;
    const pi = report.scenarios.program_interrupts_human_turn;
    const hi = report.scenarios.human_escape_interrupts_program_turn;
    const concurrent = report.scenarios.near_simultaneous_submission;
    const approval = report.scenarios.approval_routing;
    const reattach = report.scenarios.detach_reattach;

    report.checks.controllerTurnTuiNotBusyLatency =
      sync?.trials?.length === sync?.requestedRepetitions &&
      sync?.latency?.completed === sync?.requestedRepetitions &&
      sync?.latency?.timedOut === 0
        ? classify("confirmed", {
            repetitions: sync.requestedRepetitions,
            medianMs: sync.latency.medianMs,
            maxMs: sync.latency.maxMs,
            valuesMs: sync.latency.valuesMs,
            trials: sync.trials.map((trial) => ({
              trial: trial.trial,
              turnId: trial.turnId,
              controllerCompletedAt: trial.controllerCompletedAt,
              notBusyAt: trial.notBusy?.resolvedAt || null,
              latencyMs: trial.latencyMs,
              busyObservedBeforeCompletion:
                trial.busyObservation?.timedOut === false,
            })),
          })
        : classify(
            sync?.trials?.length ? "disproved" : "unconfirmed",
            sync || null,
            sync?.error ||
              "one or more controller turns did not return the TUI to stable not-busy before the timeout",
          );
    report.checks.programInputAppearsInTuiAndHistory = p1?.paneContainsNonce &&
      p1?.historyCorrelation
      ? classify("confirmed", {
          nonce: p1.nonce,
          turnId: p1.turnId,
          clientUserMessageId: p1.clientUserMessageId,
          history: p1.historyCorrelation,
        })
      : classify("disproved", p1 || null, p1?.error || null);
    report.checks.humanInputAppearsInHistory =
      h1?.beforeInput?.state?.notBusy && h1?.historyCorrelation
        ? classify("confirmed", {
            nonce: h1.nonce,
            turnId: h1.turnId,
            beforeInputAt: h1.beforeInput.at,
            beforeInputState: h1.beforeInput.state,
            inputSentAt: h1.inputAction?.sentAt || h1.inputAction?.at || null,
            history: h1.historyCorrelation,
            historyStatus: h1.historyStatus,
          })
        : classify("disproved", h1 || null, h1?.error || null);
    report.checks.controllerReceivesHumanLifecycle =
      h1?.lifecycle?.turnStarted &&
      h1?.lifecycle?.userItem &&
      h1?.lifecycle?.turnCompleted
        ? classify("confirmed", {
            nonce: h1.nonce,
            turnId: h1.turnId,
            clientUserMessageId: h1.clientUserMessageId,
            lifecycle: h1.lifecycle,
          })
        : classify("disproved", h1 || null, h1?.error || null);
    report.checks.humanInputAppearsInControllerAndHistory =
      report.checks.humanInputAppearsInHistory.status === "confirmed" &&
      report.checks.controllerReceivesHumanLifecycle.status === "confirmed"
        ? classify("confirmed", {
            history: report.checks.humanInputAppearsInHistory.evidence,
            lifecycle: report.checks.controllerReceivesHumanLifecycle.evidence,
          })
        : classify("disproved", {
            history: report.checks.humanInputAppearsInHistory,
            lifecycle: report.checks.controllerReceivesHumanLifecycle,
          });
    report.checks.programInterruptsHumanTurn =
      pi?.interruptAttempted && pi?.historyStatus === "interrupted"
        ? classify("confirmed", {
            nonce: pi.nonce,
            turnId: pi.turnId,
            status: pi.historyStatus,
            interruptResult: pi.interruptResult,
          })
        : classify(
            pi?.historyCorrelation ? "disproved" : "unconfirmed",
            pi || null,
            pi?.error || null,
          );
    report.checks.humanEscapeInterruptsProgramTurn =
      hi?.historyStatus === "interrupted" && !hi?.cleanupInterrupt
        ? classify("confirmed", {
            nonce: hi.nonce,
            turnId: hi.turnId,
            status: hi.historyStatus,
          })
        : classify(
            hi?.turnId ? "disproved" : "unconfirmed",
            hi || null,
            hi?.error || null,
          );
    report.checks.concurrentSubmissionPolicy =
      concurrent?.enterDeterministic &&
      concurrent?.enterTrials?.length === 2 &&
      concurrent?.queuedTrial?.programCorrelation
      ? classify("confirmed", {
          enterPolicy: concurrent.enterPolicy,
          enterTrials: concurrent.enterTrials.map((trial) => ({
            trial: trial.trial,
            policy: trial.policy,
            programTurnId: trial.programCorrelation?.turnId || null,
            humanTurnId: trial.humanCorrelation?.turnId || null,
          })),
          tabQueuePolicy: concurrent.queuedTrial.policy,
          tabQueueProgramTurnId:
            concurrent.queuedTrial.programCorrelation?.turnId || null,
          tabQueueHumanTurnId:
            concurrent.queuedTrial.humanCorrelation?.turnId || null,
          stagedPaneHadQueueHint:
            concurrent.queuedTrial.stagedCapture?.state?.queueHint || false,
        })
      : classify(
          concurrent?.enterTrials?.length ? "disproved" : "unconfirmed",
          concurrent || null,
          concurrent?.error || null,
        );
    report.checks.tabQueuesBusyHumanMessage =
      concurrent?.queuedTrial?.policy === "queue" &&
      concurrent?.queuedTrial?.humanCorrelation
        ? classify("confirmed", {
            programTurnId:
              concurrent.queuedTrial.programCorrelation?.turnId || null,
            humanTurnId:
              concurrent.queuedTrial.humanCorrelation?.turnId || null,
            stagedPaneHadQueueHint:
              concurrent.queuedTrial.stagedCapture?.state?.queueHint || false,
          })
        : classify("disproved", concurrent?.queuedTrial || null);
    report.checks.approvalRequestRouting = approval?.controllerRequests?.length
      ? classify("confirmed", {
          route: approval.tuiApprovalUiPattern ? "controller-and-tui" : "controller-only",
          turnId: approval.turnId,
          requestIds: approval.controllerRequests.map((entry) => entry.id),
          methods: approval.controllerRequests.map((entry) => entry.method),
          tuiApprovalUiPattern: approval.tuiApprovalUiPattern,
          resolution: approval.resolution,
        })
      : approval?.tuiApprovalUiPattern
        ? classify("confirmed", {
            route: "tui-only",
            turnId: approval.turnId,
            resolution: approval.resolution,
          })
        : classify("unconfirmed", approval || null, approval?.error || null);
    report.checks.detachReattachNoDuplicateOrMissing =
      reattach?.reattachIdle?.timedOut === false &&
      reattach?.beforeHumanInput?.state?.notBusy &&
      reattach?.detachedHistoryVisibleOnReattach &&
      reattach?.replayedPriorItemEvents?.length === 0 &&
      reattach?.humanItem &&
      reattach?.humanCompleted &&
      reattach?.humanHistoryCorrelation &&
      reattach?.humanInputCount === 1 &&
      reattach?.detachedInputCount === 1
        ? classify("confirmed", {
            detachedNonce: reattach.detachedNonce,
            detachedTurnId: reattach.detachedTurnId,
            humanNonce: reattach.humanNonce,
            humanTurnId: reattach.humanTurnId,
            replayedPriorItemEventCount:
              reattach.replayedPriorItemEvents.length,
            humanInputCount: reattach.humanInputCount,
            detachedInputCount: reattach.detachedInputCount,
          })
        : classify("disproved", reattach || null, reattach?.error || null);

    const bidirectional =
      report.checks.programInputAppearsInTuiAndHistory.status === "confirmed" &&
      report.checks.humanInputAppearsInHistory.status === "confirmed";
    const uiRecovers =
      report.checks.controllerTurnTuiNotBusyLatency.status === "confirmed";
    const deterministic =
      report.checks.concurrentSubmissionPolicy.status === "confirmed";
    const controllerSeesHumanLifecycle =
      report.checks.controllerReceivesHumanLifecycle.status === "confirmed";
    report.operationalConditions = [];
    if (bidirectional && uiRecovers && deterministic) {
      report.operationalConditions.push(
        "send direct human input only after the TUI has shown a stable not-busy composer",
      );
      if (report.checks.tabQueuesBusyHumanMessage.status === "confirmed") {
        report.operationalConditions.push(
          "while a controller turn is busy, use the TUI Tab queue affordance instead of treating the composer as idle",
        );
      }
      if (!controllerSeesHumanLifecycle) {
        report.operationalConditions.push(
          "controller A must poll thread/read because TUI-originated lifecycle notifications were not observed on A",
        );
      }
      report.verdict =
        "CONDITIONALLY_POSSIBLE: same-thread bidirectional history was demonstrated under explicit TUI not-busy/queue gating";
    } else {
      report.verdict =
        "IMPOSSIBLE_FOR_PERSISTENT_CONTROLLER_TUI_COEXISTENCE: clean-condition bidirectional history, TUI recovery, or deterministic collision handling was not demonstrated";
    }
  } catch (error) {
    report.fatalError = error instanceof Error ? error.stack || error.message : String(error);
    report.verdict = "UNCONFIRMED: fatal probe blocker prevented the decision experiment";
  } finally {
    currentPhase = "cleanup";
    try {
      client?.close();
    } catch {}
    for (const sessionName of ownedSessions) {
      if (!psmuxSessionExists(sessionName)) continue;
      try {
        killPsmuxSession(sessionName);
        if (!report.cleanup.killedSessions.includes(sessionName)) {
          report.cleanup.killedSessions.push(sessionName);
        }
      } catch (error) {
        report.cleanup[`killError:${sessionName}`] =
          error instanceof Error ? error.message : String(error);
      }
    }
    report.cleanup.remainingSessions = [...ownedSessions].filter((name) =>
      psmuxSessionExists(name),
    );
    report.cleanup.appServerStop = await stopChild(server);
    report.cleanup.appServerExited =
      !server || server.exitCode !== null || server.signalCode !== null;
    report.server.stderrTail = serverStderr.slice(-12000);
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch((error) => {
        report.cleanup.tempDirRemoveError = error.message;
      });
    }
    report.cleanup.socketAfterCleanup = sockPath
      ? await pathKind(sockPath)
      : "not-created";
    report.cleanup.tempDirAfterCleanup = tempDir
      ? await pathKind(tempDir)
      : "not-created";

    const latestHistory = [...report.historySnapshots]
      .reverse()
      .find((entry) => entry?.result)?.result;
    const byTurn = historyCorrelationMap(latestHistory);
    for (const event of report.events) {
      const ids = event.turnId ? byTurn.get(event.turnId) || [] : [];
      event.clientUserMessageIds = ids;
      if (!event.clientUserMessageId && ids.length === 1) {
        event.clientUserMessageId = ids[0];
      }
    }
    report.finishedAt = nowIso();
    await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          reportPath: REPORT_PATH,
          threadId: report.thread.id,
          checks: report.checks,
          verdict: report.verdict,
          cleanup: report.cleanup,
          fatalError: report.fatalError,
        },
        null,
        2,
      )}\n`,
    );
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : null;
if (invokedPath === import.meta.url) {
  await main();
}

#!/usr/bin/env node

// hub/bridge.mjs: tfx-route.sh 와 tfx-live 가 부르는 로컬 제어 CLI.
// 팀 하위 명령은 nativeProxy 를 직접 호출하고 Claude daemon, retry, intervene 은 로컬 모듈만 쓴다.

import { readFileSync } from "node:fs";
import { parseArgs as nodeParseArgs } from "node:util";

import {
  createRetryStateMachine,
  loadSnapshot,
  saveSnapshot,
} from "./team/retry-state-machine.mjs";

export function parseArgs(argv) {
  const { values, positionals } = nodeParseArgs({
    args: argv,
    options: {
      team: { type: "string" },
      "task-id": { type: "string" },
      owner: { type: "string" },
      status: { type: "string" },
      statuses: { type: "string" },
      claim: { type: "boolean" },
      actor: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      text: { type: "string" },
      summary: { type: "string" },
      color: { type: "string" },
      limit: { type: "string" },
      "include-internal": { type: "boolean" },
      subject: { type: "string" },
      description: { type: "string" },
      "active-form": { type: "string" },
      "add-blocks": { type: "string" },
      "add-blocked-by": { type: "string" },
      "metadata-patch": { type: "string" },
      "if-match-mtime-ms": { type: "string" },
      payload: { type: "string" },
      "payload-file": { type: "string" },
      "session-id": { type: "string" },
      reason: { type: "string" },
      mode: { type: "string" },
      snapshot: { type: "string" },
      "snapshot-file": { type: "string" },
      event: { type: "string" },
      "max-iterations": { type: "string" },
    },
    allowPositionals: true,
    strict: false,
  });
  const parsed = { ...values, _: positionals };
  positionals.forEach((value, index) => {
    parsed[index + 1] = value;
  });
  return parsed;
}

export function parseJsonSafe(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function readBridgePayload(args = {}, stdin) {
  if (args["payload-file"]) {
    const payloadFile = String(args["payload-file"]);
    const raw =
      payloadFile === "-"
        ? stdin === undefined
          ? readFileSync(0, "utf8")
          : String(stdin)
        : readFileSync(payloadFile, "utf8");
    return JSON.parse(raw);
  }
  if (args.payload) return JSON.parse(args.payload);
  return {};
}

function emitJson(payload) {
  if (payload !== undefined) {
    console.log(JSON.stringify(payload));
  }
  return payload?.ok !== false;
}

function splitList(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function cmdTeamInfo(args) {
  const { teamInfo } = await import("./team/nativeProxy.mjs");
  return emitJson(
    await teamInfo({
      team_name: args.team,
      include_members: true,
      include_paths: true,
    }),
  );
}

async function cmdTeamTaskList(args) {
  const { teamTaskList } = await import("./team/nativeProxy.mjs");
  return emitJson(
    await teamTaskList({
      team_name: args.team,
      owner: args.owner,
      statuses: args.statuses ? splitList(args.statuses) : [],
      include_internal: !!args["include-internal"],
      limit: parseInt(args.limit || "200", 10),
    }),
  );
}

async function cmdTeamTaskUpdate(args) {
  const { teamTaskUpdate } = await import("./team/nativeProxy.mjs");
  return emitJson(
    await teamTaskUpdate({
      team_name: args.team,
      task_id: args["task-id"],
      claim: !!args.claim,
      owner: args.owner,
      status: args.status,
      subject: args.subject,
      description: args.description,
      activeForm: args["active-form"],
      add_blocks: args["add-blocks"] ? splitList(args["add-blocks"]) : undefined,
      add_blocked_by: args["add-blocked-by"]
        ? splitList(args["add-blocked-by"])
        : undefined,
      metadata_patch: args["metadata-patch"]
        ? parseJsonSafe(args["metadata-patch"], null)
        : undefined,
      if_match_mtime_ms:
        args["if-match-mtime-ms"] != null
          ? Number(args["if-match-mtime-ms"])
          : undefined,
      actor: args.actor,
    }),
  );
}

async function cmdTeamSendMessage(args) {
  const { teamSendMessage } = await import("./team/nativeProxy.mjs");
  return emitJson(
    await teamSendMessage({
      team_name: args.team,
      from: args.from,
      to: args.to || "team-lead",
      text: args.text,
      summary: args.summary,
      color: args.color || "blue",
    }),
  );
}

async function loadDaemonControl() {
  return await import("./team/claude-daemon-control.mjs");
}

function daemonErrorResult(error) {
  return {
    ok: false,
    error: error?.message || String(error),
  };
}

function daemonAttachErrorResult(error) {
  return {
    ok: false,
    text: "",
    raw: "",
    responseRaw: "",
    matchedCompletion: false,
    timedOut: false,
    closed: false,
    inputSent: error?.inputSent ?? null,
    status: error?.inputSent === false ? "failed" : "unknown",
    error: error?.message || String(error),
  };
}

function daemonAttachProbeFailureResult(probe) {
  return {
    ok: false,
    text: "",
    raw: "",
    responseRaw: "",
    matchedCompletion: false,
    timedOut: false,
    closed: false,
    inputSent: false,
    error: probe?.error || probe?.reason || "Claude daemon unavailable",
    reason: probe?.reason || "daemon-unavailable",
    daemon: probe?.daemon ?? null,
    daemons: probe?.daemons ?? [],
    matches: probe?.matches ?? [],
    candidateResults: probe?.candidateResults ?? [],
    callerProvenance: probe?.callerProvenance ?? null,
  };
}

function daemonProbeMetadata(probe) {
  return {
    daemon: probe?.daemon ?? null,
    daemons: probe?.daemons ?? [],
    matches: probe?.matches ?? [],
    candidateResults: probe?.candidateResults ?? [],
    callerProvenance: probe?.callerProvenance ?? null,
  };
}

function daemonInterruptErrorResult(error) {
  return {
    ok: false,
    done: false,
    aborted: false,
    reason: "interrupt_failed",
    inputSent: error?.inputSent === true,
    error: error?.message || String(error),
  };
}

function daemonInterruptProbeFailureResult(probe) {
  return {
    ok: false,
    done: false,
    aborted: false,
    reason: probe?.reason || "interrupt_failed",
    inputSent: false,
    error: probe?.error || probe?.reason || "Claude daemon unavailable",
    daemon: probe?.daemon ?? null,
    daemons: probe?.daemons ?? [],
    matches: probe?.matches ?? [],
    candidateResults: probe?.candidateResults ?? [],
    callerProvenance: probe?.callerProvenance ?? null,
  };
}

function numericOption(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function cmdDaemonProbe(args) {
  try {
    const payload = readBridgePayload(args);
    const { probeClaudeDaemonCandidates } = await loadDaemonControl();
    const { probe, recoveredFrom } = await probeDaemonTarget(
      payload,
      probeClaudeDaemonCandidates,
      payload.includeContext === true,
    );
    return emitJson({ ...probe, ...(recoveredFrom ? { recoveredFrom } : {}) });
  } catch (error) {
    return emitJson(daemonErrorResult(error));
  }
}

function staleCandidate(probe) {
  return probe?.candidateResults?.find((candidate) =>
    ["daemon-dir-missing", "stale-control-socket"].includes(
      candidate.errorCode,
    ),
  );
}

function daemonProbeOptions(payload, includeContext = false) {
  return {
    configDir: payload.configDir,
    env: process.env,
    short: payload.short,
    sessionId: payload.sessionId,
    timeoutMs: numericOption(payload.timeoutMs, 6000),
    tmpRoot: payload.tmpRoot,
    includeContext,
  };
}

async function probeDaemonTarget(
  payload,
  probeCandidates,
  includeContext = false,
) {
  const options = daemonProbeOptions(payload, includeContext);
  const probe = await probeCandidates(options);
  const stale = staleCandidate(probe);
  if (probe.ok || !(payload.short || payload.sessionId) || !stale) {
    return { probe, recoveredFrom: null };
  }
  const retry = await probeCandidates({
    ...options,
    candidateSourceConfigDir: stale.sourceConfigDir ?? stale.configDir,
  });
  return {
    probe: retry,
    recoveredFrom: retry.ok ? stale : null,
  };
}

async function cmdDaemonAttach(args) {
  try {
    const payload = readBridgePayload(args);
    if (!payload.prompt) throw new Error("prompt is required");
    const {
      attachClaudeDaemonSession,
      buildDaemonControlAuth,
      probeClaudeDaemonCandidates,
    } = await loadDaemonControl();
    let { probe, recoveredFrom } = await probeDaemonTarget(
      payload,
      probeClaudeDaemonCandidates,
      false,
    );
    if (!probe.ok) return emitJson(daemonAttachProbeFailureResult(probe));
    const { findClaudeTranscript, readClaudeTranscript } = await import(
      "./team/claude-transcript.mjs"
    );
    const { contextGuard, modelContext } = await import(
      "./team/session-context.mjs"
    );
    let result;
    let context = modelContext("claude", null);
    let guard = {};
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const short = payload.short ?? probe.target?.short;
      if (!short) {
        return emitJson(
          daemonAttachProbeFailureResult({
            ...probe,
            reason: "target-not-found",
            error: "short or resolvable sessionId is required",
          }),
        );
      }
      const transcript = await findClaudeTranscript({
        configDir: probe.daemon?.configDir,
        sourceConfigDir: probe.daemon?.sourceConfigDir,
        sessionId: probe.target?.sessionId,
        cwd: probe.target?.cwd,
      });
      context =
        (await readClaudeTranscript(transcript).catch(() => null))?.context ??
        modelContext("claude", null);
      guard = contextGuard("claude", context, {
        warnContextPct: payload.warnContextPct,
        maxContextPct: payload.maxContextPct,
      });
      if (guard.ok === false) {
        return emitJson({
          ...guard,
          ...(recoveredFrom ? { recoveredFrom } : {}),
          ...daemonProbeMetadata(probe),
        });
      }
      const controlAuth = await buildDaemonControlAuth(
        probe.daemon?.configDir ?? payload.configDir,
      );
      try {
        result = await attachClaudeDaemonSession({
          controlSock: probe.controlSock,
          short,
          input: payload.prompt,
          ...controlAuth,
          cols: numericOption(payload.cols, undefined),
          rows: numericOption(payload.rows, undefined),
          timeoutMs: numericOption(payload.timeoutMs, 30_000),
          noWait: payload.noWait === true,
        });
        break;
      } catch (error) {
        if (
          attempt === 1 ||
          error?.code !== "ENOENT" ||
          error?.inputSent !== false
        ) {
          return emitJson({
            ...daemonAttachErrorResult(error),
            ...(recoveredFrom ? { recoveredFrom } : {}),
            ...daemonProbeMetadata(probe),
          });
        }
        const stale = probe.daemon;
        const recovered = await probeClaudeDaemonCandidates({
          ...daemonProbeOptions(payload),
          candidateSourceConfigDir: stale.sourceConfigDir ?? stale.configDir,
        });
        if (!recovered.ok) {
          return emitJson({
            ...daemonAttachErrorResult(error),
            ...daemonProbeMetadata(recovered),
          });
        }
        probe = recovered;
        recoveredFrom = stale;
      }
    }

    return emitJson({
      ok:
        payload.noWait === true
          ? result.inputSent === true
          : result.matchedCompletion === true,
      ...(payload.noWait === true
        ? {
            status:
              result.inputSent === true
                ? "submitted"
                : result.inputSent === false
                  ? "failed"
                  : "unknown",
            done: false,
            ...(result.inputSent === true
              ? { submittedAt: new Date().toISOString() }
              : {}),
            target: probe.target,
          }
        : {}),
      text: result.text,
      raw: result.streamText,
      responseRaw: result.responseStreamText,
      matchedCompletion: result.matchedCompletion === true,
      ...(payload.noWait === true
        ? {}
        : { timedOut: result.timedOut === true }),
      closed: result.closed === true,
      inputSent: result.inputSent ?? null,
      error:
        result.handshake?.ok === false ? result.handshake?.error : undefined,
      ...context,
      ...guard,
      ...(recoveredFrom ? { recoveredFrom } : {}),
      ...daemonProbeMetadata(probe),
    });
  } catch (error) {
    return emitJson(
      daemonAttachErrorResult({
        inputSent: false,
        message: error?.message || String(error),
      }),
    );
  }
}

async function cmdDaemonWait(args) {
  let requestId = null;
  const emptyContext = {
    estimatedContextTokens: null,
    contextLimitTokens: null,
    contextLimitSource: null,
    contextPct: null,
  };
  try {
    const payload = readBridgePayload(args);
    requestId = payload.requestId ?? null;
    if (!payload.short && !payload.sessionId)
      throw new Error("short or sessionId is required");
    const { probeClaudeDaemonCandidates } = await loadDaemonControl();
    const { findClaudeTranscript, readClaudeTranscript } = await import(
      "./team/claude-transcript.mjs"
    );
    const timeoutMs = numericOption(payload.timeoutMs, 30_000);
    const pollIntervalMs = Math.max(
      10,
      numericOption(payload.pollIntervalMs, 500),
    );
    const deadline = Date.now() + timeoutMs;
    let last = null;
    do {
      const probe = await probeClaudeDaemonCandidates({
        configDir: payload.configDir,
        env: process.env,
        short: payload.short,
        sessionId: payload.sessionId,
        timeoutMs: Math.max(1, Math.min(6000, deadline - Date.now())),
        tmpRoot: payload.tmpRoot,
        includeContext: false,
      });
      if (!probe.ok) {
        if (Date.now() >= deadline) {
          return emitJson({
            ...(last ?? emptyContext),
            ok: true,
            status: "working",
            done: false,
            timedOut: true,
            requestId,
          });
        }
        return emitJson({
          ok: false,
          status: "unknown",
          done: false,
          timedOut: false,
          ...emptyContext,
          requestId,
          ...daemonProbeMetadata(probe),
          error: probe.error || probe.reason,
        });
      }
      const transcriptPath = await findClaudeTranscript({
        configDir: probe.daemon?.configDir,
        sourceConfigDir: probe.daemon?.sourceConfigDir,
        sessionId: probe.target?.sessionId,
        cwd: probe.target?.cwd,
      });
      const transcript = await readClaudeTranscript(transcriptPath, {
        requestId: payload.requestId,
      });
      const context = transcript?.context ?? emptyContext;
      const idle = [
        probe.target?.state,
        probe.target?.status,
        probe.target?.tempo,
      ].some((value) =>
        ["idle", "done", "ready"].includes(String(value || "").toLowerCase()),
      );
      last = {
        ok: true,
        status: transcript?.userSeen ? "working" : "submitted",
        done: false,
        timedOut: false,
        response: transcript?.response || "",
        ...context,
        requestId,
        target: probe.target,
        ...daemonProbeMetadata(probe),
      };
      if (transcript?.error) {
        return emitJson({
          ...last,
          ok: false,
          status: "failed",
          error: transcript.error,
        });
      }
      if (
        (idle || transcript?.sectionClosed) &&
        transcript?.userSeen &&
        transcript.turnEnded
      ) {
        if (!transcript.response.trim())
          return emitJson({
            ...last,
            ok: false,
            status: "failed",
            error: "turn ended without assistant text",
          });
        return emitJson({ ...last, status: "completed", done: true });
      }
      if (Date.now() >= deadline) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, deadline - Date.now())),
      );
    } while (Date.now() < deadline);
    return emitJson({ ...last, status: "working", timedOut: true });
  } catch (error) {
    return emitJson({
      ...daemonErrorResult(error),
      status: "unknown",
      done: false,
      timedOut: false,
      ...emptyContext,
      requestId,
    });
  }
}

async function cmdDaemonInterrupt(args) {
  try {
    const payload = readBridgePayload(args);

    const {
      buildDaemonControlAuth,
      interruptClaudeDaemonSession,
      probeClaudeDaemonCandidates,
    } = await loadDaemonControl();
    const probe = await probeClaudeDaemonCandidates({
      configDir: payload.configDir,
      env: process.env,
      short: payload.short,
      sessionId: payload.sessionId,
      timeoutMs: numericOption(payload.timeoutMs, 6000),
      tmpRoot: payload.tmpRoot,
    });
    if (!probe.ok) return emitJson(daemonInterruptProbeFailureResult(probe));
    const short = payload.short ?? probe.target?.short;
    if (!short) {
      return emitJson(
        daemonInterruptProbeFailureResult({
          ...probe,
          ok: false,
          reason: "target-not-found",
          error: "short or resolvable sessionId is required",
        }),
      );
    }
    const controlAuth = await buildDaemonControlAuth(
      probe.daemon?.configDir ?? payload.configDir,
    );

    let result;
    try {
      result = await interruptClaudeDaemonSession({
        controlSock: probe.controlSock,
        short,
        ...controlAuth,
        cols: numericOption(payload.cols, undefined),
        rows: numericOption(payload.rows, undefined),
        timeoutMs: numericOption(payload.timeoutMs, 5000),
      });
    } catch (error) {
      return emitJson({
        ...daemonInterruptErrorResult(error),
        ...daemonProbeMetadata(probe),
      });
    }
    const aborted = result.inputSent === true;

    return emitJson({
      ok: aborted,
      done: false,
      aborted,
      reason: aborted ? "user_interrupt" : "interrupt_failed",
      raw: result.streamText,
      timedOut: result.timedOut === true,
      closed: result.closed === true,
      inputSent: result.inputSent === true,
      error:
        result.handshake?.ok === false ? result.handshake?.error : undefined,
      ...daemonProbeMetadata(probe),
    });
  } catch (error) {
    return emitJson(daemonInterruptErrorResult(error));
  }
}

// ---------------------------------------------------------------------------
// retry-run / retry-status — Phase 3 Step C2 bridge 서브커맨드.
// retry-state-machine.mjs 를 multi-process safe 하게 외부 호출용 wrap.
// 사용자 워크플로우:
//   1) 첫 호출: retry-run --snapshot X --mode ralph --event start
//      → 새 SM 생성, PLANNING → EXECUTING transition, snapshot 저장
//   2) verify 성공 시: retry-run --snapshot X --event verify-success
//      → DONE, 종료 판단 반환
//   3) verify 실패 시: retry-run --snapshot X --event verify-fail --reason R
//      → DIAGNOSING 또는 STUCK/BUDGET_EXCEEDED, 종료 판단 반환
//   4) 다음 iter 시작: retry-run --snapshot X --event start
// 출력: {ok, current, iterations, done, shouldStop, reason?, cli?} JSON.
// ---------------------------------------------------------------------------

function buildRetrySmFromArgs(args, snapshot) {
  const mode = args.mode || snapshot?.mode || "bounded";
  const maxIterations =
    args["max-iterations"] !== undefined
      ? Number(args["max-iterations"])
      : snapshot?.maxIterations;
  const sessionId = args["session-id"] || snapshot?.sessionId || null;
  const cliChain = snapshot?.cliChain;

  const sm = createRetryStateMachine({
    mode,
    maxIterations,
    sessionId,
    cliChain,
  });
  if (snapshot) sm.applySnapshot(snapshot);
  return sm;
}

function buildRetryCliInvocation(cli) {
  if (!cli) return null;

  const invocation = {
    cli: cli.cli,
    model: cli.model,
    argv: [],
  };
  if (cli.profile) invocation.profile = cli.profile;
  if (cli.cli === "codex" && cli.profile) {
    invocation.argv.push("--profile", cli.profile);
  }
  return invocation;
}

async function cmdRetryRun(args) {
  const snapshotFile = args.snapshot || args["snapshot-file"];
  const event = args.event;
  const reason = args.reason || "";

  if (!snapshotFile) {
    console.error("--snapshot <path> required");
    return false;
  }
  if (!event) {
    console.error("--event <start|verify-success|verify-fail> required");
    return false;
  }

  const existing = loadSnapshot(snapshotFile);
  const sm = buildRetrySmFromArgs(args, existing);

  let result;
  switch (event) {
    case "start":
      result = sm.startIteration();
      break;
    case "verify-success":
      result = sm.reportVerifySuccess();
      break;
    case "verify-fail":
      result = sm.reportVerifyFail(reason || "unspecified");
      break;
    default:
      console.error(`unknown --event: ${event}`);
      return false;
  }

  const snap = sm.serialize();
  saveSnapshot(snapshotFile, snap);

  const terminal = ["DONE", "STUCK", "BUDGET_EXCEEDED"].includes(snap.current);
  const cli = snap.cliChain?.[snap.cliIndex] || null;
  const cliInvocation = buildRetryCliInvocation(cli);
  const out = {
    ok: true,
    current: snap.current,
    iterations: snap.iterations,
    cliIndex: snap.cliIndex,
    cli,
    cliInvocation,
    done: snap.current === "DONE",
    shouldStop: terminal,
    stuckCounter: snap.stuckCounter,
    lastFailureReason: snap.lastFailureReason,
    transition: result,
  };
  console.log(JSON.stringify(out));
  return true;
}

async function cmdRetryStatus(args) {
  const snapshotFile = args.snapshot || args["snapshot-file"];
  if (!snapshotFile) {
    console.error("--snapshot <path> required");
    return false;
  }
  const snap = loadSnapshot(snapshotFile);
  if (!snap) {
    console.log(JSON.stringify({ ok: true, exists: false }));
    return true;
  }
  const terminal = ["DONE", "STUCK", "BUDGET_EXCEEDED"].includes(snap.current);
  const cli = snap.cliChain?.[snap.cliIndex] || null;
  const cliInvocation = buildRetryCliInvocation(cli);
  console.log(
    JSON.stringify({
      ok: true,
      exists: true,
      current: snap.current,
      iterations: snap.iterations,
      maxIterations: snap.maxIterations,
      cliIndex: snap.cliIndex,
      cli,
      cliInvocation,
      mode: snap.mode,
      shouldStop: terminal,
      stuckCounter: snap.stuckCounter,
      lastFailureReason: snap.lastFailureReason,
    }),
  );
  return true;
}

// intervene-run은 순수 로컬 모듈만 호출한다.
async function cmdInterveneRun(args) {
  try {
    const payload = readBridgePayload(args);
    const intervention = await import("./team/intervention.mjs");
    let rolloutFile = payload.rolloutFile || null;
    if (!rolloutFile && payload.cli === "codex" && payload.pid) {
      rolloutFile = await intervention.resolveCodexRolloutFile({
        pid: numericOption(payload.pid, undefined),
        codexHome: payload.codexHome,
      });
    }
    const seconds = (value) => {
      const parsed = numericOption(value, undefined);
      return parsed > 0 ? parsed * 1_000 : undefined;
    };
    const readActivitySignature = intervention.createFileActivitySource({
      files: [payload.stdoutLog, payload.stderrLog, payload.resultFile].filter(
        Boolean,
      ),
      rolloutFile,
    });
    const ladder = intervention.createInterventionLadder({
      target: {
        channel: payload.channel,
        pid: numericOption(payload.pid, undefined),
        paneId: payload.paneId,
        interactive: payload.interactive === true,
        cli: payload.cli,
        sessionId: payload.sessionId,
        codexHome: payload.codexHome,
        rolloutFile,
        daemon: payload.daemon,
      },
      reinstructPrompt: payload.reinstructPrompt || undefined,
      readActivitySignature,
      config: {
        ...(seconds(payload.reinstructWaitSec)
          ? { reinstructWaitMs: seconds(payload.reinstructWaitSec) }
          : {}),
        ...(seconds(payload.resumeWaitSec)
          ? { resumeWaitMs: seconds(payload.resumeWaitSec) }
          : {}),
        ...(seconds(payload.sigtermGraceSec)
          ? { sigtermGraceMs: seconds(payload.sigtermGraceSec) }
          : {}),
      },
      log: (event) =>
        process.stderr.write(`[tfx-intervene] ${JSON.stringify(event)}\n`),
    });
    return emitJson(await ladder.intervene());
  } catch (error) {
    return emitJson({
      ok: false,
      outcome: "failed",
      step: null,
      error: error?.message || String(error),
    });
  }
}

export async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case "team-info":
      return await cmdTeamInfo(args);
    case "team-task-list":
      return await cmdTeamTaskList(args);
    case "team-task-update":
      return await cmdTeamTaskUpdate(args);
    case "team-send-message":
      return await cmdTeamSendMessage(args);
    case "daemon-probe":
      return await cmdDaemonProbe(args);
    case "daemon-attach":
      return await cmdDaemonAttach(args);
    case "daemon-wait":
      return await cmdDaemonWait(args);
    case "daemon-interrupt":
      return await cmdDaemonInterrupt(args);
    case "retry-run":
      return await cmdRetryRun(args);
    case "retry-status":
      return await cmdRetryStatus(args);
    case "intervene-run":
      return await cmdInterveneRun(args);
    default:
      console.error(
        "사용법: bridge.mjs <team-info|team-task-list|team-task-update|team-send-message|daemon-probe|daemon-attach|daemon-wait|daemon-interrupt|retry-run|retry-status|intervene-run> [--옵션]",
      );
      process.exit(1);
  }
}

const selfRun = process.argv[1]?.replace(/\\/g, "/").endsWith("hub/bridge.mjs");
if (selfRun) {
  process.exitCode = (await main()) ? 0 : 1;
}

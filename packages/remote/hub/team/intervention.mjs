// 무활동 감지는 호출자 소유다. 이 모듈은 개입 사다리만 집행한다.
// ① interrupt+재지시 → ② graceful+resume → ③ SIGTERM → ④ SIGKILL
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { readdir, readlink } from "node:fs/promises";
import { promisify } from "node:util";
import { isPidAlive } from "@triflux/core/hub/lib/process-utils.mjs";
import { killProcess } from "@triflux/core/hub/platform.mjs";
import {
  resolveHardCeilingMs,
  resolveStallInterventionMs as resolveStallThresholdMs,
} from "@triflux/core/hub/lib/timeout-defaults.mjs";

export { resolveHardCeilingMs, resolveStallThresholdMs };

export const CHANNELS = Object.freeze({
  CLAUDE_DAEMON: "claude-daemon",
  TMUX_PANE: "tmux-pane",
  CODEX_APP_SERVER: "codex-app-server",
  PROCESS: "process",
});

export const STEPS = Object.freeze({
  REINSTRUCT: "reinstruct",
  RESUME: "resume",
  SIGTERM: "sigterm",
  SIGKILL: "sigkill",
});

export const INTERVENTION_DEFAULTS = Object.freeze({
  interruptSettleMs: 3_000,
  reinstructInjectTimeoutMs: 8_000,
  reinstructWaitMs: 300_000,
  resumeDispatchTimeoutMs: 60_000,
  resumeWaitMs: 300_000,
  activityPollMs: 5_000,
  sigtermGraceMs: 5_000,
});

export const DEFAULT_REINSTRUCT_PROMPT =
  "[triflux intervention] 무활동이 감지되어 인터럽트했다. 직전 작업을 이어가라: " +
  "1) 마지막으로 완료한 단계를 한 줄로 요약하고, 2) 남은 단계를 계속 진행하라. " +
  "장시간 침묵하는 단일 도구 호출 대신 진행 상황을 주기적으로 출력하라.";

const ROLLOUT_UUID_RE =
  /rollout-.*-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/u;
const execFileAsync = promisify(execFile);
const resumeCapabilityCache = new Map();

function positiveSeconds(env, key) {
  const value = Number.parseInt(String(env?.[key] ?? ""), 10);
  return Number.isFinite(value) && value > 0 ? value * 1_000 : undefined;
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function detectChannel(target = {}) {
  if (Object.values(CHANNELS).includes(target.channel)) return target.channel;
  if (target.appServer?.client && target.appServer?.threadId)
    return CHANNELS.CODEX_APP_SERVER;
  if (
    target.daemon?.controlSock &&
    (target.daemon.short || target.daemon.sessionId)
  )
    return CHANNELS.CLAUDE_DAEMON;
  if (typeof target.paneId === "string" && target.paneId)
    return CHANNELS.TMUX_PANE;
  if (Number.isInteger(target.pid) && target.pid > 0) return CHANNELS.PROCESS;
  return null;
}

export function extractCodexSessionIdFromRolloutPath(rolloutPath) {
  const match = ROLLOUT_UUID_RE.exec(String(rolloutPath || ""));
  return match ? match[1].toLowerCase() : null;
}

function isRolloutPath(value, codexHome) {
  const file = String(value || "").replaceAll("\\", "/");
  const home = String(codexHome || "")
    .replaceAll("\\", "/")
    .replace(/\/$/u, "");
  return (
    /\/sessions\/.*\/rollout-[^/]+\.jsonl$/u.test(file) &&
    (!home || file.startsWith(`${home}/sessions/`))
  );
}

/** Best-effort only: neither failure nor a missing open rollout is exceptional. */
export async function resolveCodexRolloutFile({
  pid,
  codexHome,
  deps = {},
} = {}) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  const run = deps.execFileAsync || execFileAsync;
  const candidates = [];

  try {
    const result = await run("lsof", ["-Fn", "-p", String(numericPid)], {
      timeout: 5_000,
    });
    const output = typeof result === "string" ? result : result?.stdout;
    for (const line of String(output || "").split(/\r?\n/u)) {
      if (line.startsWith("n") && isRolloutPath(line.slice(1), codexHome))
        candidates.push(line.slice(1));
    }
  } catch {
    // Linux /proc fallback below; macOS simply returns null if lsof is unavailable.
  }

  if (candidates.length) return candidates[0];
  const list = deps.readdir || readdir;
  const link = deps.readlink || readlink;
  try {
    for (const fd of await list(`/proc/${numericPid}/fd`)) {
      const candidate = await link(`/proc/${numericPid}/fd/${fd}`);
      if (isRolloutPath(candidate, codexHome)) return candidate;
    }
  } catch {
    // /proc is intentionally optional (macOS/Windows do not expose it).
  }
  return null;
}

export function buildResumeArgv({ cli, sessionId, prompt } = {}) {
  if (!sessionId) return null;
  if (cli === "claude") return ["claude", "-p", "--resume", sessionId, prompt];
  if (cli === "codex") return ["codex", "exec", "resume", sessionId, prompt];
  return null;
}

export async function probeResumeCapability(
  cli,
  { execFileAsync: run = execFileAsync, cache = resumeCapabilityCache } = {},
) {
  if (cache.has(cli)) return cache.get(cli);
  let supported = false;
  try {
    if (cli === "claude") supported = true;
    else if (cli === "codex") {
      await run("codex", ["exec", "resume", "--help"], { timeout: 8_000 });
      supported = true;
    }
  } catch {
    supported = false;
  }
  cache.set(cli, supported);
  return supported;
}

export function createFileActivitySource({
  files = [],
  rolloutFile = null,
  deps = {},
} = {}) {
  const stat = deps.statSync || statSync;
  const targets = [...files, ...(rolloutFile ? [rolloutFile] : [])].filter(
    Boolean,
  );
  return () =>
    targets
      .map((file) => {
        try {
          const current = stat(file);
          return `${current.size}:${Math.floor(current.mtimeMs)}`;
        } catch {
          return "-";
        }
      })
      .join("|");
}

function defaultCli(channel, target) {
  if (target.cli) return target.cli;
  if (channel === CHANNELS.CLAUDE_DAEMON) return "claude";
  if (channel === CHANNELS.CODEX_APP_SERVER) return "codex";
  return null;
}

function processPid(target) {
  const pid = Number(target.pid || target.appServer?.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export function createInterventionLadder({
  target = {},
  reinstructPrompt = DEFAULT_REINSTRUCT_PROMPT,
  readActivitySignature,
  config = {},
  log = () => {},
  deps = {},
} = {}) {
  if (typeof readActivitySignature !== "function")
    throw new Error(
      "createInterventionLadder requires readActivitySignature()",
    );

  const cfg = {
    ...INTERVENTION_DEFAULTS,
    ...(positiveSeconds(process.env, "TFX_INTERVENTION_REINSTRUCT_WAIT_SEC")
      ? {
          reinstructWaitMs: positiveSeconds(
            process.env,
            "TFX_INTERVENTION_REINSTRUCT_WAIT_SEC",
          ),
        }
      : {}),
    ...(positiveSeconds(process.env, "TFX_INTERVENTION_RESUME_WAIT_SEC")
      ? {
          resumeWaitMs: positiveSeconds(
            process.env,
            "TFX_INTERVENTION_RESUME_WAIT_SEC",
          ),
        }
      : {}),
    ...config,
  };
  const sleep = deps.sleep || sleepFor;
  const alive = deps.isPidAlive || isPidAlive;
  const kill = deps.killProcess || killProcess;
  const state = { step: null, attempts: [] };
  let emit = () => {};

  const loadDaemonControl = async () =>
    deps.daemonControl || (await import("./claude-daemon-control.mjs"));
  const loadPane = async () => {
    if (deps.psmuxExec && deps.injectPrompt)
      return { psmuxExec: deps.psmuxExec, injectPrompt: deps.injectPrompt };
    const [{ psmuxExec }, { injectPrompt }] = await Promise.all([
      import("./psmux.mjs"),
      import("./pane.mjs"),
    ]);
    return { psmuxExec, injectPrompt };
  };
  const loadPsmux = async () => {
    if (deps.psmuxExec) return deps.psmuxExec;
    return (await import("./psmux.mjs")).psmuxExec;
  };

  async function signature() {
    return await readActivitySignature();
  }

  async function waitForActivity(baseline, waitMs) {
    const deadline = Date.now() + waitMs;
    do {
      if ((await signature()) !== baseline) return true;
      if (Date.now() >= deadline) break;
      await sleep(
        Math.min(cfg.activityPollMs, Math.max(0, deadline - Date.now())),
      );
    } while (Date.now() < deadline);
    return (await signature()) !== baseline;
  }

  async function record(step, action) {
    const startedAt = Date.now();
    emit({ step, phase: "start" });
    let result;
    try {
      result = await action();
    } catch {
      result = { ok: false, detail: "operation_failed" };
    }
    const attempt = {
      step,
      ok: result?.ok === true,
      detail: result?.detail || (result?.ok ? "ok" : "operation_failed"),
      startedAt,
      endedAt: Date.now(),
    };
    state.attempts.push(attempt);
    emit({ step, phase: "end", ok: attempt.ok, detail: attempt.detail });
    return attempt;
  }

  async function tryReinstruct(channel) {
    return await record(STEPS.REINSTRUCT, async () => {
      if (channel === CHANNELS.CLAUDE_DAEMON) {
        const daemon = target.daemon || {};
        let control;
        try {
          control = await loadDaemonControl();
        } catch {
          return { ok: false, detail: "channel_unavailable" };
        }
        const auth =
          (await control.buildDaemonControlAuth?.(daemon.configDir)) || {};
        const interrupted = await control.interruptClaudeDaemonSession({
          controlSock: daemon.controlSock,
          short: daemon.short,
          ...auth,
        });
        if (interrupted?.inputSent !== true)
          return { ok: false, detail: "interrupt_not_delivered" };
        await sleep(cfg.interruptSettleMs);
        const attached = await control.attachClaudeDaemonSession({
          controlSock: daemon.controlSock,
          short: daemon.short,
          input: reinstructPrompt,
          ...auth,
          timeoutMs: cfg.reinstructInjectTimeoutMs,
          completionQuiescenceMs: 0,
        });
        return attached?.inputSent === true
          ? { ok: true, detail: "injected" }
          : { ok: false, detail: "inject_failed" };
      }
      if (channel === CHANNELS.TMUX_PANE) {
        if (target.interactive !== true)
          return { ok: false, detail: "headless_pane_no_input_channel" };
        let pane;
        try {
          pane = await loadPane();
        } catch {
          return { ok: false, detail: "channel_unavailable" };
        }
        await pane.psmuxExec([
          "send-keys",
          "-t",
          target.paneId,
          target.cli === "claude" ? "Escape" : "C-c",
        ]);
        await sleep(cfg.interruptSettleMs);
        await pane.injectPrompt(target.paneId, reinstructPrompt, {
          cli: target.cli || null,
        });
        return { ok: true, detail: "injected" };
      }
      if (channel === CHANNELS.CODEX_APP_SERVER) {
        const { client, threadId } = target.appServer || {};
        await client.request("turn/interrupt", { threadId }, 10_000);
        await client.request(
          "turn/start",
          { threadId, input: [{ type: "text", text: reinstructPrompt }] },
          30_000,
        );
        return { ok: true, detail: "injected" };
      }
      return { ok: false, detail: "channel_unsupported" };
    });
  }

  async function resolveSessionId(channel, cli) {
    if (target.sessionId) return target.sessionId;
    if (target.daemon?.sessionId) return target.daemon.sessionId;
    if (channel === CHANNELS.CODEX_APP_SERVER)
      return target.appServer?.threadId || null;
    const direct = extractCodexSessionIdFromRolloutPath(target.rolloutFile);
    if (direct) return direct;
    if (cli !== "codex") return null;
    const resolveRollout =
      deps.resolveCodexRolloutFile || resolveCodexRolloutFile;
    const rolloutFile = await resolveRollout({
      pid: processPid(target),
      codexHome: target.codexHome,
      deps,
    });
    return extractCodexSessionIdFromRolloutPath(rolloutFile);
  }

  async function terminate(
    channel,
    { force = false, recordAttempt = true } = {},
  ) {
    const step = force ? STEPS.SIGKILL : STEPS.SIGTERM;
    const signal = force ? "SIGKILL" : "SIGTERM";
    const action = async () => {
      if (channel === CHANNELS.CLAUDE_DAEMON) {
        const daemon = target.daemon || {};
        let control;
        try {
          control = await loadDaemonControl();
        } catch {
          return { ok: false, detail: "channel_unavailable" };
        }
        const auth =
          (await control.buildDaemonControlAuth?.(daemon.configDir)) || {};
        const sessionId = target.sessionId || daemon.sessionId;
        const result = sessionId
          ? await control.sendKillBySessionId({
              daemonPaths: {
                controlSock: daemon.controlSock,
                configDir: daemon.configDir,
              },
              sessionId,
              ...auth,
            })
          : await control.killDaemonJob?.(
              daemon.controlSock,
              daemon.short,
              auth,
            );
        return result?.ok === true
          ? { ok: true, detail: "daemon_killed" }
          : { ok: false, detail: "daemon_kill_failed" };
      }

      if (channel === CHANNELS.TMUX_PANE) {
        let psmuxExec;
        try {
          psmuxExec = await loadPsmux();
        } catch {
          return { ok: false, detail: "channel_unavailable" };
        }
        const output = await psmuxExec([
          "list-panes",
          "-t",
          target.paneId,
          "-F",
          "#{pane_pid}",
        ]);
        const panePid = Number(
          String(output || "")
            .trim()
            .split(/\s+/u)[0],
        );
        if (!Number.isInteger(panePid) || panePid <= 0) {
          if (!force) return { ok: false, detail: "pane_pid_unavailable" };
          await psmuxExec(["kill-pane", "-t", target.paneId]);
          return { ok: true, detail: "pane_killed" };
        }
        const sent = kill(panePid, {
          signal,
          tree: true,
          ...(force ? { force: true } : {}),
        });
        if (!sent) return { ok: false, detail: "signal_failed" };
        await sleep(
          force ? Math.min(cfg.sigtermGraceMs, 250) : cfg.sigtermGraceMs,
        );
        if (!alive(panePid)) return { ok: true, detail: "terminated" };
        if (force) await psmuxExec(["kill-pane", "-t", target.paneId]);
        return { ok: false, detail: "still_alive" };
      }

      const pid = processPid(target);
      if (!pid) return { ok: false, detail: "pid_unavailable" };
      const sent = kill(pid, {
        signal,
        tree: true,
        ...(force ? { force: true } : {}),
      });
      if (!sent) return { ok: false, detail: "signal_failed" };
      await sleep(
        force ? Math.min(cfg.sigtermGraceMs, 250) : cfg.sigtermGraceMs,
      );
      return !alive(pid)
        ? { ok: true, detail: "terminated" }
        : { ok: false, detail: "still_alive" };
    };
    return recordAttempt ? await record(step, action) : await action();
  }

  async function tryResume(channel) {
    return await record(STEPS.RESUME, async () => {
      const cli = defaultCli(channel, target);
      const probe = deps.probeResumeCapability || probeResumeCapability;
      const supported = await probe(cli, { execFileAsync: deps.execFileAsync });
      if (!supported) return { ok: false, detail: "capability_unsupported" };
      const sessionId = await resolveSessionId(channel, cli);
      if (!sessionId) return { ok: false, detail: "session_id_unavailable" };
      if (typeof deps.resumeHandler !== "function")
        return { ok: false, detail: "no_resume_handler" };

      // A resume handler owns relaunching; only stop after all prerequisites exist.
      const stopped = await terminate(channel, { recordAttempt: false });
      if (!stopped.ok) return { ok: false, detail: "graceful_stop_failed" };
      const resumed = await deps.resumeHandler({
        cli,
        sessionId,
        prompt: reinstructPrompt,
        target,
        argv: buildResumeArgv({ cli, sessionId, prompt: reinstructPrompt }),
      });
      return resumed?.ok === false
        ? { ok: false, detail: "resume_dispatch_failed" }
        : { ok: true, detail: "resume_dispatched" };
    });
  }

  async function intervene() {
    state.step = null;
    state.attempts.length = 0;
    const channel = detectChannel(target);
    emit = (event) => {
      try {
        log({ ts: Date.now(), channel, ...event });
      } catch {
        // Logging must never change recovery behaviour.
      }
    };

    const finish = (outcome, step) => {
      state.step = step;
      return {
        ok: outcome !== "failed",
        outcome,
        step,
        channel,
        attempts: [...state.attempts],
      };
    };

    if (channel && channel !== CHANNELS.PROCESS) {
      const baseline = await signature();
      const attempt = await tryReinstruct(channel);
      if (attempt.ok && (await waitForActivity(baseline, cfg.reinstructWaitMs)))
        return finish("reactivated", STEPS.REINSTRUCT);
    }

    const resumeBaseline = await signature();
    const resumed = await tryResume(channel);
    if (resumed.ok && (await waitForActivity(resumeBaseline, cfg.resumeWaitMs)))
      return finish("resumed", STEPS.RESUME);

    const terminated = await terminate(channel);
    if (terminated.ok) return finish("terminated", STEPS.SIGTERM);
    const killed = await terminate(channel, { force: true });
    return finish(killed.ok ? "killed" : "failed", STEPS.SIGKILL);
  }

  return Object.freeze({
    intervene,
    getState: () => ({ step: state.step, attempts: [...state.attempts] }),
  });
}

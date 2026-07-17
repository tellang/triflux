import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = dirname(MODULE_DIR);
const REQUIRED_CAPABILITIES = ["probe", "wake", "activate"];

function opaqueHostId(value) {
  return `hst_${createHash("sha256")
    .update(String(value || ""))
    .digest("base64url")
    .slice(0, 22)}`;
}

function parseJsonOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/u);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {}
    }
    return {};
  }
}

function seconds(timeoutMs, fallbackMs) {
  const value = Number(timeoutMs);
  return String(
    Math.max(1, Math.ceil((value > 0 ? value : fallbackMs) / 1000)),
  );
}

function reasonFromError(error) {
  if (error?.name === "AbortError") return "timeout";
  if (error?.code === "ETIMEDOUT" || error?.killed) return "timeout";
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return "permission_denied";
  }
  if (error?.code === "ENOENT") return "adapter_unavailable";
  if (Number(error?.code) === 1) return "target_not_found";
  return "transport_error";
}

function probeResult(locator, startedAt, observedAt, patch) {
  return {
    schema_version: "tfx-live.transport-probe.v1",
    ok: false,
    reachable: false,
    wakeable: false,
    transport_selected: locator?.kind ?? null,
    transport_id: locator?.transport_id ?? "unknown",
    host_id: locator?.host_id ?? "unknown",
    latency_ms: Math.max(0, observedAt - startedAt),
    observed_at_ms: observedAt,
    reason_code: "transport_error",
    ...patch,
  };
}

function defaultSessionName(roleKey) {
  const suffix = globalThis.crypto.randomUUID().slice(0, 8);
  return `tfx-role-${roleKey.role_kind}-${suffix}`;
}

function activationPrompt(activation) {
  return JSON.stringify(activation);
}

export function createTfxLiveRoleAdapter(options = {}) {
  const projectRoot = options.projectRoot || DEFAULT_ROOT;
  const defaultTfxLivePath = join(projectRoot, "bin", "tfx-live.mjs");
  const tfxLivePath = options.tfxLivePath || defaultTfxLivePath;
  const tfxLiveCommand =
    options.tfxLiveCommand ||
    (!options.tfxLivePath && !existsSync(defaultTfxLivePath)
      ? "tfx-live"
      : null);
  const bridgePath =
    options.bridgePath || join(projectRoot, "hub", "bridge.mjs");
  const nodePath = options.nodePath || process.execPath;
  const tmuxPath = options.tmuxPath || "tmux";
  const localHostId =
    options.localHostId || opaqueHostId(options.hostname?.() || hostname());
  const muxServerId = options.muxServerId || "mux_local";
  const now = options.now || Date.now;
  const sessionName = options.sessionName || defaultSessionName;
  const runProcess =
    options.runProcess ||
    (async (command, args, processOptions = {}) =>
      await execFileAsync(command, args, {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        ...processOptions,
      }));
  const active = new Map();

  function runTfxLive(args, processOptions) {
    return tfxLiveCommand
      ? runProcess(tfxLiveCommand, args, processOptions)
      : runProcess(nodePath, [tfxLivePath, ...args], processOptions);
  }

  function supports(locator) {
    return (
      locator?.schema_version === "tfx.transport-locator.v1" &&
      locator.host_id === localHostId &&
      (locator.kind === "claude-uds" || locator.kind === "tmux") &&
      Array.isArray(locator.capabilities) &&
      REQUIRED_CAPABILITIES.every((capability) =>
        locator.capabilities.includes(capability),
      )
    );
  }

  async function probe(locator, probeOptions = {}) {
    const startedAt = now();
    if (!supports(locator)) {
      return probeResult(locator, startedAt, now(), {
        reason_code: "adapter_unavailable",
      });
    }
    try {
      if (locator.kind === "tmux") {
        await runProcess(
          tmuxPath,
          ["has-session", "-t", locator.locator.session_name],
          {
            timeout: probeOptions.timeout_ms,
            signal: probeOptions.signal,
          },
        );
      } else {
        const refArgs = locator.locator.session_id
          ? ["--session-id", locator.locator.session_id]
          : ["--short", locator.locator.short];
        const result = await runTfxLive(
          [
            "probe",
            ...refArgs,
            "--bridge",
            bridgePath,
            "--timeout",
            seconds(probeOptions.timeout_ms, 10_000),
          ],
          {
            timeout: probeOptions.timeout_ms,
            signal: probeOptions.signal,
          },
        );
        const payload = parseJsonOutput(result.stdout);
        if (payload.ok !== true) {
          return probeResult(locator, startedAt, now(), {
            reason_code:
              payload.reason_code || payload.reason || "target_not_found",
          });
        }
      }
      return probeResult(locator, startedAt, now(), {
        ok: true,
        reachable: true,
        wakeable: true,
        reason_code: "ok",
      });
    } catch (error) {
      return probeResult(locator, startedAt, now(), {
        reason_code: reasonFromError(error),
      });
    }
  }

  function liveArgs(locator, cli, verb) {
    if (locator.kind === "tmux") {
      return [
        verb,
        "--cli",
        cli,
        "--transport",
        "tmux",
        "--session",
        locator.locator.session_name,
      ];
    }
    const refArgs = locator.locator.session_id
      ? ["--session-id", locator.locator.session_id]
      : ["--short", locator.locator.short];
    return [
      verb,
      "--cli",
      "claude",
      "--transport",
      "uds",
      ...refArgs,
      "--bridge",
      bridgePath,
    ];
  }

  async function wake(locator, activation, wakeOptions = {}) {
    if (!supports(locator)) {
      return { ok: false, reason_code: "adapter_unavailable" };
    }
    const cli = activation?.holder_cli === "codex" ? "codex" : "claude";
    const args = [
      ...liveArgs(locator, cli, "ask"),
      "--prompt",
      activationPrompt(activation),
      "--timeout",
      seconds(wakeOptions.timeout_ms, 10_000),
    ];
    try {
      const result = await runTfxLive(args, {
        timeout: wakeOptions.timeout_ms,
        signal: wakeOptions.signal,
      });
      const payload = parseJsonOutput(result.stdout);
      if (payload.ok === false) {
        return {
          ok: false,
          reason_code: payload.reason_code || "transport_error",
        };
      }
      active.set(activation.activation_id, { locator, cli });
      return { ok: true, transport_id: locator.transport_id };
    } catch (error) {
      return { ok: false, reason_code: reasonFromError(error) };
    }
  }

  async function standup(roleKey, cli, standupOptions = {}) {
    const name = sessionName(roleKey);
    await runTfxLive(
      [
        "start",
        "--session",
        name,
        "--cli",
        cli,
        "--cwd",
        projectRoot,
        "--ready-timeout",
        seconds(standupOptions.timeout_ms, 60_000),
      ],
      {
        timeout: standupOptions.timeout_ms,
        signal: standupOptions.signal,
      },
    );
    return {
      schema_version: "tfx.transport-locator.v1",
      transport_id: `standup:${name}`,
      kind: "tmux",
      host_id: localHostId,
      capabilities: ["probe", "wake", "activate", "interrupt"],
      priority: 100,
      expires_at_ms: now() + 300_000,
      locator: { session_name: name, mux_server_id: muxServerId },
    };
  }

  async function cancel(activationId) {
    const target = active.get(activationId);
    if (!target) return false;
    active.delete(activationId);
    try {
      await runTfxLive(
        [
          ...liveArgs(target.locator, target.cli, "interrupt"),
          "--timeout",
          "5",
        ],
        { timeout: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  return { supports, probe, wake, standup, cancel };
}

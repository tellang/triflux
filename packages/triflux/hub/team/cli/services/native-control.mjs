import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildExecArgs } from "../../../codex-adapter.mjs";
import { buildLeadPrompt, buildPrompt } from "../../orchestrator.mjs";
import { HUB_PID_DIR, PKG_ROOT } from "./state-store.mjs";

export function buildNativeCliCommand(cli) {
  switch (cli) {
    case "codex":
      return buildExecArgs({});
    case "gemini":
      return "gemini";
    case "claude":
      return "claude";
    default:
      return cli;
  }
}

export async function startNativeSupervisor({
  sessionId,
  task,
  lead,
  agents,
  subtasks,
  hubUrl,
}) {
  const configPath = join(HUB_PID_DIR, `team-native-${sessionId}.config.json`);
  const runtimePath = join(
    HUB_PID_DIR,
    `team-native-${sessionId}.runtime.json`,
  );
  const logsDir = join(HUB_PID_DIR, "team-logs", sessionId);
  mkdirSync(logsDir, { recursive: true });

  const leadMember = {
    role: "lead",
    name: "lead",
    cli: lead,
    agentId: `${lead}-lead`,
    command: buildNativeCliCommand(lead),
  };
  const workers = agents.map((cli, index) => ({
    role: "worker",
    name: `${cli}-${index + 1}`,
    cli,
    agentId: `${cli}-w${index + 1}`,
    command: buildNativeCliCommand(cli),
    subtask: subtasks[index],
  }));
  const members = [
    {
      ...leadMember,
      prompt: buildLeadPrompt(task, {
        agentId: leadMember.agentId,
        hubUrl,
        teammateMode: "in-process",
        workers: workers.map((worker) => ({
          agentId: worker.agentId,
          cli: worker.cli,
          subtask: worker.subtask,
        })),
      }),
    },
    ...workers.map((worker) => ({
      ...worker,
      prompt: buildPrompt(worker.subtask, {
        cli: worker.cli,
        agentId: worker.agentId,
        hubUrl,
      }),
    })),
  ];

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        sessionName: sessionId,
        hubUrl,
        startupDelayMs: 3000,
        logsDir,
        runtimeFile: runtimePath,
        members,
      },
      null,
      2,
    ) + "\n",
  );

  const child = spawn(
    process.execPath,
    [
      join(PKG_ROOT, "hub", "team", "native-supervisor.mjs"),
      "--config",
      configPath,
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
      windowsHide: true,
    },
  );
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(runtimePath)) {
      try {
        const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
        return { runtime, members };
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { runtime: null, members };
}

export async function nativeRequest(state, path, body = {}) {
  if (!state?.native?.controlUrl) return null;
  try {
    const res = await fetch(`${state.native.controlUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

export async function nativeGetStatus(state) {
  if (!state?.native?.controlUrl) return null;
  try {
    const res = await fetch(`${state.native.controlUrl}/status`);
    return await res.json();
  } catch {
    return null;
  }
}

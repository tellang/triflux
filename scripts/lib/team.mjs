import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function teamContext(env) {
  const team = env.TFX_TEAM_NAME || "";
  const taskId = env.TFX_TEAM_TASK_ID || "";
  if (!team || !taskId) return null;
  return {
    team,
    taskId,
    agent: env.TFX_TEAM_AGENT_NAME || "agent",
    lead: env.TFX_TEAM_LEAD_NAME || "team-lead",
  };
}

export async function claimTask({ env = process.env, bridge } = {}) {
  const ctx = teamContext(env);
  if (!ctx) return { skipped: true };
  const response = await bridge.claim({
    team: ctx.team,
    taskId: ctx.taskId,
    owner: ctx.agent,
    status: "in_progress",
  });
  if (response?.ok) return { claimed: true };
  const code = response?.error?.code;
  const before = response?.error?.details?.task_before ?? {};
  if (
    code === "CLAIM_CONFLICT" &&
    before.owner === ctx.agent &&
    before.status === "in_progress"
  ) {
    return { claimed: true, alreadyClaimed: true };
  }
  if (code === "CLAIM_CONFLICT") {
    return { claimed: false, conflict: true, owner: before.owner ?? null };
  }
  return { claimed: false, error: response?.error ?? null };
}

export async function completeTask({
  env = process.env,
  bridge,
  result = "success",
  summary = "작업 완료",
  now = () => new Date().toISOString(),
} = {}) {
  const ctx = teamContext(env);
  if (!ctx) return { skipped: true };
  const trimmed = String(summary).slice(0, 4096);
  const response = await bridge.complete({
    team: ctx.team,
    taskId: ctx.taskId,
    agent: ctx.agent,
    result,
    summary: trimmed,
  });

  const resultDir =
    env.TFX_RESULT_DIR ||
    join(process.env.HOME || ".", ".claude", "tfx-results", ctx.team);
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(
    join(resultDir, `${ctx.taskId}.json`),
    `${JSON.stringify({
      taskId: ctx.taskId,
      agent: ctx.agent,
      team: ctx.team,
      result,
      summary: trimmed,
      timestamp: now(),
    })}\n`,
  );
  return { completed: Boolean(response?.ok), response };
}

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseTeamArgs,
  resolveTeamWorkers,
} from "../../hub/team/cli/commands/start/index.mjs";

describe("multi --assign worker routing", () => {
  const prompt = "Claude Code(Anthropic CLI, 2026-10 기준) 조사";

  it("keeps a comma-containing assign as one worker with the full prompt", () => {
    const parsed = parseTeamArgs([
      "--teammate-mode",
      "in-process",
      "--assign",
      `codex:${prompt}:researcher`,
    ]);
    const workers = resolveTeamWorkers({ ...parsed, task: prompt });

    assert.deepEqual(workers.agents, ["codex"]);
    assert.deepEqual(workers.subtasks, [prompt]);
  });

  it("parses researcher separately from prompt-internal colons", () => {
    const parsed = parseTeamArgs([
      "--teammate-mode",
      "in-process",
      "--assign",
      `codex:범위: ${prompt}:researcher`,
    ]);

    assert.deepEqual(parsed.assigns, [
      { cli: "codex", prompt: `범위: ${prompt}`, role: "researcher" },
    ]);
  });

  it("uses assign order and duplicate CLIs instead of agents or task", () => {
    const parsed = parseTeamArgs([
      "--teammate-mode",
      "in-process",
      "--agents",
      "antigravity,claude",
      "--assign",
      `codex:${prompt}:researcher`,
      "--assign",
      "codex:구현 + 검증, 문서\n정리:executor",
      "다른 작업, 분할 대상",
    ]);

    assert.deepEqual(resolveTeamWorkers(parsed), {
      agents: ["codex", "codex"],
      subtasks: [prompt, "구현 + 검증, 문서\n정리"],
    });
  });

  it("preserves task decomposition when no assigns are provided", () => {
    assert.deepEqual(
      resolveTeamWorkers({
        agents: ["codex", "antigravity"],
        task: "구현, 검증 + 문서",
        assigns: [],
      }),
      {
        agents: ["codex", "antigravity"],
        subtasks: ["구현", "검증 + 문서"],
      },
    );
  });
});
